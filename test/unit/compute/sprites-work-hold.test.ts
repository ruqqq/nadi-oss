import { describe, expect, it } from "vitest";
import { SpritesComputeBackend } from "../../../src/compute/backends/sprites";
import { createSpritesClient } from "../../../src/compute/backends/sprites-client";

const backend = new SpritesComputeBackend({ client: createSpritesClient({ apiKey: "k" }) });

describe("sprites workHold", () => {
  it("declares hold fragments that target the in-sprite management socket", () => {
    const hold = backend.workHold;
    expect(hold).toBeDefined();
    const acquire = hold!.acquire("nadi-work-abc");
    expect(acquire).toContain("--unix-socket /.sprite/api.sock");
    expect(acquire).toContain("http://sprite/v1/tasks");
    expect(acquire).toContain('"name":"nadi-work-abc"');
    expect(acquire).toContain('"expire":"5m"');
  });

  it("refreshes by PUT and releases by DELETE on the named task", () => {
    const hold = backend.workHold!;
    expect(hold.refresh("nadi-work-abc")).toMatch(/-X PUT .*\/v1\/tasks\/nadi-work-abc/);
    expect(hold.release("nadi-work-abc")).toMatch(/-X DELETE .*\/v1\/tasks\/nadi-work-abc/);
  });
});
