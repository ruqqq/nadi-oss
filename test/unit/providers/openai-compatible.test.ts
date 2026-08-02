import { describe, expect, it, vi } from "vitest";
import {
  createOpenAICompatibleFetch,
  createOpenAICompatibleModel,
} from "../../../src/providers/openai-compatible";

describe("createOpenAICompatibleFetch", () => {
  it("merges allowlisted body defaults into chat completion requests", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      Response.json({ ok: true, body: init?.body }),
    );
    const wrapped = createOpenAICompatibleFetch({
      fetch: fetchImpl as typeof fetch,
      auth: "bearer",
      bodyDefaults: {
        reasoning_effort: "high",
        enable_thinking: true,
        ignored: "drop-me",
      },
    });

    await wrapped("https://api.example.com/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });

    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      model: "m",
      reasoning_effort: "high",
      enable_thinking: true,
    });
    expect(body).not.toHaveProperty("ignored");
  });

  it("strips Authorization for no-auth endpoints", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const wrapped = createOpenAICompatibleFetch({
      fetch: fetchImpl as typeof fetch,
      auth: "none",
      bodyDefaults: {},
    });

    await wrapped("http://localhost:11434/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer placeholder" },
      body: "{}",
    });

    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.has("authorization")).toBe(false);
  });
});

describe("createOpenAICompatibleModel", () => {
  it("creates a chat-completions OpenAI-compatible language model", () => {
    const model = createOpenAICompatibleModel({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      apiKey: "sk",
      endpointConfig: {
        baseUrl: "https://api.deepseek.com",
        proxyUrl: "",
        auth: "bearer",
        body: {},
      },
    });

    expect((model as { provider: string }).provider).toBe("deepseek.chat");
  });

  // The provider id above is identical under @ai-sdk/openai and
  // @ai-sdk/openai-compatible, so it cannot detect which adapter is in use.
  // These two can: both describe behaviour @ai-sdk/openai does not have.

  // `LanguageModel` is a union that includes a bare model-id string, so the
  // spec methods aren't reachable on it without narrowing.
  type Callable = {
    doGenerate: (options: {
      prompt: unknown;
      providerOptions?: Record<string, Record<string, unknown>>;
    }) => Promise<{ content: unknown[] }>;
  };
  const callable = (model: unknown) => model as unknown as Callable;
  const jsonFetch = (payload: unknown) =>
    vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json(payload));

  it.each(["deepseek", "zai", "qwen", "opencode-zen", "openai-compatible"])(
    "maps reasoning_content into a reasoning part (%s)",
    async (provider) => {
      const fetchImpl = jsonFetch({
        id: "c1",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Done.",
              reasoning_content: "Considering the request",
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      });
      const model = createOpenAICompatibleModel({
        provider,
        model: "m",
        apiKey: "sk",
        endpointConfig: {
          baseUrl: "https://api.example.com",
          proxyUrl: "",
          auth: "bearer",
          body: {},
        },
        fetch: fetchImpl as unknown as typeof fetch,
      });

      const result = await callable(model).doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });

      // @ai-sdk/openai drops this field entirely, so every one of these
      // providers rendered no thinking at all before the adapter swap.
      expect(result.content).toContainEqual({
        type: "reasoning",
        text: "Considering the request",
      });
    },
  );

  it("passes provider-named options straight through to the request body", async () => {
    const fetchImpl = jsonFetch({
      id: "c1",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const model = createOpenAICompatibleModel({
      provider: "qwen",
      model: "m",
      apiKey: "sk",
      // An admin body default the per-turn option must be able to override.
      endpointConfig: {
        baseUrl: "https://api.example.com",
        proxyUrl: "",
        auth: "bearer",
        body: { enable_thinking: false },
      },
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await callable(model).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      // Keyed by the PROVIDER's own name — @ai-sdk/openai reads only "openai"
      // here, so this would be silently dropped before the swap.
      providerOptions: { qwen: { enable_thinking: true, thinking_budget: 16000 } },
    });

    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(body.thinking_budget).toBe(16000);
    expect(body.enable_thinking).toBe(true);
  });

  it("routes through the egress proxy and gates it with the VM token", async () => {
    const fetchImpl = jsonFetch({
      id: "c1",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const model = createOpenAICompatibleModel({
      provider: "opencode-zen",
      model: "m",
      apiKey: "sk",
      endpointConfig: {
        baseUrl: "https://opencode.ai/zen/v1",
        proxyUrl: "https://proxy.example.com/opencode-zen",
        auth: "bearer",
        body: {},
      },
      fetch: fetchImpl as unknown as typeof fetch,
      proxy: { url: "https://proxy.example.com/opencode-zen", token: "vm-token" },
    });

    await callable(model).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://proxy.example.com/opencode-zen/chat/completions");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-exedev-authorization")).toBe("Bearer vm-token");
    // The provider credential still travels — the proxy holds none of its own.
    expect(headers.get("authorization")).toBe("Bearer sk");
  });

  it("goes direct and sends no VM token when no proxy is configured", async () => {
    const fetchImpl = jsonFetch({
      id: "c1",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const model = createOpenAICompatibleModel({
      provider: "opencode-zen",
      model: "m",
      apiKey: "sk",
      endpointConfig: {
        baseUrl: "https://opencode.ai/zen/v1",
        proxyUrl: "",
        auth: "bearer",
        body: {},
      },
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await callable(model).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(new Headers(init?.headers).has("x-exedev-authorization")).toBe(false);
  });
});
