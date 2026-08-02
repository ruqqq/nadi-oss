import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Pins the @cloudflare/sandbox package version to the container base image tag.
// The Worker client and in-container server speak a versioned protocol, so the
// two MUST agree. If a build breaks, fix the mismatch — do not bump one side
// to make this test pass.
describe("cloudflare sandbox image agreement", () => {
  it("pins the installed SDK version to the Dockerfile base image tag", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const dockerfile = readFileSync("container/Dockerfile", "utf8");

    expect(packageJson.dependencies["@cloudflare/sandbox"]).toBe("0.12.3");
    expect(dockerfile).toContain("FROM docker.io/cloudflare/sandbox:0.12.3-python");
  });

  it("bakes the curated tool manifest into the verify script", () => {
    const verifyScript = readFileSync("container/verify-tools.sh", "utf8");

    for (const tool of ["gh", "jq", "rg", "fd", "yq", "shellcheck", "pnpm", "yarn"]) {
      expect(verifyScript).toContain(tool);
    }
  });

  it("installs pnpm and yarn without corepack", () => {
    const dockerfile = readFileSync("container/Dockerfile", "utf8");
    const verifyScript = readFileSync("container/verify-tools.sh", "utf8");
    const daytonaSnapshotScript = readFileSync("scripts/create-daytona-snapshot.mjs", "utf8");

    expect(dockerfile).toContain("npm install -g pnpm@10 yarn@latest");
    expect(daytonaSnapshotScript).toContain(
      "npm install -g pnpm@${PNPM_VERSION} yarn@${YARN_VERSION}",
    );
    expect(`${dockerfile}\n${verifyScript}\n${daytonaSnapshotScript}`).not.toMatch(/\bcorepack\b/i);
  });
});
