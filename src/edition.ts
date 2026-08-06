/**
 * Which edition of Nadi this Worker is running as. Nadi ships two ways: an
 * open-source instance an operator deploys and configures themselves, and the
 * hosted cloud service where an operator provisions compute once for every
 * tenant. Surfaces that only an operator can act on belong in the former.
 *
 * `NADI_EDITION` is unset everywhere except the cloud deploy, so an absent or
 * unrecognized value resolves to `self-hosted`. That is the safe fall: a
 * misconfigured cloud deploy shows an operator-only surface — visible and
 * harmless — whereas defaulting to `cloud` would silently hide deployment
 * config from the self-hosters who are the only ones able to fix it, with no
 * signal that anything was hidden.
 */
export type NadiEdition = "self-hosted" | "cloud";

/** Accepts an explicit `undefined` as well as an absent key: under
 *  `exactOptionalPropertyTypes` those are distinct types, and an unset wrangler
 *  var reaches this as the former. */
export function resolveEdition(env: { NADI_EDITION?: string | undefined }): NadiEdition {
  return env.NADI_EDITION?.trim().toLowerCase() === "cloud" ? "cloud" : "self-hosted";
}

/**
 * Which platform this Worker runs on. Nadi ships on Cloudflare Workers — where
 * D1, KV, R2, AI and friends are account-managed bindings — and on celld, a
 * single-node local-first runtime that replaces those managed bindings with
 * Durable-Object-backed facades served over the same interfaces.
 *
 * `NADI_PLATFORM` is unset on Cloudflare, so an absent or unrecognized value
 * resolves to `cloudflare`. That is the safe fall: an unset var must never
 * disable a path Cloudflare actually has, and a typo in a celld deploy must
 * degrade toward the platform whose behavior is the compatibility target
 * rather than silently dropping managed bindings.
 */
export type NadiPlatform = "cloudflare" | "celld";

/** Accepts an explicit `undefined` as well as an absent key: under
 *  `exactOptionalPropertyTypes` those are distinct types, and an unset wrangler
 *  var reaches this as the former. */
export function resolvePlatform(env: { NADI_PLATFORM?: string | undefined }): NadiPlatform {
  return env.NADI_PLATFORM?.trim().toLowerCase() === "celld" ? "celld" : "cloudflare";
}

/**
 * What the platform provides, named by capability rather than by platform
 * string, mirroring `EditionCapabilities`. Callers branch on the capability so
 * each divergence gets its own honest name and one place to flip instead of
 * re-deriving what "celld" means at every call site. Add capabilities as later
 * slices need them; nothing goes in speculatively.
 */
export interface PlatformCapabilities {
  /**
   * True when the managed Cloudflare bindings (D1, KV, R2, AI, browser, email)
   * exist on this platform. celld has none of them and serves each seam with a
   * facade instead. Gates which binding-backed services are worth attempting.
   */
  hasManagedBindings: boolean;
  /**
   * True when the platform can transcribe audio server-side (Workers AI on
   * Cloudflare). celld has no AI binding, so voice dictation must fail closed
   * there: the feature flag can only turn it off, never on, where the
   * capability is absent. Gates VoiceAgent and bootstrap's `voiceInput`.
   */
  speechToText: boolean;
}

export function platformCapabilities(env: {
  NADI_PLATFORM?: string | undefined;
}): PlatformCapabilities {
  return {
    hasManagedBindings: resolvePlatform(env) === "cloudflare",
    speechToText: resolvePlatform(env) === "cloudflare",
  };
}

/**
 * What the edition permits, named by capability rather than by edition. Callers
 * branch on the capability so each future divergence gets its own honest name
 * and one place to flip, instead of re-deriving what "cloud" means at every
 * call site.
 */
export interface EditionCapabilities {
  /**
   * True when deployment-level compute (Cloudflare bindings, backup storage) is
   * provisioned by the service operator rather than by the person using the
   * app. Gates read-only operator config surfaces, which are noise to a tenant
   * who cannot change them.
   */
  operatorManagedCompute: boolean;
}

export function editionCapabilities(env: {
  NADI_EDITION?: string | undefined;
}): EditionCapabilities {
  return { operatorManagedCompute: resolveEdition(env) === "cloud" };
}
