import { describe, expect, it, vi } from "vitest";
import { GithubAppClient, GithubInstallationGoneError } from "../../../src/github/app-client";

const config = {
  appId: "1",
  // a valid PKCS#8 key is generated in jwt.test; here we stub createAppJwt via a real key is overkill —
  // use a fetch mock and a private key that importPkcs8 accepts. Generate one inline:
  privateKeyPkcs8Pem: "",
  clientId: "cid",
  clientSecret: "csecret",
  slug: "nadi",
};

async function withKey() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return {
    ...config,
    privateKeyPkcs8Pem: `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GithubAppClient", () => {
  it("mints a scoped installation token with a Bearer JWT and the right body", async () => {
    const cfg = await withKey();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ token: "ghs_x", expires_at: "2026-01-01T00:00:00Z" }));
    const client = new GithubAppClient({ config: cfg, fetchImpl, nowMs: () => 1_700_000_000_000 });
    const out = await client.mintInstallationToken(42, {
      repositories: ["api"],
      permissions: { contents: "write", metadata: "read" },
    });
    expect(out).toEqual({ token: "ghs_x", expiresAt: "2026-01-01T00:00:00Z" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/app/installations/42/access_tokens");
    expect(init.method).toBe("POST");
    expect(String(init.headers.Authorization)).toMatch(/^Bearer .+\..+\..+$/);
    expect(init.headers.Accept).toBe("application/vnd.github+json");
    expect(JSON.parse(init.body)).toEqual({
      repositories: ["api"],
      permissions: { contents: "write", metadata: "read" },
    });
  });

  it("throws GithubInstallationGoneError on 404", async () => {
    const cfg = await withKey();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: "Not Found" }, 404));
    const client = new GithubAppClient({ config: cfg, fetchImpl, nowMs: () => 1 });
    await expect(
      client.mintInstallationToken(42, { repositories: [], permissions: {} }),
    ).rejects.toBeInstanceOf(GithubInstallationGoneError);
  });

  it("exchanges an oauth code for an access token", async () => {
    const cfg = await withKey();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ access_token: "gho_user" }));
    const client = new GithubAppClient({ config: cfg, fetchImpl, nowMs: () => 1 });
    expect(await client.exchangeOAuthCode("code123")).toEqual({ accessToken: "gho_user" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(JSON.parse(init.body)).toEqual({
      client_id: "cid",
      client_secret: "csecret",
      code: "code123",
    });
  });

  it("reads the installation account + selection", async () => {
    const cfg = await withKey();
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        account: { login: "acme", type: "Organization" },
        repository_selection: "selected",
      }),
    );
    const client = new GithubAppClient({ config: cfg, fetchImpl, nowMs: () => 1 });
    expect(await client.getInstallation(42)).toEqual({
      accountLogin: "acme",
      accountType: "org",
      repositorySelection: "selected",
    });
  });

  it("calls fetchImpl as a detached function (no Illegal invocation under Workers fetch)", async () => {
    const cfg = await withKey();
    const nativeLike = function (this: unknown): Promise<Response> {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
      }
      return Promise.resolve(jsonResponse({ token: "ghs_x", expires_at: "2026-01-01T00:00:00Z" }));
    } as unknown as typeof fetch;
    const client = new GithubAppClient({ config: cfg, fetchImpl: nativeLike, nowMs: () => 1 });
    await expect(
      client.mintInstallationToken(42, {
        repositories: ["api"],
        permissions: { contents: "write", metadata: "read" },
      }),
    ).resolves.toEqual({ token: "ghs_x", expiresAt: "2026-01-01T00:00:00Z" });
  });
});
