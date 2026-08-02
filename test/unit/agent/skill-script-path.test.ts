import { describe, expect, it } from "vitest";
import {
  assertValidSkillScriptPath,
  isValidSkillScriptPath,
} from "../../../src/agent/skills/script-path";

describe("skill script path validation", () => {
  it("accepts the paths the SDK will actually run", () => {
    for (const path of ["scripts/run.py", "scripts/main.sh", "scripts/nested/tool.js"]) {
      expect(isValidSkillScriptPath(path)).toBe(true);
    }
  });

  // The real value seen in production: 15 imported superpowers skills were stored
  // with `path: "none"`, `content: "# no script"`. The SDK refuses anything outside
  // scripts/, so they advertised a script that could never run — and a stored script
  // is what opens the run_skill_script gate.
  it('rejects the "none" placeholder that broke production', () => {
    expect(isValidSkillScriptPath("none")).toBe(false);
    expect(() => assertValidSkillScriptPath("none")).toThrow(/scripts\//);
  });

  it("rejects paths outside scripts/, and traversal out of it", () => {
    for (const path of [
      "run.py", // no prefix at all
      "/scripts/run.py", // absolute
      "scripts/", // prefix with nothing after it
      "scripts/../escape.py", // climbs out
      "scripts/./run.py", // dot segment
      "scripts//run.py", // empty segment
      "Scripts/run.py", // case matters to the SDK
    ]) {
      expect(isValidSkillScriptPath(path), path).toBe(false);
    }
  });
});
