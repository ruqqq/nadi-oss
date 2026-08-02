import { describe, expect, it } from "vitest";
import {
  resolveInterpreter,
  UnsupportedInterpreterError,
} from "../../../src/agent/skills/interpreter";

describe("resolveInterpreter", () => {
  it("maps known extensions", () => {
    expect(resolveInterpreter("scripts/run.py").interpreter).toBe("python3");
    expect(resolveInterpreter("run.sh").interpreter).toBe("bash");
    expect(resolveInterpreter("a/b/run.js").interpreter).toBe("node");
    expect(resolveInterpreter("run.mjs").interpreter).toBe("node");
  });

  it("throws on unknown or missing extension", () => {
    expect(() => resolveInterpreter("run.rb")).toThrow(UnsupportedInterpreterError);
    expect(() => resolveInterpreter("noext")).toThrow(UnsupportedInterpreterError);
  });
});
