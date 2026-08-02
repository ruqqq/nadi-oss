import { describe, expect, it } from "vitest";
import {
  resolveWorkspaceBackgroundWork,
  resolveWorkspaceWorkbenchNetworkAllowlist,
} from "../../src/flags";

describe("resolveWorkspaceBackgroundWork", () => {
  it.each([
    [{ deploymentEnabled: false, flagsJson: "{}" }, false],
    [{ deploymentEnabled: true, flagsJson: "{}" }, true],
    [{ deploymentEnabled: false, flagsJson: '{"backgroundWork":true}' }, true],
    [{ deploymentEnabled: true, flagsJson: '{"backgroundWork":false}' }, false],
    [{ deploymentEnabled: true, flagsJson: "bad" }, false],
    [{ deploymentEnabled: true, flagsJson: "[]" }, false],
    [{ deploymentEnabled: true, flagsJson: "null" }, false],
    [{ deploymentEnabled: true, flagsJson: '{"backgroundWork":"true"}' }, false],
    [{ deploymentEnabled: true, flagsJson: '{"futureFlag":true}' }, true],
  ])("resolves %j to %s", (input, expected) => {
    expect(resolveWorkspaceBackgroundWork(input)).toBe(expected);
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
