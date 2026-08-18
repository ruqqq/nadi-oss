import { describe, expect, it, vi } from "vitest";
import {
  resolveThreadModelSnapshotValue,
  type ThreadModelSnapshotTarget,
} from "../../../src/settings/thread-model-snapshot";

vi.mock("../../../src/settings/model-selection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/settings/model-selection")>()),
  isUsableProviderForWorkspace: vi.fn(async (_e, _w, provider: string) => provider !== "anthropic"),
}));

const target: ThreadModelSnapshotTarget = {
  workspaceId: "ws_1",
  provider: "openai",
  model: "gpt-5",
  modelInputModalities: JSON.stringify(["text"]),
  showReasoning: true,
  reasoningEffort: "medium",
  modelSupportsReasoning: true,
};

const env = {} as never;

describe("resolveThreadModelSnapshotValue", () => {
  it("returns the target unchanged for an empty body", async () => {
    const result = await resolveThreadModelSnapshotValue(env, target, {}, "a@b.com");
    expect(result).toEqual({
      ok: true,
      value: {
        provider: "openai",
        model: "gpt-5",
        modelInputModalities: ["text"],
        showReasoning: true,
        reasoningEffort: "medium",
        modelSupportsReasoning: true,
      },
    });
  });

  it("rejects a provider the workspace cannot use, by code not Response", async () => {
    const result = await resolveThreadModelSnapshotValue(
      env,
      target,
      { provider: "anthropic" },
      "a@b.com",
    );
    expect(result).toEqual({ ok: false, error: "provider_not_usable" });
  });

  it("rejects a blank model", async () => {
    const result = await resolveThreadModelSnapshotValue(env, target, { model: "   " }, "a@b.com");
    expect(result).toEqual({ ok: false, error: "invalid_model" });
  });

  it("rejects a non-object body", async () => {
    const result = await resolveThreadModelSnapshotValue(env, target, [], "a@b.com");
    expect(result).toEqual({ ok: false, error: "malformed_body" });
  });
});
