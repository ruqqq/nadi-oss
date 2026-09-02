import type { SettingsProvider } from "./settings-api";

export interface SettingsProviderOption {
  value: SettingsProvider;
  label: string;
}

export const SETTINGS_PROVIDER_OPTIONS: SettingsProviderOption[] = [
  { value: "openai", label: "OpenAI" },
  { value: "openai-oauth", label: "OpenAI OAuth" },
  { value: "anthropic", label: "Anthropic" },
  { value: "workers-ai", label: "Cloudflare Workers AI" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "zai", label: "Z.AI GLM" },
  { value: "qwen", label: "Qwen / DashScope" },
  { value: "opencode-go", label: "OpenCode Go" },
  { value: "opencode-zen", label: "OpenCode Zen" },
  { value: "openai-compatible", label: "OpenAI Compatible" },
];

/**
 * The model id to pre-fill when a provider is chosen, or `""` when there is no
 * sensible default.
 *
 * Every placeholder below except `openai-compatible`'s is a real model id, so
 * pre-filling it gives a working default. `openai-compatible` points at a
 * self-hosted endpoint whose models we cannot know — its placeholder is the
 * hint string "model-id", which is a prompt, not a model. Writing that into the
 * value made the composer look ready to send a model id no provider serves.
 */
export function defaultModelForProvider(provider: SettingsProvider): string {
  return provider === "openai-compatible" ? "" : SETTINGS_PROVIDER_MODEL_PLACEHOLDERS[provider];
}

export const SETTINGS_PROVIDER_MODEL_PLACEHOLDERS: Record<SettingsProvider, string> = {
  openai: "gpt-5.4-mini",
  "openai-oauth": "gpt-5.4-mini",
  anthropic: "claude-sonnet-4-6",
  "workers-ai": "@cf/moonshotai/kimi-k2.7-code",
  openrouter: "openai/gpt-5.4-mini",
  deepseek: "deepseek-v4-pro",
  zai: "glm-5.2",
  qwen: "qwen-plus",
  "opencode-go": "deepseek-v4-flash",
  "opencode-zen": "deepseek-v4-pro",
  "openai-compatible": "model-id",
};

// Fallback selection when the saved provider isn't one we know. It must be a
// provider every account can actually reach, so it can't be the gated
// Workers AI provider — that is hidden from most accounts' lists.
export const DEFAULT_PROVIDER: SettingsProvider = "opencode-go";
export const AGENT_SETTINGS_TITLE = "Configure agent";
export const GENERAL_SETTINGS_SHOW_WORKSPACE_SECTION = false;
export const PROVIDER_SECRET_NAME_FIELD_READ_ONLY = true;

// The workspace LIBRARY, which is the one fact this tab exists to convey: one
// copy, shared by every agent, so an edit here reaches all of them. It used to
// say skills were "created and edited by the agent in chat" — following that
// produces an AGENT-PRIVATE skill, which never appears on this tab at all.
export const SKILLS_SETTINGS_HINT =
  "Shared skills: every agent in this workspace loads these unless it opts out or has its own skill of the same name. One copy, so an edit here reaches all of them. A skill an agent writes in chat is private to that agent.";

export const INVITES_SETTINGS_HINT =
  "Nadi is invite-only. Share a link with someone and they can sign in with their own email. A slot is only used up once they actually join — unused links cost you nothing.";

export const MEMORY_SETTINGS_HINT =
  "Memories are created and edited by the agent in chat. Here you can review what it remembers and archive anything that's out of date.";

export const SANDBOX_SETTINGS_HINT =
  "Where this workspace runs shell commands: the compute provider, its credentials, and the limits every machine inherits. What each agent runs on — machine size, repositories, setup script, secrets — is set on the agent itself.";

export const SANDBOX_SPRITES_HINT =
  "Sprites (Fly.io) machines persist between turns and hibernate when idle. System mode uses this deployment's Sprites account; bring your own token to use your own.";

export const SANDBOX_SNAPSHOT_HINT =
  "Snapshot (a prebuilt Daytona template with preconfigured image + CPU/RAM/disk). Takes precedence over Image.";

export const SANDBOX_NETWORK_RESTRICTION_HINT =
  "Block outbound network access except to an allowlist of domains. Enabled MCP servers' hosts are always included. Off inherits the provider's default network access.";

/** Compute providers a workspace can run on. `mock` is the in-memory local-dev
 * provider (see the worker's `MockComputeBackend`); it needs no configuration. */
export const SANDBOX_PROVIDER_OPTIONS = [
  { value: "daytona", label: "Daytona" },
  { value: "cloudflare", label: "Cloudflare" },
  { value: "sprites", label: "Sprites (Fly.io)" },
  { value: "mock", label: "Mock (local dev)" },
] as const;

export type SandboxProviderId = (typeof SANDBOX_PROVIDER_OPTIONS)[number]["value"];

/**
 * Why Cloudflare can't be selected while the workspace has network restrictions.
 * This is an UNSUPPORTED-capability message, kept distinct from missing-config
 * copy: one means "you can't use this provider here", the other means "an
 * operator hasn't finished provisioning it". The advice depends on the
 * currently SELECTED provider: telling someone already on Cloudflare to "stay
 * on Daytona" is nonsensical, and someone already on Cloudflare needs to know
 * threads will fail to start, not just that the option is blocked.
 */
export function sandboxCloudflareNetworkUnsupportedNote(
  selectedProvider: SandboxProviderId,
): string {
  if (selectedProvider === "cloudflare") {
    return "Network restrictions are not supported on Cloudflare. Threads on this workspace will fail to start until you clear the restrictions below or switch back to Daytona.";
  }
  return "Network restrictions are not supported on Cloudflare. Clear them, or stay on Daytona.";
}

export const SANDBOX_CLOUDFLARE_READINESS_HINT =
  "Cloudflare compute is provisioned per deployment. These bindings and secrets are set by an operator, not here.";

/**
 * Shown in the Cloudflare readiness panel when `unsupported` names
 * `network_restrictions` — i.e. the workspace already has restrictions
 * configured while Cloudflare is the selected provider. This is a hard
 * consequence (acquire fails closed with `policy_rejected`), not a soft
 * suggestion, so it states the failure plainly.
 */
export const SANDBOX_CLOUDFLARE_NETWORK_UNSUPPORTED_CONSEQUENCE_HINT =
  "Network restrictions are configured for this workspace, and Cloudflare's sandbox has no way to enforce a host allowlist. Threads on this workspace will fail to start until you clear the restrictions below or switch this workspace to Daytona.";

/** Shown when `missingConfig` is non-empty — an operator hasn't finished provisioning Cloudflare. */
export const SANDBOX_CLOUDFLARE_PROVISIONING_HINT =
  "Cloudflare isn’t fully provisioned yet. The rows below name the bindings and secrets an operator still needs to set.";

/**
 * Deployment config Cloudflare needs, grouped for the readiness panel. NAMES
 * only — the browser learns which are present by their absence from the server's
 * `missingConfig`; it never sees a value.
 */
export const SANDBOX_CLOUDFLARE_READINESS_GROUPS: Array<{
  title: string;
  hint: string;
  names: string[];
}> = [
  {
    title: "Sandbox bindings",
    hint: "Durable Object container binding for each resource profile.",
    names: ["NADI_SANDBOX_SMALL", "NADI_SANDBOX_MEDIUM"],
  },
  {
    title: "Backup storage",
    hint: "R2 bucket and SigV4 credentials used to snapshot and recover workspaces.",
    names: [
      "BACKUP_BUCKET",
      "BACKUP_BUCKET_NAME",
      "CLOUDFLARE_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
    ],
  },
];

export const SANDBOX_ALLOWLIST_HINT =
  "One domain per line or comma-separated. Wildcards like *.github.com are allowed. Leave empty to use the curated default (npm, PyPI, GitHub, Debian/Ubuntu mirrors).";

export const SANDBOX_AGENT_ALLOWLIST_HINT =
  "Extra domains reachable for this agent only, added on top of the workspace allowlist above.";

export const WEB_TOOLS_SETTINGS_HINT =
  "Let the agent search the web with Exa. Page fetching (web_fetch) is always available and needs no key.";

export const GITHUB_SETTINGS_HINT =
  "Connect a GitHub App installation so sandboxes clone and push your repositories without a manual token.";
