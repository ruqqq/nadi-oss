import type { DurableObjectOAuthClientProvider } from "agents";

/**
 * The MCP SDK's OAuth value types (`OAuthTokens`, `OAuthClientInformation(Full)`)
 * live in `@modelcontextprotocol/sdk/shared/auth.js`. That package is a
 * transitive dependency of `agents` and is NOT hoisted to the top-level
 * node_modules under pnpm, so the spike2-findings' direct import path
 * (`@modelcontextprotocol/sdk/shared/auth.js`) does not resolve from this
 * project without adding a new direct dependency.
 *
 * To avoid adding a dependency (and the `wrangler types` / worker-configuration
 * churn that a `pnpm install` triggers), we derive the exact same types through
 * the `agents`-exported DurableObjectOAuthClientProvider's method signatures.
 * These are structurally identical to the SDK types and guarantee override
 * compatibility for KvMcpOAuthProvider.
 */
export type OAuthTokens = NonNullable<
  Awaited<ReturnType<DurableObjectOAuthClientProvider["tokens"]>>
>;

export type OAuthClientInformation = NonNullable<
  Awaited<ReturnType<DurableObjectOAuthClientProvider["clientInformation"]>>
>;

export type OAuthClientInformationFull = Parameters<
  DurableObjectOAuthClientProvider["saveClientInformation"]
>[0];
