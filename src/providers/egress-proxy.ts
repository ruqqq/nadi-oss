import {
  providerSupportsProxy,
  type ProviderEndpointConfig,
} from "../db/repositories/provider-configs";
import type { Env } from "../env";
import { isTruthyFlag } from "../flags";

export interface EgressProxy {
  url: string;
  token: string;
}

/**
 * Resolve the clean-egress proxy a provider's inference traffic should take, or
 * undefined for direct egress.
 *
 * Two halves have to line up: the workspace configures the route
 * (`endpointConfig.proxyUrl`), and the deployment holds the VM bearer token
 * (`EGRESS_PROXY_TOKEN`). Either alone means direct — the proxy is gated by that
 * token, so sending without it would only earn a 401.
 *
 * openai-oauth additionally honours CODEX_DIRECT_ENABLED, which exists to
 * measure ChatGPT's Cloudflare block from a Worker on purpose.
 */
export function resolveEgressProxy(
  env: Env,
  provider: string,
  endpointConfig: Pick<ProviderEndpointConfig, "proxyUrl">,
): EgressProxy | undefined {
  if (!providerSupportsProxy(provider)) return undefined;
  if (provider === "openai-oauth" && isTruthyFlag(env.CODEX_DIRECT_ENABLED)) return undefined;
  const url = endpointConfig.proxyUrl;
  const token = env.EGRESS_PROXY_TOKEN;
  if (!url || !token) return undefined;
  return { url, token };
}

/**
 * Headers the Worker must not pass on to an upstream. Cloudflare stamps some of
 * these onto outbound subrequests; forwarding them tells the upstream exactly
 * what the proxy exists to hide.
 */
const EGRESS_STRIPPED_HEADERS = [
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cookie",
  "forwarded",
  "host",
  "true-client-ip",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
];

export function stripEgressHeaders(headers: Headers): void {
  for (const key of EGRESS_STRIPPED_HEADERS) headers.delete(key);
}

/**
 * exe.dev's VM-token proxy sits in front of the egress proxy: it validates this
 * header and strips it before the request reaches the VM.
 */
export function applyProxyGateHeader(headers: Headers, token: string): void {
  headers.set("X-Exedev-Authorization", `Bearer ${token}`);
}
