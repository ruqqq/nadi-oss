/**
 * listInstallationRepositories mints an installation token, then GETs
 * /installation/repositories, paginating via the Link header.
 *
 * Regression: the fetchImpl illegal-invocation bug class (see app-client.ts
 * doFetch comment, and test/unit/providers/model-search-this-binding.test.ts).
 * Workers' native fetch throws "Illegal invocation" if called as a METHOD
 * (`this.fetchImpl(...)`). This asserts the call style directly: the injected
 * impl must observe `this === undefined`, proving the detached `doFetch` path
 * is used, not a method call.
 */
import { describe, expect, it, vi } from "vitest";
import { GithubAppClient } from "../../../src/github/app-client";

const config = {
  appId: "1",
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

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function tokenResponse(): Response {
  return jsonResponse({ token: "ghs_x", expires_at: "2026-01-01T00:00:00Z" });
}

function reposPage(): unknown {
  return {
    total_count: 2,
    repositories: [
      {
        id: 1,
        name: "api",
        full_name: "acme/api",
        owner: { login: "acme" },
        default_branch: "main",
        clone_url: "https://github.com/acme/api.git",
        private: true,
      },
      {
        id: 2,
        name: "web",
        full_name: "acme/web",
        owner: { login: "acme" },
        default_branch: "trunk",
        clone_url: "https://github.com/acme/web.git",
        private: false,
      },
    ],
  };
}

describe("listInstallationRepositories", () => {
  it("maps a page with a next Link header to hasNextPage=true", async () => {
    const cfg = await withKey();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse(reposPage(), 200, {
          Link: '<https://api.github.com/installation/repositories?page=2>; rel="next", <https://api.github.com/installation/repositories?page=3>; rel="last"',
        }),
      );
    const client = new GithubAppClient({ config: cfg, fetchImpl, nowMs: () => 1 });

    const result = await client.listInstallationRepositories(42);

    expect(result.hasNextPage).toBe(true);
    expect(result.repositories).toEqual([
      {
        id: 1,
        fullName: "acme/api",
        owner: "acme",
        name: "api",
        defaultBranch: "main",
        cloneUrl: "https://github.com/acme/api.git",
        private: true,
      },
      {
        id: 2,
        fullName: "acme/web",
        owner: "acme",
        name: "web",
        defaultBranch: "trunk",
        cloneUrl: "https://github.com/acme/web.git",
        private: false,
      },
    ]);

    const [url] = fetchImpl.mock.calls[1]!;
    expect(url).toBe("https://api.github.com/installation/repositories?per_page=100&page=1");
  });

  it("maps a page with no next rel to hasNextPage=false", async () => {
    const cfg = await withKey();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse(reposPage(), 200, {
          Link: '<https://api.github.com/installation/repositories?page=1>; rel="prev"',
        }),
      );
    const client = new GithubAppClient({ config: cfg, fetchImpl, nowMs: () => 1 });

    const result = await client.listInstallationRepositories(42, { page: 2 });

    expect(result.hasNextPage).toBe(false);
    const [url] = fetchImpl.mock.calls[1]!;
    expect(url).toBe("https://api.github.com/installation/repositories?per_page=100&page=2");
  });

  it("calls fetchImpl as a detached function, never as a method (this === undefined)", async () => {
    const cfg = await withKey();
    const seen: unknown[] = [];
    let call = 0;
    // A non-arrow function so `this` is observable at the call site.
    const fetchImpl = function (this: unknown): Promise<Response> {
      seen.push(this);
      call += 1;
      if (call === 1) return Promise.resolve(tokenResponse());
      return Promise.resolve(jsonResponse(reposPage(), 200, {}));
    } as unknown as typeof fetch;

    const client = new GithubAppClient({ config: cfg, fetchImpl, nowMs: () => 1 });
    await client.listInstallationRepositories(42);

    expect(seen).toHaveLength(2);
    // A method call (`this.fetchImpl(...)`) would hand us the client instance
    // here. Native Workers fetch would throw "Illegal invocation" instead.
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBeUndefined();
  });
});
