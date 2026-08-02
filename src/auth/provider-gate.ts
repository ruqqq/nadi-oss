import { isEmailAllowed } from "./email-whitelist";

export interface ProviderGateEnv {
  WORKERS_AI_EMAILS?: string;
}

/**
 * Chat providers offered only to an allowlist, and the env var holding each list.
 *
 * Workers AI is gated because it needs no API key and bills our own Cloudflare
 * account. OpenAI OAuth is ungated: each workspace brings its own ChatGPT tokens
 * and configures its own clean-egress proxy endpoint.
 *
 * Adding a provider to this map is the whole change — the settings listing, the
 * HTTP routes, and model construction all ask `canUseProvider`, so the policy
 * only ever moves in one place.
 */
const GATED_PROVIDER_ALLOWLISTS = {
  "workers-ai": "WORKERS_AI_EMAILS",
} as const satisfies Record<string, keyof ProviderGateEnv>;

export type GatedProvider = keyof typeof GATED_PROVIDER_ALLOWLISTS;

export function isGatedProvider(provider: string): provider is GatedProvider {
  return Object.hasOwn(GATED_PROVIDER_ALLOWLISTS, provider);
}

/**
 * Whether an account may use a chat provider. Ungated providers are always
 * allowed; a gated one is checked against its allowlist.
 *
 * Parsing is shared with the sign-in gate: comma-separated exact emails and/or
 * bare domains, case-insensitive. An empty/unset list disables that provider's
 * gate (everyone allowed), which doubles as the kill-switch to open it up.
 */
export function canUseProvider(
  env: ProviderGateEnv,
  provider: string,
  email: string | null | undefined,
): boolean {
  if (!isGatedProvider(provider)) return true;

  // Delegate the empty-list case rather than short-circuiting on a missing email:
  // isEmailAllowed("") is true only when the list is empty, which keeps "clear the
  // var to open it up" true even on paths that have no email to hand (an owner
  // row without a user, an internal call). With a non-empty list, an absent email
  // matches nothing and is denied.
  return isEmailAllowed(email ?? "", env[GATED_PROVIDER_ALLOWLISTS[provider]]);
}
