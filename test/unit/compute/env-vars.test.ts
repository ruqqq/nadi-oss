import { describe, expect, it } from "vitest";
import {
  MAX_ENV_VAR_VALUE_BYTES,
  mergeComputeEnv,
  parseDotenv,
  parseEnvVarMap,
  parseEnvVarsJson,
  serializeEnvVarsJson,
  validateEnvVarName,
  validateEnvVarValue,
} from "../../../src/compute/env-vars";

describe("validateEnvVarName", () => {
  it("accepts POSIX-style names", () => {
    expect(validateEnvVarName("GH_TOKEN")).toBe("GH_TOKEN");
    expect(validateEnvVarName("  _x1 ")).toBe("_x1");
  });
  it("rejects leading digit, dashes, empty", () => {
    expect(() => validateEnvVarName("1BAD")).toThrow("sandbox_env_var_name_invalid");
    expect(() => validateEnvVarName("A-B")).toThrow("sandbox_env_var_name_invalid");
    expect(() => validateEnvVarName("")).toThrow("sandbox_env_var_name_invalid");
  });
});

describe("validateEnvVarValue", () => {
  it("rejects values over the byte cap", () => {
    expect(() => validateEnvVarValue("x".repeat(MAX_ENV_VAR_VALUE_BYTES + 1))).toThrow(
      "sandbox_env_var_value_too_large",
    );
  });
});

describe("parseEnvVarMap", () => {
  it("validates names/values and rejects non-objects", () => {
    expect(parseEnvVarMap({ A: "1", B: "2" })).toEqual({ A: "1", B: "2" });
    expect(() => parseEnvVarMap({ "1A": "x" })).toThrow("sandbox_env_var_name_invalid");
    expect(() => parseEnvVarMap({ A: 5 })).toThrow("sandbox_env_vars_invalid");
    expect(() => parseEnvVarMap("nope")).toThrow("sandbox_env_vars_invalid");
  });
  it("enforces the count cap", () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 65; i++) big[`V${i}`] = "1";
    expect(() => parseEnvVarMap(big)).toThrow("sandbox_env_vars_too_many");
  });
});

describe("parseDotenv", () => {
  it("parses KEY=VALUE, skips comments/blanks, strips quotes, first = wins", () => {
    const text = ["# comment", "", "GH_TOKEN=abc", 'URL="https://x/y=z"', "K = v "].join("\n");
    expect(parseDotenv(text)).toEqual({ GH_TOKEN: "abc", URL: "https://x/y=z", K: "v" });
  });
  it("rejects invalid names in the paste", () => {
    expect(() => parseDotenv("1BAD=x")).toThrow("sandbox_env_var_name_invalid");
  });
});

describe("parseEnvVarsJson / serializeEnvVarsJson", () => {
  it("round-trips and tolerates malformed stored JSON", () => {
    const json = serializeEnvVarsJson({ A: "1" });
    expect(parseEnvVarsJson(json)).toEqual({ A: "1" });
    expect(parseEnvVarsJson(null)).toEqual({});
    expect(parseEnvVarsJson("{not json")).toEqual({});
  });
});

describe("mergeComputeEnv", () => {
  it("later maps override earlier ones and undefined is skipped", () => {
    expect(mergeComputeEnv({ A: "1", B: "2" }, undefined, { B: "9", C: "3" })).toEqual({
      A: "1",
      B: "9",
      C: "3",
    });
  });
});
