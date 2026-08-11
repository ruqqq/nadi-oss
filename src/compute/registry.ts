import { platformCapabilities } from "../edition";
import type { Env } from "../env";
import type { ComputeBackend } from "./backend";
import { CloudflareComputeBackend } from "./backends/cloudflare";
import type { CloudflareSandboxFactory } from "./backends/cloudflare-client";
import { DaytonaComputeBackend } from "./backends/daytona";
import { MockComputeBackend } from "./backends/mock";
import { SpritesComputeBackend } from "./backends/sprites";
import { createSpritesClient, type ExecUpgradeScheme } from "./backends/sprites-client";
import { resolveDaytonaConfiguration } from "./daytona-config";
import { resolveSpritesConfiguration } from "./sprites-config";
import { ComputeError } from "./errors";
import { CLOUDFLARE_REQUIRED_CONFIG, isComputeConfigPresent } from "./settings";
import type { DaytonaProviderConfig, EffectiveComputeConfig, SpritesProviderConfig } from "./types";

/** Test seams for substituting the Cloudflare SDK or Daytona client factory.
 * The Cloudflare override also prevents unit tests from loading
 * `@cloudflare/sandbox` (its `cloudflare:workers` import is unavailable under
 * the node test runner). Production leaves these unset. */
export interface BuildComputeBackendOverrides {
  cloudflareFactory?: CloudflareSandboxFactory;
  daytonaFactory?: (config: {
    apiKey: string;
    apiUrl: string | null;
    target: string | null;
    source: { image?: string; snapshot?: string };
  }) => ComputeBackend;
  spritesFactory?: (config: {
    apiKey: string;
    env: Record<string, string>;
    execUpgradeScheme: ExecUpgradeScheme;
  }) => ComputeBackend;
}

/**
 * Constructs the compute backend for a thread's effective configuration. The
 * backend is provider-neutral to callers; the concrete provider is selected
 * from `config.providerConfig.kind`.
 *
 * `threadId` is REQUIRED (not derivable from `config`): `ComputeSpec.environmentId`
 * is a template identifier that evaluates to the constant `"cloudflare:<profile>"`
 * for every Cloudflare thread, so the Cloudflare backend derives its Durable
 * Object instance identity from `workspaceId` + `threadId` instead. Daytona
 * ignores it (it mints a fresh provider-side sandbox id per acquire).
 */
export async function buildComputeBackend(
  env: Env,
  workspaceId: string,
  threadId: string,
  config: EffectiveComputeConfig,
  overrides?: BuildComputeBackendOverrides,
  /**
   * The runtime environment the caller will run commands with — the same
   * `ComputeSpec.env` the thread service holds, resolved before this call.
   *
   * Only sprites uses it: Daytona and Cloudflare bake env into the sandbox at
   * creation, while sprites has to carry it on every exec (its create-time
   * `environment` never reaches a command). It is passed at CONSTRUCTION rather
   * than through the backend reference because the reference is persisted and
   * these values are secrets.
   */
  execEnv?: Record<string, string>,
): Promise<ComputeBackend> {
  switch (config.providerConfig.kind) {
    case "daytona":
      return buildDaytonaBackend(
        env,
        workspaceId,
        config,
        config.providerConfig,
        overrides?.daytonaFactory,
      );
    case "cloudflare":
      return buildCloudflareBackend(env, workspaceId, threadId, overrides?.cloudflareFactory);
    case "mock":
      // Local-dev in-memory backend: no credentials, containers, or R2. Pure TS,
      // so it is imported eagerly (unlike the Cloudflare SDK) and never fails to
      // build. See `src/compute/backends/mock.ts`.
      return new MockComputeBackend();
    case "sprites":
      return buildSpritesBackend(
        env,
        workspaceId,
        config.providerConfig,
        overrides?.spritesFactory,
        execEnv ?? {},
      );
  }
}

/**
 * Builds the Cloudflare Sandbox backend. Fails closed if the container/bucket
 * bindings it needs to run are absent at runtime (verified by NAME, never a
 * non-null assertion — the `?` on these bindings is a regeneration artifact, not
 * a promise they are optional).
 *
 * `useLocalBucket` is always `false` here, not derived from credential
 * presence. Nadi's Cloudflare Sandbox runs only in the deployed Worker, and
 * `computeProviderReadiness` (settings.ts) already requires the SigV4 presign
 * credentials (`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`) before Cloudflare is
 * selectable at all. So the only reachable state is "the SDK can presign",
 * and `false` is always correct. Supporting local-dev Cloudflare (where the
 * SDK must resolve the R2 binding directly) would be a separate change:
 * readiness would have to stop requiring the SigV4 keys (they are
 * production-presign-only), and `useLocalBucket` would need to become a
 * single source of truth that both readiness and backup/restore consult —
 * not a value re-derived from the credentials readiness already gates on.
 */
async function buildCloudflareBackend(
  env: Env,
  workspaceId: string,
  threadId: string,
  factoryOverride: CloudflareSandboxFactory | undefined,
): Promise<ComputeBackend> {
  // The SAME list readiness enforces, not a subset. This path (the agent's) has no
  // readiness gate, and the `useLocalBucket: false` above is only correct because
  // the SigV4 presign credentials are guaranteed present. Checking a narrower set
  // here would let a deploy with the container bindings but no R2 secrets acquire,
  // exec, and discard happily, then fail the first recoverable release at
  // `createBackup` -- long after the user believed Cloudflare was working.
  const missing = CLOUDFLARE_REQUIRED_CONFIG.filter((name) => !isComputeConfigPresent(env, name));
  if (missing.length > 0) {
    throw new ComputeError(
      "compute_unavailable",
      `cloudflare_config_missing: ${missing.join(",")}`,
    );
  }
  // Lazily import the SDK-backed factory ONLY when actually building a real
  // backend, so importing this registry from a node unit test never pulls in
  // `@cloudflare/sandbox` (which imports `cloudflare:workers`). Tests inject a
  // fake factory and never reach this line.
  const factory =
    factoryOverride ??
    (await import("./backends/cloudflare-client")).createCloudflareSandboxFactory();
  return new CloudflareComputeBackend({
    factory,
    bindings: { small: env.NADI_SANDBOX_SMALL, medium: env.NADI_SANDBOX_MEDIUM },
    workspaceId,
    threadId,
    useLocalBucket: false,
  });
}

/**
 * Builds the Daytona backend from the effective system-managed or workspace
 * configuration. A decrypted workspace key is used only to instantiate the
 * client and is never returned, exposed to the model, or written into output.
 */
async function buildDaytonaBackend(
  env: Env,
  workspaceId: string,
  config: EffectiveComputeConfig,
  providerConfig: DaytonaProviderConfig,
  factoryOverride: BuildComputeBackendOverrides["daytonaFactory"],
): Promise<ComputeBackend> {
  const resolved = await resolveDaytonaConfiguration({ env, workspaceId, providerConfig });
  if (!resolved.apiKey)
    throw new ComputeError("compute_unavailable", "compute_daytona_secret_missing");
  const source = resolved.profiles[config.resourceProfile];
  if (!source) throw new ComputeError("compute_unavailable", "compute_daytona_source_missing");
  const createBackend = factoryOverride ?? ((options) => new DaytonaComputeBackend(options));
  return createBackend({
    apiKey: resolved.apiKey,
    apiUrl: resolved.apiUrl,
    target: resolved.target,
    source: { [source.kind]: source.value },
  });
}

/**
 * Builds the sprites.dev backend from the effective system-managed or
 * workspace configuration. `SpritesComputeBackend`/`createSpritesClient` are
 * pure fetch/TS (no `cloudflare:workers` import), so — unlike the Cloudflare
 * SDK — they are imported eagerly at the top of this file and never need a
 * lazy `import()`.
 */
async function buildSpritesBackend(
  env: Env,
  workspaceId: string,
  providerConfig: SpritesProviderConfig,
  factoryOverride: BuildComputeBackendOverrides["spritesFactory"],
  execEnv: Record<string, string>,
): Promise<ComputeBackend> {
  const resolved = await resolveSpritesConfiguration({ env, workspaceId, providerConfig });
  if (!resolved.apiKey)
    throw new ComputeError("compute_unavailable", "compute_sprites_secret_missing");
  // Which scheme the exec upgrade is dialled on is a property of the RUNTIME we
  // are executing in, not of the sprites deployment we are talking to — workerd
  // and celld each reject the other's form. See `sprites-client.ts`'s `execUrl`.
  const execUpgradeScheme: ExecUpgradeScheme = platformCapabilities(env).wsSchemeUpgrade
    ? "ws"
    : "http";
  const create =
    factoryOverride ??
    ((c) =>
      new SpritesComputeBackend({
        client: createSpritesClient({ apiKey: c.apiKey, execUpgradeScheme: c.execUpgradeScheme }),
        // Carried on every exec — sprites has no create-time environment that
        // reaches a command. Instance-only; never written to a reference.
        env: c.env,
      }));
  // `execUpgradeScheme` goes through the FACTORY rather than being closed over,
  // so the override sees it too: the default factory is the only thing that
  // touches `createSpritesClient`, and a test that replaces it would otherwise
  // have no way to observe whether the platform reached the client at all.
  return create({ apiKey: resolved.apiKey, env: execEnv, execUpgradeScheme });
}
