import { describe, expect, it } from "vitest";
import { parseGithubRepoRef } from "../../../src/github/repo-url";

describe("parseGithubRepoRef", () => {
  it("parses owner/repo from an https github url", () => {
    expect(parseGithubRepoRef("https://github.com/acme/api")).toEqual({
      owner: "acme",
      repo: "api",
    });
  });
  it("strips a trailing .git", () => {
    expect(parseGithubRepoRef("https://github.com/acme/api.git")).toEqual({
      owner: "acme",
      repo: "api",
    });
  });
  it("returns null for non-github or malformed urls", () => {
    expect(parseGithubRepoRef("https://gitlab.com/a/b")).toBeNull();
    expect(parseGithubRepoRef("https://github.com/acme")).toBeNull();
    expect(parseGithubRepoRef("not a url")).toBeNull();
  });
});
