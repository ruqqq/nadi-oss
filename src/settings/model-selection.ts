import type { Env } from "../env";
import { listProviderSettings, parseProvider } from "./provider-settings";

/**
 * Shared vocabulary for "the user picked a provider + model". Threads and
 * automata both persist the same triple (provider, model, inputModalities) and
 * must agree on what counts as a valid, usable choice — so the parsing and the
 * usability check live here rather than in either route file.
 */

const MOCK_AGENT_PROVIDERS = new Set([
  "mock",
  "mock-tool-call",
  "mock-reasoning",
  "mock-tool-loop",
]);

const MODEL_INPUT_MODALITIES = new Set(["text", "image", "audio", "video", "file"]);

export function isSupportedAgentProvider(provider: string): boolean {
  return parseProvider(provider) !== null || MOCK_AGENT_PROVIDERS.has(provider);
}

/** null when the value isn't a non-empty array of known modality names. */
export function parseModelInputModalities(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const modalities = Array.from(new Set(value));
  if (
    modalities.length === 0 ||
    !modalities.every((entry) => typeof entry === "string" && MODEL_INPUT_MODALITIES.has(entry))
  ) {
    return null;
  }
  return modalities;
}

/** Stored JSON column → modalities, degrading to ["text"] rather than throwing. */
export function parseStoredModelInputModalities(value: string | null | undefined): string[] {
  if (!value) return ["text"];
  try {
    return parseModelInputModalities(JSON.parse(value) as unknown) ?? ["text"];
  } catch {
    return ["text"];
  }
}

/**
 * Can this workspace actually run on this provider right now? Gated providers
 * are withheld from `listProviderSettings` for non-allowlisted accounts, so
 * this doubles as the authorization check for setting one.
 */
export async function isUsableProviderForWorkspace(
  env: Env,
  workspaceId: string,
  provider: string,
  viewerEmail: string | null | undefined,
): Promise<boolean> {
  if (MOCK_AGENT_PROVIDERS.has(provider)) return true;
  const parsed = parseProvider(provider);
  if (!parsed) return false;
  const settings = await listProviderSettings(env, workspaceId, viewerEmail);
  return settings.some((entry) => entry.provider === parsed && entry.usable);
}
