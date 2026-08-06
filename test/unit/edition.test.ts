import { describe, expect, it } from "vitest";
import {
  editionCapabilities,
  platformCapabilities,
  resolveEdition,
  resolvePlatform,
} from "../../src/edition";

describe("resolveEdition", () => {
  it("falls to self-hosted when NADI_EDITION is unset", () => {
    expect(resolveEdition({})).toBe("self-hosted");
    expect(resolveEdition({ NADI_EDITION: undefined })).toBe("self-hosted");
  });

  it("reads cloud case- and whitespace-insensitively", () => {
    expect(resolveEdition({ NADI_EDITION: "cloud" })).toBe("cloud");
    expect(resolveEdition({ NADI_EDITION: "Cloud" })).toBe("cloud");
    expect(resolveEdition({ NADI_EDITION: "  CLOUD  " })).toBe("cloud");
  });

  it("treats an unrecognized or empty value as self-hosted, not cloud", () => {
    // The fall must stay toward showing operator config: a typo'd var must never
    // silently hide deployment settings from the self-hoster who has to fix it.
    for (const value of ["", "   ", "saas", "hosted", "1", "true", "self-hosted"]) {
      expect(resolveEdition({ NADI_EDITION: value })).toBe("self-hosted");
    }
  });
});

describe("editionCapabilities", () => {
  it("grants operatorManagedCompute only on cloud", () => {
    expect(editionCapabilities({ NADI_EDITION: "cloud" })).toEqual({
      operatorManagedCompute: true,
    });
    expect(editionCapabilities({})).toEqual({ operatorManagedCompute: false });
  });
});

describe("resolvePlatform", () => {
  it("falls to cloudflare when NADI_PLATFORM is unset", () => {
    // The safe fall points at the platform whose bindings are real: an unset
    // var must never disable a path Cloudflare actually has.
    expect(resolvePlatform({})).toBe("cloudflare");
    expect(resolvePlatform({ NADI_PLATFORM: undefined })).toBe("cloudflare");
  });

  it("reads celld case- and whitespace-insensitively", () => {
    expect(resolvePlatform({ NADI_PLATFORM: "celld" })).toBe("celld");
    expect(resolvePlatform({ NADI_PLATFORM: "Celld" })).toBe("celld");
    expect(resolvePlatform({ NADI_PLATFORM: "  CELLD  " })).toBe("celld");
  });

  it("treats an unrecognized or empty value as cloudflare, not celld", () => {
    // A typo'd var must not silently drop the managed bindings Cloudflare
    // actually has: degrade toward the compatibility target instead.
    for (const value of ["", "   ", "self-hosted", "local", "1", "true", "cloudflare"]) {
      expect(resolvePlatform({ NADI_PLATFORM: value })).toBe("cloudflare");
    }
  });

  it("never lets the platform axis change what resolveEdition returns", () => {
    // The two axes are independent: the same env tuple must produce the same
    // edition with or without the platform var.
    const base: { NADI_EDITION?: string; NADI_PLATFORM?: string } = { NADI_EDITION: "cloud" };
    const withCelld = { ...base, NADI_PLATFORM: "celld" };
    const withGarbage = { ...base, NADI_PLATFORM: "garbage" };
    expect(resolveEdition(withCelld)).toBe(resolveEdition(base));
    expect(resolveEdition(withGarbage)).toBe("cloud");
  });
});

describe("platformCapabilities", () => {
  it("grants hasManagedBindings and speechToText only on cloudflare", () => {
    expect(platformCapabilities({})).toEqual({ hasManagedBindings: true, speechToText: true });
    expect(platformCapabilities({ NADI_PLATFORM: "cloudflare" })).toEqual({
      hasManagedBindings: true,
      speechToText: true,
    });
    expect(platformCapabilities({ NADI_PLATFORM: "celld" })).toEqual({
      hasManagedBindings: false,
      speechToText: false,
    });
  });

  it("keeps speechToText tied to the platform, never to the voice flag", () => {
    // celld has no AI binding; VOICE_INPUT_ENABLED is a separate switch and
    // cannot grant the capability (the combined gate is voiceInputEnabled in
    // src/flags.ts). A voice flag does not even reach this function.
    expect(platformCapabilities({ NADI_PLATFORM: "celld" }).speechToText).toBe(false);
    expect(platformCapabilities({ NADI_PLATFORM: "cloudflare" }).speechToText).toBe(true);
  });
});
