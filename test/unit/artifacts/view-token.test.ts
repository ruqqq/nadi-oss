import { describe, expect, it } from "vitest";
import {
  deriveArtifactViewSecret,
  signArtifactViewToken,
  verifyArtifactViewToken,
} from "../../../src/artifacts/view-token";

const betterAuthSecret = "better-auth-secret-xyz";
const payload = { artifactId: "art_123", exp: 2_000 };

describe("artifact view token", () => {
  it("derives a stable signing secret from BETTER_AUTH_SECRET", async () => {
    const a = await deriveArtifactViewSecret(betterAuthSecret);
    const b = await deriveArtifactViewSecret(betterAuthSecret);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("round-trips a valid, unexpired token", async () => {
    const secret = await deriveArtifactViewSecret(betterAuthSecret);
    const token = await signArtifactViewToken(secret, payload);
    expect(await verifyArtifactViewToken(secret, token, 1_000)).toEqual(payload);
  });

  it("rejects an expired token", async () => {
    const secret = await deriveArtifactViewSecret(betterAuthSecret);
    const token = await signArtifactViewToken(secret, payload);
    expect(await verifyArtifactViewToken(secret, token, 3_000)).toBeNull();
  });

  it("rejects a tampered token", async () => {
    const secret = await deriveArtifactViewSecret(betterAuthSecret);
    const token = await signArtifactViewToken(secret, payload);
    const tampered = `${token.slice(0, -2)}xx`;
    expect(await verifyArtifactViewToken(secret, tampered, 1_000)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const secret = await deriveArtifactViewSecret(betterAuthSecret);
    const other = await deriveArtifactViewSecret("other-secret");
    const token = await signArtifactViewToken(other, payload);
    expect(await verifyArtifactViewToken(secret, token, 1_000)).toBeNull();
  });

  it("rejects a validly-signed token missing required fields", async () => {
    const secret = await deriveArtifactViewSecret(betterAuthSecret);
    const partial = await signArtifactViewToken(secret, { exp: 2_000 } as never);
    expect(await verifyArtifactViewToken(secret, partial, 1_000)).toBeNull();
  });
});
