import { describe, expect, it } from "vitest";
import { signGithubState, verifyGithubState } from "../../../src/github/state";

const secret = "client-secret-xyz";
const payload = { workspaceId: "ws1", userId: "u1", nonce: "n1", exp: 2_000 };

describe("github state token", () => {
  it("round-trips a valid, unexpired token", async () => {
    const token = await signGithubState(secret, payload);
    expect(await verifyGithubState(secret, token, 1_000)).toEqual(payload);
  });

  it("rejects an expired token", async () => {
    const token = await signGithubState(secret, payload);
    expect(await verifyGithubState(secret, token, 3_000)).toBeNull();
  });

  it("rejects a tampered token", async () => {
    const token = await signGithubState(secret, payload);
    const tampered = `${token.slice(0, -2)}xx`;
    expect(await verifyGithubState(secret, tampered, 1_000)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signGithubState("other", payload);
    expect(await verifyGithubState(secret, token, 1_000)).toBeNull();
  });

  it("rejects a validly-signed token missing required fields", async () => {
    const partial = await signGithubState(secret, { exp: 2_000 } as never);
    expect(await verifyGithubState(secret, partial, 1_000)).toBeNull();
  });
});
