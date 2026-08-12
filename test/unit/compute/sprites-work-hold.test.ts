import { describe, expect, it } from "vitest";
import { buildSpritesWrapper, SpritesComputeBackend } from "../../../src/compute/backends/sprites";
import { createSpritesClient } from "../../../src/compute/backends/sprites-client";
import type { BackendProcessReference } from "../../../src/compute/backend";

const backend = new SpritesComputeBackend({ client: createSpritesClient({ apiKey: "k" }) });

/** A well-formed process reference for one hold id, as `startProcess` would eventually build it. */
function processRef(processId: string, sessionId = "1"): BackendProcessReference {
  return {
    provider: "sprites",
    version: 1,
    payload: { kind: "process", spriteName: "nadi-x", processId, sessionId },
  };
}

describe("sprites workHold", () => {
  it("declares hold fragments that target the in-sprite management socket", () => {
    const hold = backend.workHold;
    expect(hold).toBeDefined();
    const acquire = hold!.acquireFor(processRef("abc"));
    expect(acquire).toContain("--unix-socket /.sprite/api.sock");
    expect(acquire).toContain("http://sprite/v1/tasks");
    expect(acquire).toContain('"name":"nadi-work-abc"');
    expect(acquire).toContain('"expire":"5m"');
    // Unlike the command, these curls inherit the detached session's own
    // stdout/stderr, whose peer socket is closed right after `session_info` —
    // a write error there would make `curl -sf` exit non-zero.
    expect(acquire).toContain(">/dev/null 2>&1");
  });

  it("refreshes by PUT and releases by DELETE on the named task", () => {
    const hold = backend.workHold!;
    const ref = processRef("abc");
    expect(hold.refreshFor(ref)).toMatch(/-X PUT .*\/v1\/tasks\/nadi-work-abc/);
    expect(hold.releaseFor(ref)).toMatch(/-X DELETE .*\/v1\/tasks\/nadi-work-abc/);
  });

  it("targets the SAME hold id at release time that the wrapper embedded at acquire time", () => {
    // Regression for the round-1 defect: `buildSpritesWrapper` used to embed
    // one derivation of the hold id (via a raw `processId` string) while a
    // caller released a DIFFERENT one computed independently. Comparing a
    // derivation against itself can't catch that; this compares the id
    // embedded in the WRAPPER against the id the REAL `workHold.releaseFor`
    // computes for a reference carrying the same `processId` but otherwise
    // different values (spriteName/sessionId), so the match can only hold if
    // both paths key on `processId` alone, through the same code.
    const processId = "same-id-abc123";
    const wrapper = buildSpritesWrapper({
      command: "make build",
      cwd: "/workspace",
      stdinPath: "/dev/null",
      processId,
      timeoutSecs: 600,
      hold: backend.workHold!,
    });
    const realRef = processRef(processId, "some-other-session-42");
    const release = backend.workHold!.releaseFor(realRef);
    const holdId = release.match(/\/v1\/tasks\/(\S+?) >/)?.[1];
    expect(holdId).toBe(`nadi-work-${processId}`);
    expect(wrapper).toContain(`/v1/tasks/${holdId}`);
  });

  it("acquires before the command, gates the refresher on the rc sentinel via a self-check, and releases last", () => {
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
    const releaseAt = wrapper.lastIndexOf("-X DELETE");
    expect(acquireAt).toBeGreaterThan(-1);
    expect(acquireAt).toBeLessThan(commandAt);
    expect(releaseAt).toBeGreaterThan(commandAt);
    // The refresher must self-terminate on the rc sentinel: PUT is an upsert, so an
    // orphaned refresher would resurrect a released hold and pin the VM awake.
    expect(wrapper).toContain("while [ ! -f /tmp/.nadi-rc-abc ]");
    // Re-checks the sentinel immediately before each refresh (not just at the
    // top of the loop): without this, a refresh queued right as the command
    // finishes can land its `PUT` after the release `DELETE` that just ran.
    expect(wrapper).toContain("[ -f /tmp/.nadi-rc-abc ] && break");
    // One dropped curl must not kill the refresher outright (`|| break` would
    // let the hold lapse while the command keeps running) — it should retry
    // on the next tick instead.
    expect(wrapper).toMatch(/-X PUT[^;]*\|\| true/);
    expect(wrapper).not.toMatch(/kill \$/);
  });

  it("writes 97 to the rc sentinel (not a synchronous fallback) when the hold cannot be taken", () => {
    const wrapper = buildSpritesWrapper({
      command: "make build",
      cwd: "/workspace",
      stdinPath: "/dev/null",
      processId: "abc",
      timeoutSecs: 600,
      hold: backend.workHold!,
    });
    // 97 must be OBSERVABLE: written to the rc sentinel with the same
    // write-then-rename as every other exit, so a status poll reads it like
    // any other completed process, and the caller can tell the model "could
    // not background" as a real terminal instead of the process just vanishing.
    expect(wrapper).toContain(
      "|| { printf %s 97 > /tmp/.nadi-rc-abc.tmp && mv -f /tmp/.nadi-rc-abc.tmp /tmp/.nadi-rc-abc; exit 97; }",
    );
  });

  it("preserves the command's own exit status past the release curl", () => {
    const wrapper = buildSpritesWrapper({
      command: "make build",
      cwd: "/workspace",
      stdinPath: "/dev/null",
      processId: "abc",
      timeoutSecs: 600,
      hold: backend.workHold!,
    });
    // The release curl is the LAST command chained with `;`, so without an
    // explicit re-exit the wrapper's own exit status would be the release's,
    // not the command's.
    expect(wrapper.trimEnd().endsWith('exit "$__nadi_rc"')).toBe(true);
    expect(wrapper).toContain('__nadi_rc="$?"');
  });

  it("posts the completion after the rc write and before releasing the hold", () => {
    const wrapper = buildSpritesWrapper({
      command: "true",
      cwd: "/workspace",
      stdinPath: "/dev/null",
      processId: "abc",
      timeoutSecs: 600,
      hold: backend.workHold!,
      completionCallback:
        "curl -sf -m 25 -X POST https://app/api/compute/completion " +
        "-H 'Authorization: Bearer tok' -H 'Content-Type: application/json' " +
        '-d "{\\"processId\\":\\"abc\\",\\"exitCode\\":$NADI_EXIT_CODE}"',
    });
    const rcAt = wrapper.indexOf("mv -f /tmp/.nadi-rc-abc.tmp");
    const postAt = wrapper.indexOf("/api/compute/completion");
    const releaseAt = wrapper.indexOf("-X DELETE");
    expect(rcAt).toBeGreaterThan(-1);
    expect(postAt).toBeGreaterThan(-1);
    expect(releaseAt).toBeGreaterThan(-1);
    expect(rcAt).toBeLessThan(postAt);
    // Release LAST: delete the hold first and the VM can suspend mid-curl,
    // losing exactly the completion this design exists to deliver.
    expect(postAt).toBeLessThan(releaseAt);
    // Reads back the rc sentinel THIS wrapper just wrote, not a second
    // observation of `$?` — the callback fragment itself only ever
    // references `$NADI_EXIT_CODE`, an env var the wrapper sets from the
    // sentinel immediately before running it.
    expect(wrapper).toContain('NADI_EXIT_CODE="$(cat /tmp/.nadi-rc-abc)"');
  });

  it("omits the completion callback entirely when none is supplied", () => {
    const wrapper = buildSpritesWrapper({
      command: "true",
      cwd: "/workspace",
      stdinPath: "/dev/null",
      processId: "abc",
      timeoutSecs: 600,
      hold: backend.workHold!,
    });
    expect(wrapper).not.toContain("NADI_EXIT_CODE");
    expect(wrapper).not.toContain("/api/compute/completion");
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
    // Still preserves the exit-code re-assertion even without a hold — the
    // same wrapper shape either way.
    expect(wrapper.trimEnd().endsWith('exit "$__nadi_rc"')).toBe(true);
  });
});
