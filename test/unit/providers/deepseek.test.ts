import { describe, expect, it, vi } from "vitest";
import {
  convertDeepSeekUsage,
  transformDeepSeekRequestBody,
} from "../../../src/providers/deepseek";
import { createOpenAICompatibleModel } from "../../../src/providers/openai-compatible";

// Every assertion below reads the JSON that actually goes on the wire. Asserting
// on our own helpers' return values would pass even if the model never received
// the field — which is exactly the failure being fixed here.
type Callable = {
  doGenerate: (options: {
    prompt: unknown;
    providerOptions?: Record<string, Record<string, unknown>>;
  }) => Promise<{ content: unknown[]; usage: unknown }>;
};

const jsonFetch = (payload: unknown) =>
  vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json(payload));

const okResponse = (extra: Record<string, unknown> = {}) => ({
  id: "c1",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
  usage: { prompt_tokens: 10, completion_tokens: 4 },
  ...extra,
});

function deepseekModel(fetchImpl: unknown, model = "deepseek-v4-flash-vision-exp") {
  return createOpenAICompatibleModel({
    provider: "deepseek",
    model,
    apiKey: "sk",
    endpointConfig: { baseUrl: "https://api.deepseek.com", proxyUrl: "", auth: "bearer", body: {} },
    fetch: fetchImpl as typeof fetch,
  }) as unknown as Callable;
}

const bodyOf = (fetchImpl: { mock: { calls: unknown[][] } }) => {
  const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
  if (!init) throw new Error("no request was made");
  return JSON.parse(init.body as string) as Record<string, unknown>;
};

describe("deepseek provider", () => {
  it("sends an image file part as image_url", async () => {
    const fetchImpl = jsonFetch(okResponse());
    await deepseekModel(fetchImpl).doGenerate({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "Can you answer the riddles?" },
            {
              type: "file",
              mediaType: "image/jpeg",
              data: new Uint8Array([1, 2, 3]),
              filename: "IMG_5707.jpeg",
            },
          ],
        },
      ],
    });

    const messages = bodyOf(fetchImpl).messages as Array<{ content: unknown }>;
    // @ai-sdk/deepseek flattened this to the string "Can you answer the riddles?"
    // and reported the image as an unsupported-part warning.
    expect(messages[0]?.content).toContainEqual({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,AQID" },
    });
  });

  // Guards the wire contract, not our transform: the generic adapter does this
  // rename itself, and a future adapter change that stopped would silently kill
  // thinking effort the way the vendor adapter killed images.
  it("sends the effort as DeepSeek's reasoning_effort", async () => {
    const fetchImpl = jsonFetch(okResponse());
    await deepseekModel(fetchImpl).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      // The shape reasoning-options.ts writes for this provider.
      providerOptions: { deepseek: { reasoningEffort: "high", thinking: { type: "enabled" } } },
    });

    const body = bodyOf(fetchImpl);
    expect(body.reasoning_effort).toBe("high");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body).not.toHaveProperty("reasoningEffort");
  });

  it("drops the effort when thinking is explicitly disabled", async () => {
    const fetchImpl = jsonFetch(okResponse());
    await deepseekModel(fetchImpl).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      providerOptions: { deepseek: { reasoningEffort: "high", thinking: { type: "disabled" } } },
    });

    const body = bodyOf(fetchImpl);
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("counts DeepSeek's prompt_cache_hit_tokens as cache reads", async () => {
    const fetchImpl = jsonFetch(
      okResponse({
        usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 60 },
      }),
    );
    const result = await deepseekModel(fetchImpl).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    // Reading only prompt_tokens_details.cached_tokens would bill every turn as
    // a full-price miss.
    expect((result.usage as { inputTokens: unknown }).inputTokens).toMatchObject({
      total: 100,
      cacheRead: 60,
      noCache: 40,
    });
  });
});

describe("transformDeepSeekRequestBody", () => {
  it("stamps empty reasoning_content on V4 assistant messages", () => {
    const body = transformDeepSeekRequestBody({
      model: "deepseek-v4-flash-vision-exp",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "assistant", content: "thought", reasoning_content: "kept" },
      ],
    });

    expect(body.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello", reasoning_content: "" },
      { role: "assistant", content: "thought", reasoning_content: "kept" },
    ]);
  });

  it("leaves non-V4 assistant messages alone", () => {
    const body = transformDeepSeekRequestBody({
      model: "deepseek-chat",
      messages: [{ role: "assistant", content: "hello" }],
    });

    expect(body.messages).toEqual([{ role: "assistant", content: "hello" }]);
  });
});

describe("convertDeepSeekUsage", () => {
  it("falls back to the OpenAI-shaped cached_tokens field", () => {
    const usage = convertDeepSeekUsage({
      prompt_tokens: 30,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 12 },
      completion_tokens_details: { reasoning_tokens: 2 },
    });

    expect(usage.inputTokens).toMatchObject({ total: 30, cacheRead: 12, noCache: 18 });
    expect(usage.outputTokens).toMatchObject({ total: 5, text: 3, reasoning: 2 });
  });

  it("survives a response with no usage at all", () => {
    expect(convertDeepSeekUsage(null).inputTokens).toMatchObject({ total: 0, cacheRead: 0 });
  });
});
