import type { SettingsProvider } from "../settings-api";

/** The provider Nadi steers a fresh user toward, absent a reason not to. */
export const RECOMMENDED_ONBOARDING_PROVIDER: SettingsProvider = "opencode-go";

/**
 * Providers offered during first-run onboarding. API keys only — the OpenAI
 * OAuth path is deferred to Settings. Order is the wizard's display order, and
 * the recommended provider leads it: a fresh user who has no opinion should not
 * have to form one to get started.
 */
export const ONBOARDING_PROVIDER_OPTIONS: { value: SettingsProvider; label: string }[] = [
  { value: "opencode-go", label: "OpenCode Go" },
  { value: "opencode-zen", label: "OpenCode Zen" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "zai", label: "Z.AI GLM" },
  { value: "qwen", label: "Qwen / DashScope" },
  { value: "openai-compatible", label: "OpenAI Compatible" },
];

/**
 * Workers AI needs no API key, so when the account is allowlisted for it we lead
 * with it — it is the only option that gets a fresh user to chat without first
 * going and finding a key somewhere else. That beats even the recommended
 * provider, which still sends them off to sign up; the recommendation badge
 * stays where it is, so the two don't contradict each other.
 */
export function onboardingProviderOptions(input: {
  workersAi: boolean;
}): { value: SettingsProvider; label: string }[] {
  if (!input.workersAi) return ONBOARDING_PROVIDER_OPTIONS;
  return [{ value: "workers-ai", label: "Cloudflare Workers AI" }, ...ONBOARDING_PROVIDER_OPTIONS];
}

/** Providers that authenticate without a user-supplied key. */
export function isKeylessOnboardingProvider(provider: SettingsProvider): boolean {
  return provider === "workers-ai";
}

export type OnboardingStepId = "provider" | "assistant" | "empower" | "install";

export interface OnboardingStepDef {
  id: OnboardingStepId;
  label: string;
  optional: boolean;
}

/**
 * The wizard's steps in display order. Steps are ids rather than ordinals
 * because two things vary: the install step is skipped for a user who already
 * installed the PWA (who must not see "Step 3 of 4" either), and the empower
 * step has to be nameable in a URL so an MCP OAuth redirect can return to it.
 */
export function visibleOnboardingSteps(input: { installed: boolean }): OnboardingStepDef[] {
  const steps: OnboardingStepDef[] = [
    { id: "provider", label: "Connect a provider", optional: false },
    { id: "assistant", label: "Set up your assistant", optional: false },
    { id: "empower", label: "Empower your agent", optional: true },
  ];
  if (!input.installed) {
    steps.push({ id: "install", label: "Install Nadi", optional: true });
  }
  return steps;
}

const STEP_IDS: OnboardingStepId[] = ["provider", "assistant", "empower", "install"];

/** `null` when absent or unrecognized — the caller falls back to step one. */
export function parseOnboardingStep(search: string): OnboardingStepId | null {
  const value = new URLSearchParams(search).get("step");
  return STEP_IDS.find((id) => id === value) ?? null;
}

/**
 * The URL for a wizard step. Every step is addressable, so back/forward move
 * between steps and a step can be linked to directly.
 *
 * `onboarding=force` is load-bearing on every step, not just the OAuth return:
 * once the provider step is done a provider key exists, so
 * `deriveNeedsOnboarding` is false and a reload on `?step=empower` would drop
 * the user into chat instead of back onto the step they were on.
 */
export function onboardingStepPath(step: OnboardingStepId): string {
  return `/?onboarding=force&step=${step}`;
}

/**
 * A fresh user needs onboarding only when they have no usable provider
 * configured AND have never created a thread. If a provider key (of any kind,
 * including OAuth) already exists, or any thread exists, route to the normal
 * app instead of forcing setup.
 *
 * `threadCount` is the bootstrap page's length, which the pagination work caps
 * at a page. That stays correct here: page one is non-empty whenever the user
 * has any thread at all, so `=== 0` still means "no threads exist", not merely
 * "none on this page". A capped bootstrap can never make a returning user with
 * threads look fresh.
 */
export function deriveNeedsOnboarding(input: {
  providers: { secretPresent: boolean; usable?: boolean }[];
  threadCount: number;
}): boolean {
  const hasUsableProvider = input.providers.some((p) => p.usable ?? p.secretPresent);
  return !hasUsableProvider && input.threadCount === 0;
}

/**
 * `?onboarding=force` replays the wizard for an account that already finished
 * it. Completion is derived, not stored, so without this the only way back in
 * is deleting every provider key and thread.
 */
export function isOnboardingForced(search: string): boolean {
  return new URLSearchParams(search).get("onboarding") === "force";
}
