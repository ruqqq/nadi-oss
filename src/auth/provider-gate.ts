import { isEmailAllowed } from "./email-whitelist";

export interface ProviderGateEnv {
  WORKERS_AI_EMAILS?: string;
  /**
   * Workers AI runs on this binding. It is absent on any non-Cloudflare
   * platform (celld has no equivalent), and the provider cannot work without
   * it — see `PROVIDER_REQUIRED_BINDINGS`.
   */
  AI?: unknown;
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
 * Bindings a provider cannot run without, checked before any allowlist.
 *
 * Workers AI authenticates through the `AI` binding rather than an API key, so
 * on a platform without one — celld has no equivalent — the provider can never
 * work. Offering it there advertises a capability on the strength of
 * configuration rather than of the thing that fulfils it: the account passes the
 * allowlist, the picker lists it, and the first message fails with
 * `workers_ai_binding_required` from the model factory.
 */
const PROVIDER_REQUIRED_BINDINGS = {
  "workers-ai": "AI",
} as const satisfies Partial<Record<GatedProvider, keyof ProviderGateEnv>>;

/**
 * Whether an account may use a chat provider. Ungated providers are always
 * allowed; a gated one must have its binding present (where it needs one) and
 * then passes its allowlist.
 *
 * Parsing is shared with the sign-in gate: comma-separated exact emails and/or
 * bare domains, case-insensitive. An empty/unset list disables that provider's
 * gate (everyone allowed), which doubles as the kill-switch to open it up.
 *
 * The binding check is deliberately NOT part of that kill-switch: clearing the
 * allowlist opens a provider to every account, but it cannot conjure a binding,
 * so a missing one still denies.
 */
/**
 * Whether a gated provider's required binding is missing on this deployment.
 *
 * Callers that raise an error use this to say *why* — "not allowed" sends an
 * operator hunting the allowlist when the real cause is a binding that never
 * arrived. UI-facing callers just want the boolean from `canUseProvider`.
 */
export function providerBindingMissing(env: ProviderGateEnv, provider: string): boolean {
  if (!isGatedProvider(provider)) return false;
  const requiredBinding = PROVIDER_REQUIRED_BINDINGS[provider];
  return Boolean(requiredBinding) && !env[requiredBinding!];
}

export function canUseProvider(
  env: ProviderGateEnv,
  provider: string,
  email: string | null | undefined,
): boolean {
  if (!isGatedProvider(provider)) return true;

  const requiredBinding = PROVIDER_REQUIRED_BINDINGS[provider];
  if (requiredBinding && !env[requiredBinding]) return false;

  // Delegate the empty-list case rather than short-circuiting on a missing email:
  // isEmailAllowed("") is true only when the list is empty, which keeps "clear the
  // var to open it up" true even on paths that have no email to hand (an owner
  // row without a user, an internal call). With a non-empty list, an absent email
  // matches nothing and is denied.
  return isEmailAllowed(email ?? "", env[GATED_PROVIDER_ALLOWLISTS[provider]]);
}
