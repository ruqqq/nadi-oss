import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearMcpOAuthCredentials,
  getMcpOAuthClient,
  getMcpOAuthTokens,
  hasMcpOAuthTokens,
  mcpOAuthClientSecretName,
  mcpOAuthTokenSecretName,
  putMcpOAuthClient,
  putMcpOAuthTokens,
} from "../../src/mcp/oauth-store";

const WS = "ws-oauth-store-1";
const SERVER = "sabc123";

async function clearKv() {
  const list = await env.SECRETS_KV.list({ prefix: `workspaces/${WS}/` });
  for (const k of list.keys) await env.SECRETS_KV.delete(k.name);
}

describe("mcp oauth credential store", () => {
  beforeEach(clearKv);

  it("builds the documented secret names", () => {
    expect(mcpOAuthTokenSecretName(SERVER)).toBe(`mcp-oauth:${SERVER}:token`);
    expect(mcpOAuthClientSecretName(SERVER)).toBe(`mcp-oauth:${SERVER}:client`);
  });

  it("round-trips OAuth tokens through the encrypted KV store", async () => {
    expect(await hasMcpOAuthTokens(env, WS, SERVER)).toBe(false);
    expect(await getMcpOAuthTokens(env, WS, SERVER)).toBeUndefined();

    const tokens = { access_token: "at-1", token_type: "bearer", refresh_token: "rt-1" };
    await putMcpOAuthTokens(env, WS, SERVER, tokens);

    expect(await hasMcpOAuthTokens(env, WS, SERVER)).toBe(true);
    expect(await getMcpOAuthTokens(env, WS, SERVER)).toEqual(tokens);
  });

  it("stores the token encrypted at the documented KV key (not plaintext)", async () => {
    await putMcpOAuthTokens(env, WS, SERVER, { access_token: "secret-at", token_type: "bearer" });
    const raw = await env.SECRETS_KV.get(`workspaces/${WS}/secrets/mcp-oauth:${SERVER}:token`);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain("secret-at"); // ciphertext, not plaintext
  });

  it("round-trips the client registration", async () => {
    const client = { client_id: "cid-1", client_secret: "csecret" };
    await putMcpOAuthClient(env, WS, SERVER, client);
    expect(await getMcpOAuthClient(env, WS, SERVER)).toEqual(client);
  });

  it("clearMcpOAuthCredentials removes both token and client secrets", async () => {
    await putMcpOAuthTokens(env, WS, SERVER, { access_token: "at", token_type: "bearer" });
    await putMcpOAuthClient(env, WS, SERVER, { client_id: "c" });
    await clearMcpOAuthCredentials(env, WS, SERVER);
    expect(await getMcpOAuthTokens(env, WS, SERVER)).toBeUndefined();
    expect(await getMcpOAuthClient(env, WS, SERVER)).toBeUndefined();
    expect(await hasMcpOAuthTokens(env, WS, SERVER)).toBe(false);
  });

  it("clearMcpOAuthCredentials is safe when nothing is stored", async () => {
    await expect(clearMcpOAuthCredentials(env, WS, "never-stored")).resolves.toBeUndefined();
  });
});
