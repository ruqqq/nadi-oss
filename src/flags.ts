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

/**
 * The two background-work capabilities, resolved independently.
 *
 * They are separate because they cost a workspace different things: a subagent
 * runs on the shared machine and reports back, whereas backgrounded exec leaves
 * a process alive past the turn and needs the watcher/push machinery. A
 * workspace can reasonably want one without the other.
 */
export interface BackgroundCapabilities {
  /** Backgrounded shell commands: `exec` detaching, watchers, push completion. */
  backgroundExec: boolean;
  /** `spawn_subagent` / `check_subagents`. */
  subagents: boolean;
}

/**
 * Read one capability out of a parsed `flags_json` object.
 *
 * Precedence is specific key, then the legacy `backgroundWork` key, then the
 * deployment var. That middle step is what makes this change require no
 * migration: every workspace that opted in with `{"backgroundWork": true}`
 * keeps BOTH capabilities, and a workspace that wants only one adds the
 * specific key alongside it (`{"backgroundWork": true, "backgroundExec": false}`).
 *
 * A present-but-non-boolean value resolves to `false` rather than falling
 * through, and that is deliberate and load-bearing: SQLite has no boolean, so a
 * value written as the integer `1` must NOT read as enabled. Reading it as
 * "unset" would silently promote it to whatever the fallback says, which is the
 * opposite of failing closed. (This is why the D1 update that enabled it had to
 * use `json('true')`.)
 */
function resolveCapability(
  flags: Record<string, unknown>,
  key: "backgroundExec" | "subagents",
  deploymentEnabled: boolean,
): boolean {
  const specific = flags[key];
  if (specific !== undefined) return typeof specific === "boolean" ? specific : false;
  const legacy = flags.backgroundWork;
  if (legacy !== undefined) return typeof legacy === "boolean" ? legacy : false;
  return deploymentEnabled;
}

export function resolveWorkspaceBackgroundCapabilities(input: {
  deploymentEnabled: boolean;
  flagsJson: string;
}): BackgroundCapabilities {
  try {
    const parsed: unknown = JSON.parse(input.flagsJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { backgroundExec: false, subagents: false };
    }
    const flags = parsed as Record<string, unknown>;
    return {
      backgroundExec: resolveCapability(flags, "backgroundExec", input.deploymentEnabled),
      subagents: resolveCapability(flags, "subagents", input.deploymentEnabled),
    };
  } catch {
    // Unparseable flags fail closed for both, as they always have.
    return { backgroundExec: false, subagents: false };
  }
}

/**
 * Is ANY background work available to this workspace?
 *
 * The gate for the kind-agnostic surfaces — the work ledger and its reaper, the
 * dock's `listBackgroundWork`, cancel, clear-finished, and the client's
 * `features.backgroundWork` (which answers only "should the dock exist"). Those
 * read rows of both kinds and need no per-kind logic of their own: with exec
 * off there are simply no process rows to show.
 */
export function anyBackgroundWorkEnabled(capabilities: BackgroundCapabilities): boolean {
  return capabilities.backgroundExec || capabilities.subagents;
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
