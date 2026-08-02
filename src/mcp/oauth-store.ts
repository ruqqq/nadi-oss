import type { Env } from "../env";
import { createWorkspaceSecretsServices } from "../secrets";
import type { OAuthClientInformation, OAuthTokens } from "./oauth-types";

/**
 * Central, encrypted KV storage for per-(workspace, server) MCP OAuth
 * credentials. Tokens and client registrations are mirrored here from the
 * Agents SDK's DurableObjectOAuthClientProvider so every chat ThreadAgent can
 * reuse a single workspace consent (see KvMcpOAuthProvider).
 *
 * Storage reuses the existing workspace DEK+KEK secret store — no bespoke
 * crypto. Secret names resolve under
 * `workspaces/<workspaceId>/secrets/mcp-oauth:<serverId>:token` (and `:client`).
 * `<serverId>` is always the D1 `mcp_servers.id` (normalizeServerId-safe).
 */

export function mcpOAuthTokenSecretName(serverId: string): string {
  return `mcp-oauth:${serverId}:token`;
}

export function mcpOAuthClientSecretName(serverId: string): string {
  return `mcp-oauth:${serverId}:client`;
}

export async function putMcpOAuthTokens(
  env: Env,
  workspaceId: string,
  serverId: string,
  tokens: OAuthTokens,
): Promise<void> {
  const { writer } = createWorkspaceSecretsServices(env);
  await writer.ensureWorkspaceDek(workspaceId);
  await writer.set(workspaceId, mcpOAuthTokenSecretName(serverId), JSON.stringify(tokens));
}

export async function getMcpOAuthTokens(
  env: Env,
  workspaceId: string,
  serverId: string,
): Promise<OAuthTokens | undefined> {
  const { store } = createWorkspaceSecretsServices(env);
  const json = await store.get(workspaceId, mcpOAuthTokenSecretName(serverId));
  return json ? (JSON.parse(json) as OAuthTokens) : undefined;
}

export async function hasMcpOAuthTokens(
  env: Env,
  workspaceId: string,
  serverId: string,
): Promise<boolean> {
  return (await getMcpOAuthTokens(env, workspaceId, serverId)) !== undefined;
}

export async function putMcpOAuthClient(
  env: Env,
  workspaceId: string,
  serverId: string,
  client: OAuthClientInformation,
): Promise<void> {
  const { writer } = createWorkspaceSecretsServices(env);
  await writer.ensureWorkspaceDek(workspaceId);
  await writer.set(workspaceId, mcpOAuthClientSecretName(serverId), JSON.stringify(client));
}

export async function getMcpOAuthClient(
  env: Env,
  workspaceId: string,
  serverId: string,
): Promise<OAuthClientInformation | undefined> {
  const { store } = createWorkspaceSecretsServices(env);
  const json = await store.get(workspaceId, mcpOAuthClientSecretName(serverId));
  return json ? (JSON.parse(json) as OAuthClientInformation) : undefined;
}

/**
 * Remove BOTH the token and client-registration secrets for a server. Safe to
 * call when nothing is stored (the writer's delete is a no-op for a missing
 * key). Called on MCP server deletion.
 */
export async function clearMcpOAuthCredentials(
  env: Env,
  workspaceId: string,
  serverId: string,
): Promise<void> {
  const { writer } = createWorkspaceSecretsServices(env);
  await writer.delete(workspaceId, mcpOAuthTokenSecretName(serverId));
  await writer.delete(workspaceId, mcpOAuthClientSecretName(serverId));
}
