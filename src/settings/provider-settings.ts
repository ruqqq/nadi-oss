import type { Env } from "../env";
import { canUseProvider } from "../auth/provider-gate";
import { createWorkspaceSecretsServices } from "../secrets";
import {
  getProviderConfig,
  isProviderConfigProvider,
  isOpenAICompatibleProvider,
  listProviderConfigMetadata,
  parseProviderEndpointConfig,
  upsertProviderConfig,
  type ProviderConfigProvider,
  type ProviderEndpointConfig,
} from "../db/repositories/provider-configs";
import { listProviderModelWhitelists } from "../db/repositories/provider-models";
import { invalidateProviderCatalog } from "../providers/model-catalog";
import type { ProviderModelSearchResult } from "../providers/model-search";

export interface ProviderSettingsView {
  provider: ProviderConfigProvider;
  displayName: string;
  defaultSecretName: string;
  configuredSecretName: string;
  secretPresent: boolean;
  secretUpdatedAt: string | null;
  previewAvailable: boolean;
  endpointConfig: ProviderEndpointConfig;
  usable: boolean;
  /** Curated models, or `null` when the workspace has not curated this
   *  provider. Carried in the settings payload so the composer can render a
   *  curated picker with no network call at all. */
  whitelistModels: ProviderModelSearchResult[] | null;
}

export interface ProviderSecretPreview {
  provider: ProviderConfigProvider;
  secretName: string;
  preview: string;
  chars: number;
  truncated: boolean;
  updatedAt: string;
}

export function parseProvider(value: string): ProviderConfigProvider | null {
  return isProviderConfigProvider(value) ? value : null;
}

/**
 * Every provider in the workspace, with no viewer-based filtering. Internal
 * callers (secret read/write/preview) must use this: they operate on a provider
 * the route has already authorized, and filtering here would make them silently
 * report "no such provider" instead of doing their job.
 */
async function listAllProviderSettings(
  env: Env,
  workspaceId: string,
): Promise<ProviderSettingsView[]> {
  const metadata = await listProviderConfigMetadata(env, workspaceId);
  const { writer } = createWorkspaceSecretsServices(env);
  const [secretMetadata, whitelists] = await Promise.all([
    Promise.all(
      metadata.map((entry) => writer.getMetadata(workspaceId, entry.configuredSecretName)),
    ),
    listProviderModelWhitelists(env, workspaceId),
  ]);

  return metadata.map((entry, index) => {
    const matchingSecret = secretMetadata[index] ?? null;
    const secretPresent = matchingSecret !== null;
    const endpointConfig = entry.endpointConfig;
    const usable = isProviderUsable(entry.provider, secretPresent, endpointConfig);
    return {
      ...entry,
      secretPresent,
      secretUpdatedAt: matchingSecret?.updated_at ?? null,
      previewAvailable: secretPresent,
      endpointConfig,
      usable,
      // `null` (uncurated) and `[]` (curated to nothing) are different answers
      // all the way to the client — see web/src/lib/model-picker.ts.
      whitelistModels: whitelists.get(entry.provider) ?? null,
    };
  });
}

/**
 * The providers an account may see. Gated ones (Workers AI) are withheld
 * entirely (not merely flagged) when the viewer is not allowlisted — which
 * hides them from Settings, the onboarding wizard, and the model picker in one
 * place, since all three render from this list.
 *
 * `viewerEmail` is required: passing `undefined` denies the gated providers, so
 * an accidental omission fails closed rather than leaking. Internal callers that
 * need the unfiltered set use `listAllProviderSettings`.
 */
export async function listProviderSettings(
  env: Env,
  workspaceId: string,
  viewerEmail: string | null | undefined,
): Promise<ProviderSettingsView[]> {
  const all = await listAllProviderSettings(env, workspaceId);
  return all.filter((entry) => canUseProvider(env, entry.provider, viewerEmail));
}

export async function saveProviderSecret(
  env: Env,
  workspaceId: string,
  provider: ProviderConfigProvider,
  input: { value: string; secretName?: string },
): Promise<ProviderSettingsView> {
  if (!input.value.trim()) {
    throw new Error("secret_value_required");
  }

  const requestedSecretName = normalizeSecretName(input.secretName);

  const [currentConfig, metadata] = await Promise.all([
    getProviderConfig(env, workspaceId, provider),
    listProviderConfigMetadata(env, workspaceId),
  ]);
  const providerMetadata = metadata.find((entry) => entry.provider === provider);
  if (!providerMetadata) throw new Error(`provider_settings_missing:${provider}`);

  const secretName =
    requestedSecretName || currentConfig?.secretName || providerMetadata.configuredSecretName;
  assertValidSecretName(secretName);

  const { store, writer } = createWorkspaceSecretsServices(env);
  const previousValue = await store.get(workspaceId, secretName);
  await writer.ensureWorkspaceDek(workspaceId);
  await writer.set(workspaceId, secretName, input.value);
  try {
    await upsertProviderConfig(env, workspaceId, {
      provider,
      secretName,
    });
  } catch (error) {
    if (previousValue === null) {
      await writer.delete(workspaceId, secretName).catch(() => undefined);
    } else {
      await writer.set(workspaceId, secretName, previousValue);
    }
    throw error;
  }

  // A new key can mean a different catalog (different account, different tier).
  // The curated whitelist is deliberately left alone — rotating a credential is
  // not a request to discard the models the user chose.
  await invalidateProviderCatalog(env, workspaceId, provider);

  const settings = await listAllProviderSettings(env, workspaceId);
  const saved = settings.find((entry) => entry.provider === provider);
  if (!saved) throw new Error(`provider_settings_missing:${provider}`);
  return saved;
}

export async function saveProviderEndpointConfig(
  env: Env,
  workspaceId: string,
  provider: ProviderConfigProvider,
  config: Partial<ProviderEndpointConfig>,
): Promise<ProviderSettingsView> {
  await upsertProviderConfig(env, workspaceId, { provider, config });
  // A changed baseUrl points at a different catalog entirely.
  await invalidateProviderCatalog(env, workspaceId, provider);
  const settings = await listAllProviderSettings(env, workspaceId);
  const saved = settings.find((entry) => entry.provider === provider);
  if (!saved) throw new Error(`provider_settings_missing:${provider}`);
  return saved;
}

export async function getProviderEndpointConfig(
  env: Env,
  workspaceId: string,
  provider: ProviderConfigProvider,
): Promise<ProviderEndpointConfig> {
  const config = await getProviderConfig(env, workspaceId, provider);
  return parseProviderEndpointConfig(provider, config?.configJson);
}

export async function getProviderSecretValue(
  env: Env,
  workspaceId: string,
  provider: ProviderConfigProvider,
): Promise<string | null> {
  const settings = await listAllProviderSettings(env, workspaceId);
  const entry = settings.find((item) => item.provider === provider);
  if (!entry?.secretPresent) return null;
  const { store } = createWorkspaceSecretsServices(env);
  return store.get(workspaceId, entry.configuredSecretName);
}

export function isProviderUsable(
  provider: ProviderConfigProvider,
  secretPresent: boolean,
  endpointConfig: ProviderEndpointConfig,
): boolean {
  // Authenticated by the `AI` binding, so there is nothing to configure — it is
  // usable the moment it is offered. The allowlist decides whether it is offered
  // at all; see canUseProvider.
  if (provider === "workers-ai") {
    return true;
  }
  if (provider === "openai-oauth") {
    // Needs both the ChatGPT OAuth token and a clean-egress proxy route:
    // ChatGPT 403s Worker egress, so direct is not a usable configuration.
    return secretPresent && endpointConfig.proxyUrl.length > 0;
  }
  if (provider === "openai-compatible" && endpointConfig.auth === "none") {
    return endpointConfig.baseUrl.length > 0;
  }
  if (isOpenAICompatibleProvider(provider)) {
    if ((provider === "qwen" || provider === "openai-compatible") && !endpointConfig.baseUrl) {
      return false;
    }
    return secretPresent;
  }
  return secretPresent;
}

export async function previewProviderSecret(
  env: Env,
  workspaceId: string,
  provider: ProviderConfigProvider,
  charsInput = 8,
): Promise<ProviderSecretPreview | undefined> {
  const settings = await listAllProviderSettings(env, workspaceId);
  const entry = settings.find((item) => item.provider === provider);
  if (!entry?.secretPresent || entry.secretUpdatedAt === null) return undefined;

  const { store } = createWorkspaceSecretsServices(env);
  const plaintext = await store.get(workspaceId, entry.configuredSecretName);
  if (plaintext === null) return undefined;

  const requestedChars = clampPreviewChars(charsInput);
  const chars = safePreviewChars(plaintext.length, requestedChars);
  return {
    provider,
    secretName: entry.configuredSecretName,
    preview: plaintext.slice(0, chars),
    chars,
    truncated: plaintext.length > chars,
    updatedAt: entry.secretUpdatedAt,
  };
}

function clampPreviewChars(charsInput: number): number {
  if (!Number.isFinite(charsInput)) return 8;
  return Math.min(16, Math.max(4, Math.trunc(charsInput)));
}

function safePreviewChars(secretLength: number, requestedChars: number): number {
  if (secretLength <= 0) return 0;
  return Math.min(requestedChars, secretLength - 1);
}

function normalizeSecretName(secretName: string | undefined): string | undefined {
  if (secretName === undefined) return undefined;
  const trimmed = secretName.trim();
  if (!trimmed) return undefined;
  assertValidSecretName(trimmed);
  return trimmed;
}

function assertValidSecretName(secretName: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(secretName)) {
    throw new Error("invalid_secret_name");
  }
}
