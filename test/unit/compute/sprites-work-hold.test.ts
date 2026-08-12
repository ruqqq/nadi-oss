import { describe, expect, it } from "vitest";
import { buildSpritesWrapper, SpritesComputeBackend } from "../../../src/compute/backends/sprites";
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

  it("acquires before the command, gates the refresher on the rc sentinel, and releases last", () => {
    const wrapper = buildSpritesWrapper({
      command: "make build",
      cwd: "/workspace",
      stdinPath: "/dev/null",
      processId: "abc",
      timeoutSecs: 600,
      hold: backend.workHold!,
    });
    const acquireAt = wrapper.indexOf("-X POST http://sprite/v1/tasks");
    const commandAt = wrapper.indexOf("make build");
    const releaseAt = wrapper.indexOf("-X DELETE");
    expect(acquireAt).toBeGreaterThan(-1);
    expect(acquireAt).toBeLessThan(commandAt);
    expect(releaseAt).toBeGreaterThan(commandAt);
    // The refresher must self-terminate on the rc sentinel: PUT is an upsert, so an
    // orphaned refresher would resurrect a released hold and pin the VM awake.
    expect(wrapper).toContain("while [ ! -f /tmp/.nadi-rc-abc ]");
    expect(wrapper).not.toMatch(/kill \$/);
  });

  it("refuses to background when the hold cannot be taken", () => {
    const wrapper = buildSpritesWrapper({
      command: "make build",
      cwd: "/workspace",
      stdinPath: "/dev/null",
      processId: "abc",
      timeoutSecs: 600,
      hold: backend.workHold!,
    });
    expect(wrapper).toContain("|| exit 97");
  });

  it("omits every hold fragment when the backend declares no workHold", () => {
    const wrapper = buildSpritesWrapper({
      command: "make build",
      cwd: "/workspace",
      stdinPath: "/dev/null",
      processId: "abc",
      timeoutSecs: 600,
    });
    expect(wrapper).not.toContain("/.sprite/api.sock");
    expect(wrapper).not.toContain("exit 97");
  });
});
