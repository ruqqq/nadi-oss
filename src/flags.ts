/** Shared truthiness parsing for string-valued wrangler `vars` feature flags. */
export function isTruthyFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

export function backgroundWorkEnabled(env: {
  BACKGROUND_WORK_ENABLED?: string | undefined;
}): boolean {
  return isTruthyFlag(env.BACKGROUND_WORK_ENABLED);
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
