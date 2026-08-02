import { describe, expect, it } from "vitest";
import { parseRepositoryEntries } from "../../../src/http/workbench-routes";

function validEntry(overrides: Record<string, unknown> = {}) {
  return {
    source: "github",
    name: "nadi",
    url: "https://github.com/acme/nadi.git",
    githubRepoId: 123,
    sourceInstallationId: "ghi_1",
    checkoutPathName: "nadi",
    defaultBranch: "main",
    rootDirectory: "",
    setupCommand: "",
    packageManager: "",
    ...overrides,
  };
}

describe("parseRepositoryEntries", () => {
  it("accepts a valid array of repository entries", () => {
    const result = parseRepositoryEntries([validEntry()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      {
        source: "github",
        name: "nadi",
        url: "https://github.com/acme/nadi.git",
        checkoutPathName: "nadi",
        defaultBranch: "main",
        rootDirectory: "",
        setupCommand: "",
        packageManager: "",
        sourceInstallationId: "ghi_1",
        githubRepoId: 123,
      },
    ]);
  });

  it("accepts an empty array", () => {
    const result = parseRepositoryEntries([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("defaults optional fields when omitted", () => {
    const {
      githubRepoId: _githubRepoId,
      sourceInstallationId: _sourceInstallationId,
      ...rest
    } = validEntry();
    const result = parseRepositoryEntries([rest]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.githubRepoId).toBeNull();
    expect(result.value[0]?.sourceInstallationId).toBeNull();
  });

  it("rejects a non-array body", () => {
    const result = parseRepositoryEntries({ repositoryIds: ["a"] });
    expect(result.ok).toBe(false);
  });

  it("rejects an entry with an invalid source", () => {
    const result = parseRepositoryEntries([validEntry({ source: "ftp" })]);
    expect(result.ok).toBe(false);
  });

  it("rejects an entry missing a required field", () => {
    const result = parseRepositoryEntries([validEntry({ name: "" })]);
    expect(result.ok).toBe(false);
  });

  it("rejects an entry with a non-numeric githubRepoId", () => {
    const result = parseRepositoryEntries([validEntry({ githubRepoId: "123" })]);
    expect(result.ok).toBe(false);
  });
});
