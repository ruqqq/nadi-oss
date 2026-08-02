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
