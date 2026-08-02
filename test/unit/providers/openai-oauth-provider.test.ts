import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIOAuthAuthManager } from "../../../src/providers/openai-oauth/auth";
import { createCodexOAuthFetch } from "../../../src/providers/openai-oauth/provider";

describe("createCodexOAuthFetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes Responses requests for the Codex backend", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const auth = new OpenAIOAuthAuthManager({
      load: async () => '{"access_token":"access","account_id":"account"}',
      save: async () => {},
    });
    const codexFetch = createCodexOAuthFetch({
      auth,
      fetch: async (input, init) => {
        captured = { url: String(input), init: init ?? {} };
        return new Response("event: response.created\ndata: {}\n\n", { status: 200 });
      },
    });
    const request = new Request("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer placeholder",
      },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        input: [],
        max_output_tokens: 100,
      }),
    });

    await codexFetch(request);

    expect(captured?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(new Headers(captured?.init.headers).get("authorization")).toBe("Bearer access");
    expect(new Headers(captured?.init.headers).get("chatgpt-account-id")).toBe("account");
    const body = JSON.parse(String(captured?.init.body));
    expect(body).toMatchObject({
      model: "gpt-5.4-mini",
      stream: true,
      store: false,
    });
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body.instructions).toBeTypeOf("string");
  });

  it("adds Codex CLI direct egress headers and strips forwarded headers when no proxy is configured", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const auth = new OpenAIOAuthAuthManager({
      load: async () => '{"access_token":"access","account_id":"account"}',
      save: async () => {},
    });
    const codexFetch = createCodexOAuthFetch({
      auth,
      fetch: async (input, init) => {
        captured = { url: String(input), init: init ?? {} };
        return new Response("event: response.created\ndata: {}\n\n", { status: 200 });
      },
    });

    await codexFetch(
      new Request("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer placeholder",
          "cf-ray": "incoming-ray",
          "x-forwarded-for": "203.0.113.10",
        },
        body: JSON.stringify({ model: "gpt-5.4-mini", input: [] }),
      }),
    );

    const headers = new Headers(captured?.init.headers);
    expect(headers.get("cf-ray")).toBeNull();
    expect(headers.get("x-forwarded-for")).toBeNull();
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("origin")).toBeNull();
    expect(headers.get("referer")).toBeNull();
    expect(headers.get("originator")).toBe("codex_cli_rs");
    expect(headers.get("user-agent")).toBe("codex_cli_rs/0.0.1");
  });

  it("retries direct Cloudflare HTML 403 responses before returning success", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const auth = new OpenAIOAuthAuthManager({
      load: async () => '{"access_token":"access","account_id":"account"}',
      save: async () => {},
    });
    let attempts = 0;
    const codexFetch = createCodexOAuthFetch({
      auth,
      egressMode: "direct",
      fetch: async () => {
        attempts += 1;
        if (attempts < 3) {
          return new Response("<html>Cloudflare challenge</html>", {
            status: 403,
            statusText: "Forbidden",
            headers: {
              "content-type": "text/html; charset=UTF-8",
              server: "cloudflare",
            },
          });
        }
        return new Response("event: response.created\ndata: {}\n\n", { status: 200 });
      },
      sleep: async () => {},
    });

    const response = await codexFetch(
      new Request("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.4-mini", input: [] }),
      }),
    );

    expect(response.status).toBe(200);
    expect(attempts).toBe(3);
    const retryLogs = consoleSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])) as { event?: string })
      .filter((entry) => entry.event === "codex.fetch_retry");
    expect(retryLogs).toHaveLength(2);
  });

  it("logs sanitized Codex response failures without consuming the response", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const auth = new OpenAIOAuthAuthManager({
      load: async () => '{"access_token":"access","account_id":"account"}',
      save: async () => {},
    });
    const codexFetch = createCodexOAuthFetch({
      auth,
      egressMode: "direct",
      logContext: { threadId: "thread-1", workspaceId: "workspace-1" },
      sleep: async () => {},
      fetch: async () =>
        new Response("blocked by cloudflare", {
          status: 403,
          statusText: "Forbidden",
          headers: {
            "cf-ray": "abc-HKG",
            "cf-mitigated": "challenge",
            "content-type": "text/html",
          },
        }),
    });

    const response = await codexFetch(
      new Request("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.4-mini", input: [] }),
      }),
    );

    expect(await response.text()).toBe("blocked by cloudflare");
    const logged = JSON.parse(String(consoleSpy.mock.calls[0]?.[0]));
    expect(logged).toMatchObject({
      level: "warn",
      event: "codex.fetch_failed_response",
      threadId: "thread-1",
      workspaceId: "workspace-1",
      egressMode: "direct",
      target: "https://chatgpt.com/backend-api/codex/responses",
      status: 403,
      statusText: "Forbidden",
      cfRay: "abc-HKG",
      cfMitigated: "challenge",
      contentType: "text/html",
      bodySnippet: "blocked by cloudflare",
    });
  });

  it("routes through the proxy base and adds the exe.dev token when configured", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const auth = new OpenAIOAuthAuthManager({
      load: async () => '{"access_token":"access","account_id":"account"}',
      save: async () => {},
    });
    const codexFetch = createCodexOAuthFetch({
      auth,
      baseURL: "https://vm.example.com:8088",
      exedevToken: "vm-token",
      fetch: async (input, init) => {
        captured = { url: String(input), init: init ?? {} };
        return new Response("event: response.created\ndata: {}\n\n", { status: 200 });
      },
    });
    const request = new Request("https://vm.example.com:8088/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer placeholder" },
      body: JSON.stringify({ model: "gpt-5.4-mini", input: [] }),
    });

    await codexFetch(request);

    expect(captured?.url).toBe("https://vm.example.com:8088/responses");
    const headers = new Headers(captured?.init.headers);
    // exe.dev proxy gate token added...
    expect(headers.get("x-exedev-authorization")).toBe("Bearer vm-token");
    // ...while the Codex auth headers are still applied for the upstream.
    expect(headers.get("authorization")).toBe("Bearer access");
    expect(headers.get("chatgpt-account-id")).toBe("account");
  });
});
