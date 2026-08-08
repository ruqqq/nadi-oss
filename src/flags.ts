import { platformCapabilities } from "./edition";

/** Shared truthiness parsing for string-valued wrangler `vars` feature flags. */
export function isTruthyFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

export function backgroundWorkEnabled(env: {
  BACKGROUND_WORK_ENABLED?: string | undefined;
}): boolean {
  return isTruthyFlag(env.BACKGROUND_WORK_ENABLED);
}

/**
 * Resolve voice input the same way everywhere: the `VOICE_INPUT_ENABLED` var
 * can only turn it off, never on — a platform without speech-to-text (celld
 * has no AI binding) stays refused. Runtime enforcement (VoiceAgent) and
 * bootstrap (features.voiceInput) both resolve through this so they agree.
 */
export function voiceInputEnabled(env: {
  NADI_PLATFORM?: string | undefined;
  VOICE_INPUT_ENABLED?: string | undefined;
}): boolean {
  return platformCapabilities(env).speechToText && isTruthyFlag(env.VOICE_INPUT_ENABLED);
}

export function resolveWorkspaceBackgroundWork(input: {
  deploymentEnabled: boolean;
  flagsJson: string;
}): boolean {
  try {
    const parsed: unknown = JSON.parse(input.flagsJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const value = (parsed as Record<string, unknown>).backgroundWork;
    return value === undefined
      ? input.deploymentEnabled
      : typeof value === "boolean"
        ? value
        : false;
  } catch {
    return false;
  }
}

export function resolveWorkspaceWorkbenchNetworkAllowlist(flagsJson: string): boolean {
  try {
    const parsed: unknown = JSON.parse(flagsJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return (parsed as Record<string, unknown>).workbenchNetworkAllowlist === true;
  } catch {
    return false;
  }
}
