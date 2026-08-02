import { describe, expect, it, vi } from "vitest";
import { verifyProviderKey } from "../../../src/providers/verify-key";

function okFetch(status: number) {
  return vi.fn<typeof fetch>(async () => new Response(null, { status }));
}

describe("verifyProviderKey", () => {
  it("verifies OpenAI-compatible bearer endpoints against /models", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ data: [] }));

    await expect(
      verifyProviderKey("deepseek", "sk-deepseek", fetchImpl as typeof fetch, {
        baseUrl: "https://api.deepseek.com",
        proxyUrl: "",
        auth: "bearer",
        body: {},
      }),
    ).resolves.toEqual({ reason: "valid" });

    expect(fetchImpl).toHaveBeenCalledWith("https://api.deepseek.com/models", {
      method: "GET",
      headers: { Authorization: "Bearer sk-deepseek" },
    });
  });

  it("treats 401 from OpenAI-compatible endpoints as invalid", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 401 }));

    await expect(
      verifyProviderKey("qwen", "bad-key", fetchImpl as typeof fetch, {
        baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
        proxyUrl: "",
        auth: "bearer",
        body: {},
      }),
    ).resolves.toEqual({ reason: "invalid" });
  });

  it("checks no-auth custom endpoint reachability without Authorization", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ data: [] }));

    await expect(
      verifyProviderKey("openai-compatible", "", fetchImpl as typeof fetch, {
        baseUrl: "http://localhost:11434/v1",
        proxyUrl: "",
        auth: "none",
        body: {},
      }),
    ).resolves.toEqual({ reason: "valid" });

    expect(fetchImpl).toHaveBeenCalledWith("http://localhost:11434/v1/models", {
      method: "GET",
      headers: {},
    });
  });

  it("does not fetch unsafe OpenAI-compatible verification endpoints", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ data: [] }));

    await expect(
      verifyProviderKey("openai-compatible", "secret", fetchImpl as typeof fetch, {
        baseUrl: "http://example.com/v1",
        proxyUrl: "",
        auth: "bearer",
        body: {},
      }),
    ).resolves.toEqual({ reason: "unreachable" });
    await expect(
      verifyProviderKey("qwen", "secret", fetchImpl as typeof fetch, {
        baseUrl: "javascript:alert(1)",
        proxyUrl: "",
        auth: "bearer",
        body: {},
      }),
    ).resolves.toEqual({ reason: "unreachable" });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns valid when OpenAI responds 200, calling the models endpoint with a Bearer token", async () => {
    const fetchImpl = okFetch(200);
    const result = await verifyProviderKey("openai", "sk-test", fetchImpl);
    expect(result.reason).toBe("valid");
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe("https://api.openai.com/v1/models");
    expect(call[1]?.headers).toMatchObject({ Authorization: "Bearer sk-test" });
  });

  it("returns invalid when the provider rejects the key with 401", async () => {
    expect((await verifyProviderKey("openai", "bad", okFetch(401))).reason).toBe("invalid");
  });

  it("returns invalid on 403 as well", async () => {
    expect((await verifyProviderKey("openai", "bad", okFetch(403))).reason).toBe("invalid");
  });

  it("verifies Anthropic with the x-api-key and version headers", async () => {
    const fetchImpl = okFetch(200);
    const result = await verifyProviderKey("anthropic", "sk-ant-test", fetchImpl);
    expect(result.reason).toBe("valid");
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe("https://api.anthropic.com/v1/models");
    const headers = call[1]?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBeTruthy();
  });

  it("verifies OpenRouter against the key endpoint with a Bearer token", async () => {
    const fetchImpl = okFetch(200);
    const result = await verifyProviderKey("openrouter", "sk-or-test", fetchImpl);
    expect(result.reason).toBe("valid");
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe("https://openrouter.ai/api/v1/key");
    expect(call[1]?.headers).toMatchObject({ Authorization: "Bearer sk-or-test" });
  });

  it("returns unreachable on a 5xx so a provider outage does not read as an invalid key", async () => {
    expect((await verifyProviderKey("openai", "sk", okFetch(503))).reason).toBe("unreachable");
  });

  it("returns unreachable when the request throws (network error)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("network down");
    });
    expect((await verifyProviderKey("openai", "sk", fetchImpl)).reason).toBe("unreachable");
  });

  it("returns unreachable for a provider it cannot verify (e.g. openai-oauth)", async () => {
    const fetchImpl = okFetch(200);
    expect((await verifyProviderKey("openai-oauth", "x", fetchImpl)).reason).toBe("unreachable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
