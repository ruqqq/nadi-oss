import { describe, expect, it } from "vitest";
import { canUseProvider, isGatedProvider } from "../../../src/auth/provider-gate";

const DEFAULTS = {
  WORKERS_AI_EMAILS: "you@example.com, teammate@example.com",
};

describe("canUseProvider", () => {
  it("allows the allowlisted emails for workers-ai", () => {
    expect(canUseProvider(DEFAULTS, "workers-ai", "you@example.com")).toBe(true);
    expect(canUseProvider(DEFAULTS, "workers-ai", "teammate@example.com")).toBe(true);
  });

  it("denies everyone else for workers-ai", () => {
    expect(canUseProvider(DEFAULTS, "workers-ai", "someone@else.com")).toBe(false);
  });

  it("always allows openai-oauth (ungated; proxy is per-workspace)", () => {
    expect(canUseProvider(DEFAULTS, "openai-oauth", "you@example.com")).toBe(true);
    expect(canUseProvider(DEFAULTS, "openai-oauth", "someone@else.com")).toBe(true);
    expect(canUseProvider(DEFAULTS, "openai-oauth", "teammate@example.com")).toBe(true);
    expect(canUseProvider(DEFAULTS, "openai-oauth", null)).toBe(true);
    expect(canUseProvider(DEFAULTS, "openai-oauth", undefined)).toBe(true);
  });

  it("leaves every other provider ungated", () => {
    expect(canUseProvider(DEFAULTS, "anthropic", "someone@else.com")).toBe(true);
    expect(canUseProvider(DEFAULTS, "openai", null)).toBe(true);
    expect(canUseProvider(DEFAULTS, "opencode-go", undefined)).toBe(true);
  });

  it("matches case-insensitively and trims whitespace", () => {
    expect(canUseProvider(DEFAULTS, "workers-ai", "  YOU@Example.COM ")).toBe(true);
  });

  it("honours a bare domain entry as 'anyone at this domain'", () => {
    expect(canUseProvider({ WORKERS_AI_EMAILS: "exe.dev" }, "workers-ai", "a@exe.dev")).toBe(true);
    expect(canUseProvider({ WORKERS_AI_EMAILS: "exe.dev" }, "workers-ai", "a@other.dev")).toBe(
      false,
    );
  });

  it("opens the gate when the list is empty or the var is unset", () => {
    expect(canUseProvider({ WORKERS_AI_EMAILS: "" }, "workers-ai", "anyone@example.com")).toBe(
      true,
    );
    expect(canUseProvider({}, "workers-ai", "anyone@example.com")).toBe(true);
  });

  it("denies a missing email when the workers-ai list is non-empty", () => {
    expect(canUseProvider(DEFAULTS, "workers-ai", null)).toBe(false);
    expect(canUseProvider(DEFAULTS, "workers-ai", undefined)).toBe(false);
    expect(canUseProvider(DEFAULTS, "workers-ai", "")).toBe(false);
  });

  // The empty-list kill-switch must keep working even when there is no email to
  // evaluate — otherwise an owner-less path would still fail closed after the
  // operator cleared the var to open the provider up.
  it("allows a missing email when the list is empty", () => {
    expect(canUseProvider({ WORKERS_AI_EMAILS: "" }, "workers-ai", null)).toBe(true);
    expect(canUseProvider({}, "workers-ai", undefined)).toBe(true);
  });
});

describe("isGatedProvider", () => {
  it("recognises only the allowlisted providers", () => {
    expect(isGatedProvider("workers-ai")).toBe(true);
    expect(isGatedProvider("openai-oauth")).toBe(false);
    expect(isGatedProvider("openai")).toBe(false);
    expect(isGatedProvider("toString")).toBe(false);
  });
});
