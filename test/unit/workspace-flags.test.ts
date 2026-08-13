import { describe, expect, it } from "vitest";
import {
  anyBackgroundWorkEnabled,
  resolveWorkspaceBackgroundCapabilities,
  resolveWorkspaceWorkbenchNetworkAllowlist,
} from "../../src/flags";

const caps = (flagsJson: string, deploymentEnabled = false) =>
  resolveWorkspaceBackgroundCapabilities({ deploymentEnabled, flagsJson });

describe("resolveWorkspaceBackgroundCapabilities", () => {
  it("falls back to the deployment flag when nothing is set", () => {
    expect(caps("{}", false)).toEqual({ backgroundExec: false, subagents: false });
    expect(caps("{}", true)).toEqual({ backgroundExec: true, subagents: true });
    expect(caps('{"futureFlag":true}', true)).toEqual({ backgroundExec: true, subagents: true });
  });

  it("keeps the legacy backgroundWork key meaning BOTH", () => {
    // No migration: every workspace that opted in before the split keeps what it
    // had, including against an off deployment.
    expect(caps('{"backgroundWork":true}', false)).toEqual({
      backgroundExec: true,
      subagents: true,
    });
    expect(caps('{"backgroundWork":false}', true)).toEqual({
      backgroundExec: false,
      subagents: false,
    });
  });

  it("lets a specific key override the legacy one — the point of the split", () => {
    // Subagents on, backgrounded exec off. This is the shape a workspace writes
    // to get one capability without the other.
    expect(caps('{"backgroundWork":true,"backgroundExec":false}', false)).toEqual({
      backgroundExec: false,
      subagents: true,
    });
    // And the reverse.
    expect(caps('{"backgroundWork":true,"subagents":false}', false)).toEqual({
      backgroundExec: true,
      subagents: false,
    });
  });

  it("resolves each capability independently of the other", () => {
    expect(caps('{"subagents":true}', false)).toEqual({
      backgroundExec: false,
      subagents: true,
    });
    expect(caps('{"backgroundExec":true}', false)).toEqual({
      backgroundExec: true,
      subagents: false,
    });
  });

  it("fails closed on a non-boolean value rather than falling through", () => {
    // SQLite has no boolean: a value written as the integer 1 must NOT read as
    // enabled, and must not be treated as "unset" either — falling through would
    // silently promote it to the fallback, which is the opposite of failing
    // closed. (This is why the D1 update had to use `json('true')`.)
    expect(caps('{"subagents":1}', true)).toEqual({ backgroundExec: true, subagents: false });
    expect(caps('{"backgroundWork":"true"}', true)).toEqual({
      backgroundExec: false,
      subagents: false,
    });
    // A bad specific key does not fall back to a good legacy key.
    expect(caps('{"backgroundWork":true,"subagents":"yes"}', false)).toEqual({
      backgroundExec: true,
      subagents: false,
    });
  });

  it("fails closed on unparseable or non-object flags", () => {
    for (const flagsJson of ["bad", "[]", "null"]) {
      expect(caps(flagsJson, true)).toEqual({ backgroundExec: false, subagents: false });
    }
  });
});

describe("anyBackgroundWorkEnabled", () => {
  it("is true when EITHER capability is on — the dock's gate", () => {
    expect(anyBackgroundWorkEnabled({ backgroundExec: false, subagents: true })).toBe(true);
    expect(anyBackgroundWorkEnabled({ backgroundExec: true, subagents: false })).toBe(true);
    expect(anyBackgroundWorkEnabled({ backgroundExec: false, subagents: false })).toBe(false);
  });
});

describe("resolveWorkspaceWorkbenchNetworkAllowlist", () => {
  it.each([
    ['{"workbenchNetworkAllowlist":true}', true],
    ['{"workbenchNetworkAllowlist":false}', false],
    ["{}", false],
    ["not-json", false],
    ['{"workbenchNetworkAllowlist":"true"}', false],
  ])("resolves %s to %s", (flagsJson, expected) => {
    expect(resolveWorkspaceWorkbenchNetworkAllowlist(flagsJson)).toBe(expected);
  });
});
