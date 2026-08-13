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
    // The refresher is never SIGNALLED by the wrapper (that is what the
    // sentinel gate replaces) — `kill -0` below is a liveness probe pointing
    // the other way, at the wrapper, and sends nothing.
    expect(wrapper).not.toMatch(/kill (?!-0\b)/);
  });

  it("stops the refresher when the wrapper dies, watching its OWN pid and not $PPID", () => {
    const wrapper = buildSpritesWrapper({
      command: "make build",
      cwd: "/workspace",
      stdinPath: "/dev/null",
      processId: "abc",
      timeoutSecs: 600,
      hold: backend.workHold!,
    });
    // Without this guard a wrapper killed before writing rc leaves the
    // refresher re-`PUT`ting the hold every 60s for ~24h of awake billing:
    // nothing else reaps it (measured — see `buildSpritesWrapper`'s doc).
    expect(wrapper).toContain('kill -0 "$__nadi_parent" 2>/dev/null || break');
    // `$$` captured OUTSIDE the subshell, so the variable holds the WRAPPER's
    // pid. `$PPID` read inside a backgrounded subshell names the wrapper's
    // parent instead — a guard on that watches a process that outlives the
    // wrapper and never fires, which is the whole reason this assertion is
    // pinned to the exact expansion rather than "mentions kill -0".
    expect(wrapper).toContain('__nadi_parent="$$"; (');
    expect(wrapper).not.toContain("PPID");
    // Ahead of the refresh, so a dead wrapper costs at most one more tick...
    const guardAt = wrapper.indexOf("kill -0");
    const refreshAt = wrapper.indexOf("-X PUT");
    expect(guardAt).toBeLessThan(refreshAt);
    // ...and after the rc re-check, so a clean finish still exits on the
    // sentinel rather than depending on process liveness at all.
    expect(wrapper.indexOf("[ -f /tmp/.nadi-rc-abc ] && break")).toBeLessThan(guardAt);
  });

  it("caps the refresher at the command's own runtime plus two ticks", () => {
    // Covers what `kill -0` cannot: pid reuse handing the guard a live
    // stranger, and a wrapper that survives while rc never lands.
    const wrapper = buildSpritesWrapper({
      command: "make build",
      cwd: "/workspace",
      stdinPath: "/dev/null",
      processId: "abc",
      timeoutSecs: 600,
      hold: backend.workHold!,
    });
    // 600s of `timeout` = 10 ticks, +2 spare. Derived from timeoutSecs, NOT a
    // constant: a cap below the command's own runtime would drop the hold out
    // from under a legitimately running command.
    expect(wrapper).toContain('[ "$__nadi_ticks" -gt 12 ] && break');
    const short = buildSpritesWrapper({
      command: "true",
      cwd: "/workspace",
      stdinPath: "/dev/null",
      processId: "abc",
      timeoutSecs: 30,
      hold: backend.workHold!,
    });
    expect(short).toContain('[ "$__nadi_ticks" -gt 3 ] && break');
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

describe("sprites buildBackstopProbe", () => {
  // Tests the REAL `SpritesComputeBackend.buildBackstopProbe`, not a
  // lookalike: a hand-rolled copy would agree with whatever a caller-side
  // test asserts by construction, which is exactly how the first,
  // unconditional-acquire version of this probe passed review.

  it("reports the rc sentinel via a MARKED line when it exists, and does not reassert the hold", () => {
    const probe = backend.buildBackstopProbe!(processRef("abc"));
    expect(probe).toContain("if [ -f /tmp/.nadi-rc-abc ]");
    expect(probe).toContain("then printf 'nadi-rc:%s\\n'");
    expect(probe).toContain('"$(cat /tmp/.nadi-rc-abc');
    // The then-branch (rc found) must not also acquire the hold — a finished
    // process already released its own hold, and reasserting one nothing
    // will ever release again bills an idle VM awake for no reason.
    const thenBranch = probe.slice(probe.indexOf("then"), probe.indexOf("else"));
    expect(thenBranch).not.toContain("/v1/tasks");
  });

  it("reasserts the hold ONLY in the else branch (no rc yet)", () => {
    const probe = backend.buildBackstopProbe!(processRef("abc"));
    const elseBranch = probe.slice(probe.indexOf("else"));
    expect(elseBranch).toContain("-X POST");
    expect(elseBranch).toContain('"name":"nadi-work-abc"');
    // `acquireFor` 409s when the hold already exists; that must be swallowed
    // here too, same as the wrapper's own acquire.
    expect(elseBranch).toMatch(/\|\| true; fi\s*$/);
  });

  it("orders if / then-report / else-reassert / fi correctly", () => {
    const probe = backend.buildBackstopProbe!(processRef("abc"));
    const ifAt = probe.indexOf("if [ -f");
    const thenAt = probe.indexOf("then printf");
    const elseAt = probe.indexOf("else");
    const fiAt = probe.lastIndexOf("fi");
    expect(ifAt).toBeGreaterThanOrEqual(0);
    expect(ifAt).toBeLessThan(thenAt);
    expect(thenAt).toBeLessThan(elseAt);
    expect(elseAt).toBeLessThan(fiAt);
  });

  it("targets the SAME hold id the wrapper embedded and workHold.releaseFor computes", () => {
    // Same regression shape as the wrapper's own "same hold id" test: the
    // probe's acquire must key on the same `processId`-derived id as every
    // other hold fragment for this process, not a second derivation.
    const processId = "same-id-probe-1";
    const probe = backend.buildBackstopProbe!(processRef(processId, "some-other-session"));
    const release = backend.workHold!.releaseFor(processRef(processId, "yet-another-session"));
    const holdId = release.match(/\/v1\/tasks\/(\S+?) >/)?.[1];
    expect(holdId).toBe(`nadi-work-${processId}`);
    expect(probe).toContain(`"name":"${holdId}"`);
  });
});
