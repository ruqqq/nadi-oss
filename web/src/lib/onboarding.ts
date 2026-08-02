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

export type OnboardingStepId = "provider" | "assistant" | "web-search";

/**
 * The wizard's steps, in display order. Optional steps can be skipped and never
 * block reaching chat; only the required ones gate progress. Kept here rather
 * than in the component so the shape is testable without rendering.
 */
export const ONBOARDING_STEPS: { id: OnboardingStepId; label: string; optional: boolean }[] = [
  { id: "provider", label: "Connect a provider", optional: false },
  { id: "assistant", label: "Set up your assistant", optional: false },
  { id: "web-search", label: "Enable web search", optional: true },
];

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
