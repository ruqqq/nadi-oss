/**
 * The SPA keeps its own copy of the provider list. It has to agree with the
 * server's, or a provider is configurable on one side and invisible on the
 * other. Same silent-failure class as test/unit/providers/provider-registry.test.ts,
 * different half of the codebase.
 */
import { describe, expect, it } from "vitest";
import { SUPPORTED_PROVIDER_CONFIGS } from "../../../src/db/repositories/provider-configs";
import { isSettingsProvider } from "../../../web/src/settings-api";
import {
  ONBOARDING_PROVIDER_OPTIONS,
  RECOMMENDED_ONBOARDING_PROVIDER,
} from "../../../web/src/lib/onboarding";
import {
  DEFAULT_PROVIDER,
  SETTINGS_PROVIDER_MODEL_PLACEHOLDERS,
  SETTINGS_PROVIDER_OPTIONS,
} from "../../../web/src/settings-ui-config";

const PROVIDERS = SUPPORTED_PROVIDER_CONFIGS.map((entry) => entry.provider);

/** Deliberately absent from the wizard: gated, or key-less and handled apart. */
const NOT_IN_ONBOARDING = new Set(["openai-oauth", "workers-ai"]);

describe("web provider mirrors", () => {
  it.each(PROVIDERS)("%s is a known SettingsProvider in the SPA", (provider) => {
    expect(isSettingsProvider(provider)).toBe(true);
  });

  it.each(PROVIDERS)("%s is selectable in Settings", (provider) => {
    expect(SETTINGS_PROVIDER_OPTIONS.map((o) => o.value)).toContain(provider);
  });

  it.each(PROVIDERS)("%s has a model placeholder", (provider) => {
    expect(SETTINGS_PROVIDER_MODEL_PLACEHOLDERS[provider]).toBeTruthy();
  });

  it.each(PROVIDERS)("%s appears in onboarding unless deliberately withheld", (provider) => {
    const offered = ONBOARDING_PROVIDER_OPTIONS.some((o) => o.value === provider);
    expect(offered).toBe(!NOT_IN_ONBOARDING.has(provider));
  });

  it("recommends a provider the wizard actually offers", () => {
    expect(ONBOARDING_PROVIDER_OPTIONS.map((o) => o.value)).toContain(
      RECOMMENDED_ONBOARDING_PROVIDER,
    );
  });

  it("falls back to an ungated provider", () => {
    expect(NOT_IN_ONBOARDING.has(DEFAULT_PROVIDER)).toBe(false);
    expect(isSettingsProvider(DEFAULT_PROVIDER)).toBe(true);
  });
});
