import { describe, expect, it } from "vitest";
import {
  deriveCompletionSecret,
  signCompletionToken,
  verifyCompletionToken,
} from "../../../src/compute/completion-token";

describe("completion token", () => {
  it("round-trips a scoped payload", async () => {
    const secret = await deriveCompletionSecret("auth-secret");
    const token = await signCompletionToken(secret, {
      threadId: "t1",
      processId: "p1",
      exp: 2_000_000_000_000,
    });
    expect(await verifyCompletionToken(secret, token, 1_000)).toEqual({
      threadId: "t1",
      processId: "p1",
      exp: 2_000_000_000_000,
    });
  });

  it("rejects a tampered payload, a foreign secret, and an expired token", async () => {
    const secret = await deriveCompletionSecret("auth-secret");
    const other = await deriveCompletionSecret("different");
    const token = await signCompletionToken(secret, { threadId: "t1", processId: "p1", exp: 5_000 });
    expect(await verifyCompletionToken(other, token, 1_000)).toBeNull();
    expect(await verifyCompletionToken(secret, token, 6_000)).toBeNull();
    const [body, sig] = token.split(".");
    expect(await verifyCompletionToken(secret, `${body}x.${sig}`, 1_000)).toBeNull();
  });

  it("derives a secret that differs from the artifact-view secret for the same input", async () => {
    const { deriveArtifactViewSecret } = await import("../../../src/artifacts/view-token");
    expect(await deriveCompletionSecret("s")).not.toEqual(await deriveArtifactViewSecret("s"));
  });
});
