import { describe, expect, it } from "vitest";
import {
  ONBOARDING_PROVIDER_OPTIONS,
  ONBOARDING_STEPS,
  deriveNeedsOnboarding,
  isKeylessOnboardingProvider,
  isOnboardingForced,
  onboardingProviderOptions,
  RECOMMENDED_ONBOARDING_PROVIDER,
} from "./onboarding";

describe("isOnboardingForced", () => {
  it("is true only for the exact force value", () => {
    expect(isOnboardingForced("?onboarding=force")).toBe(true);
    expect(isOnboardingForced("?view=archived&onboarding=force")).toBe(true);
  });

  it("is false for absent, empty, or other values", () => {
    expect(isOnboardingForced("")).toBe(false);
    expect(isOnboardingForced("?view=archived")).toBe(false);
    expect(isOnboardingForced("?onboarding=")).toBe(false);
    expect(isOnboardingForced("?onboarding=1")).toBe(false);
    expect(isOnboardingForced("?onboarding=Force")).toBe(false);
  });
});

describe("ONBOARDING_STEPS", () => {
  it("runs required setup before the optional step", () => {
    expect(ONBOARDING_STEPS.map((s) => s.id)).toEqual(["provider", "assistant", "web-search"]);
  });

  it("marks only web search as skippable", () => {
    expect(ONBOARDING_STEPS.filter((s) => s.optional).map((s) => s.id)).toEqual(["web-search"]);
  });
});

describe("ONBOARDING_PROVIDER_OPTIONS", () => {
  it("offers API-key and compatible providers in onboarding order", () => {
    expect(ONBOARDING_PROVIDER_OPTIONS.map((o) => o.value)).toEqual([
      "opencode-go",
      "opencode-zen",
      "openai",
      "anthropic",
      "openrouter",
      "deepseek",
      "zai",
      "qwen",
      "openai-compatible",
    ]);
  });

  it("leads with the recommended provider, so the default pick is the recommended one", () => {
    expect(ONBOARDING_PROVIDER_OPTIONS[0]?.value).toBe(RECOMMENDED_ONBOARDING_PROVIDER);
  });
});

describe("onboardingProviderOptions", () => {
  it("leads with Workers AI when the account is allowlisted for it", () => {
    const values = onboardingProviderOptions({ workersAi: true }).map((o) => o.value);
    expect(values[0]).toBe("workers-ai");
    // It is additive — every key-based provider is still offered.
    expect(values).toEqual(["workers-ai", ...ONBOARDING_PROVIDER_OPTIONS.map((o) => o.value)]);
  });

  it("omits Workers AI entirely when the account is not allowlisted", () => {
    const values = onboardingProviderOptions({ workersAi: false }).map((o) => o.value);
    expect(values).not.toContain("workers-ai");
    expect(values).toEqual(ONBOARDING_PROVIDER_OPTIONS.map((o) => o.value));
  });
});

describe("isKeylessOnboardingProvider", () => {
  it("is true only for Workers AI, which authenticates via the binding", () => {
    expect(isKeylessOnboardingProvider("workers-ai")).toBe(true);
    expect(isKeylessOnboardingProvider("openai")).toBe(false);
    expect(isKeylessOnboardingProvider("openai-compatible")).toBe(false);
  });
});

describe("deriveNeedsOnboarding", () => {
  const noKeys = [
    { provider: "openai", secretPresent: false, usable: false },
    { provider: "anthropic", secretPresent: false, usable: false },
    { provider: "openrouter", secretPresent: false, usable: false },
  ];

  it("is true when no provider has a key and there are no threads", () => {
    expect(deriveNeedsOnboarding({ providers: noKeys, threadCount: 0 })).toBe(true);
  });

  it("treats a keyless-but-usable provider as configured", () => {
    // Workers AI is usable with no secret. Onboarding keys off `usable`, so it
    // must not loop a user who has only ever picked Workers AI back into setup.
    expect(
      deriveNeedsOnboarding({
        providers: [...noKeys, { provider: "workers-ai", secretPresent: false, usable: true }],
        threadCount: 0,
      }),
    ).toBe(false);
  });

  it("is false when any provider already has a key", () => {
    const withKey = [
      { provider: "openai", secretPresent: true },
      { provider: "anthropic", secretPresent: false },
    ];
    expect(deriveNeedsOnboarding({ providers: withKey, threadCount: 0 })).toBe(false);
  });

  it("is false when an OAuth provider is already configured", () => {
    const withOAuth = [
      { provider: "openai", secretPresent: false },
      { provider: "openai-oauth", secretPresent: true },
    ];
    expect(deriveNeedsOnboarding({ providers: withOAuth, threadCount: 0 })).toBe(false);
  });

  it("is false when any provider is usable", () => {
    const withUsable = [
      { provider: "openai-compatible", secretPresent: false, usable: true },
      { provider: "openai", secretPresent: false, usable: false },
    ];
    expect(deriveNeedsOnboarding({ providers: withUsable, threadCount: 0 })).toBe(false);
  });

  it("is false when threads already exist even with no key", () => {
    expect(deriveNeedsOnboarding({ providers: noKeys, threadCount: 3 })).toBe(false);
  });

  it("is false when both a key and threads exist", () => {
    const withKey = [{ provider: "openai", secretPresent: true }];
    expect(deriveNeedsOnboarding({ providers: withKey, threadCount: 5 })).toBe(false);
  });

  // The optional web-search step must never become a term in this predicate, or
  // every existing user without an Exa key gets dragged back through first-run.
  it("ignores web search: a usable provider is enough, key or not", () => {
    const withKey = [{ provider: "openai", secretPresent: true }];
    expect(deriveNeedsOnboarding({ providers: withKey, threadCount: 0 })).toBe(false);
  });
});
