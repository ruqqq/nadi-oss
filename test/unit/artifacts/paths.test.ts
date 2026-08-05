import { describe, expect, it } from "vitest";
import { normalizeArtifactRelPath } from "../../../src/artifacts/paths";

describe("normalizeArtifactRelPath", () => {
  it("accepts a simple relative path", () => {
    expect(normalizeArtifactRelPath("index.html")).toBe("index.html");
    expect(normalizeArtifactRelPath("assets/app.js")).toBe("assets/app.js");
  });

  it("normalizes redundant segments", () => {
    expect(normalizeArtifactRelPath("./index.html")).toBe("index.html");
    expect(normalizeArtifactRelPath("assets/./style.css")).toBe("assets/style.css");
    expect(normalizeArtifactRelPath("a/b/../c.js")).toBe("a/c.js");
  });

  it("rejects parent traversal", () => {
    expect(normalizeArtifactRelPath("../x")).toBeNull();
    expect(normalizeArtifactRelPath("..")).toBeNull();
    expect(normalizeArtifactRelPath("assets/../../secret.txt")).toBeNull();
  });

  it("rejects absolute paths", () => {
    expect(normalizeArtifactRelPath("/index.html")).toBeNull();
  });

  it("rejects empty paths", () => {
    expect(normalizeArtifactRelPath("")).toBeNull();
  });

  it("rejects backslashes", () => {
    expect(normalizeArtifactRelPath("assets\\app.js")).toBeNull();
    expect(normalizeArtifactRelPath("..\\x")).toBeNull();
  });
});
