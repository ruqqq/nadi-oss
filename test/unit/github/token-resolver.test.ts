import { describe, expect, it, vi } from "vitest";
import { GithubInstallationGoneError } from "../../../src/github/app-client";
import { resolveGithubToken } from "../../../src/github/token-resolver";

const install = (over: Partial<any> = {}) => ({
  id: "ghi_1",
  workspaceId: "ws1",
  installationId: 42,
  accountLogin: "acme",
  accountType: "org",
  repositorySelection: "all",
  connectedByUserId: "u1",
  status: "active",
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe("resolveGithubToken", () => {
  it("injects a scoped GH_TOKEN for the covering installation", async () => {
    const client = {
      mintInstallationToken: vi.fn().mockResolvedValue({ token: "ghs_x", expiresAt: "" }),
    };
    const out = await resolveGithubToken({
      client: client as any,
      installations: [install()],
      repos: [{ owner: "acme", repo: "api" }],
      existingEnv: { FOO: "1" },
    });
    expect(out).toEqual({ FOO: "1", GH_TOKEN: "ghs_x" });
    expect(client.mintInstallationToken).toHaveBeenCalledWith(42, {
      repositories: ["api"],
      permissions: expect.objectContaining({
        contents: "write",
        metadata: "read",
        pull_requests: "write",
      }),
    });
  });

  it("requests the full PR-capable permission set", async () => {
    const client = {
      mintInstallationToken: vi.fn().mockResolvedValue({ token: "ghs_wide", expiresAt: "" }),
    };
    await resolveGithubToken({
      client: client as any,
      installations: [install()],
      repos: [{ owner: "acme", repo: "api" }],
      existingEnv: {},
    });
    expect(client.mintInstallationToken).toHaveBeenCalledWith(42, {
      repositories: ["api"],
      permissions: {
        contents: "write",
        metadata: "read",
        pull_requests: "write",
        workflows: "write",
        checks: "read",
        statuses: "read",
        actions: "read",
      },
    });
  });

  // An installation that predates the wider App grant can't mint the full set.
  // It must keep cloning, and must NOT be treated as revoked.
  it("falls back to clone-only permissions when the wide mint fails", async () => {
    const client = {
      mintInstallationToken: vi
        .fn()
        .mockRejectedValueOnce(new Error("github_mint_failed_422"))
        .mockResolvedValue({ token: "ghs_narrow", expiresAt: "" }),
    };
    const onInstallationGone = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const out = await resolveGithubToken({
      client: client as any,
      installations: [install()],
      repos: [{ owner: "acme", repo: "api" }],
      existingEnv: {},
      onInstallationGone,
      log,
    });
    expect(out.GH_TOKEN).toBe("ghs_narrow");
    expect(client.mintInstallationToken).toHaveBeenLastCalledWith(42, {
      repositories: ["api"],
      permissions: { contents: "write", metadata: "read" },
    });
    expect(onInstallationGone).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("pull requests"));
  });

  // THE regression guard. 403 is the status the mint client maps to
  // GithubInstallationGoneError, which marks the installation disconnected in
  // D1. If GitHub answers 403 (not the documented 422) for an ungranted
  // permission, interpreting the wide attempt's error would disconnect every
  // healthy installation on the first session after deploy.
  it("does not disconnect the installation when only the wide mint 403s", async () => {
    const client = {
      mintInstallationToken: vi
        .fn()
        .mockRejectedValueOnce(new GithubInstallationGoneError(42, 403))
        .mockResolvedValue({ token: "ghs_narrow", expiresAt: "" }),
    };
    const onInstallationGone = vi.fn().mockResolvedValue(undefined);
    const out = await resolveGithubToken({
      client: client as any,
      installations: [install()],
      repos: [{ owner: "acme", repo: "api" }],
      existingEnv: {},
      onInstallationGone,
      log: vi.fn(),
    });
    expect(out.GH_TOKEN).toBe("ghs_narrow");
    expect(onInstallationGone).not.toHaveBeenCalled();
  });

  it("never overrides a manual GH_TOKEN", async () => {
    const client = { mintInstallationToken: vi.fn() };
    const out = await resolveGithubToken({
      client: client as any,
      installations: [install()],
      repos: [{ owner: "acme", repo: "api" }],
      existingEnv: { GH_TOKEN: "manual" },
    });
    expect(out).toEqual({ GH_TOKEN: "manual" });
    expect(client.mintInstallationToken).not.toHaveBeenCalled();
  });

  it("logs and leaves env untouched when no installation covers the repo", async () => {
    const client = { mintInstallationToken: vi.fn() };
    const log = vi.fn();
    const out = await resolveGithubToken({
      client: client as any,
      installations: [install({ accountLogin: "other" })],
      repos: [{ owner: "acme", repo: "api" }],
      existingEnv: {},
      log,
    });
    expect(out).toEqual({});
    expect(client.mintInstallationToken).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it("picks the installation covering the most repos", async () => {
    const client = {
      mintInstallationToken: vi.fn().mockResolvedValue({ token: "ghs_y", expiresAt: "" }),
    };
    const out = await resolveGithubToken({
      client: client as any,
      installations: [install(), install({ id: "ghi_2", installationId: 7, accountLogin: "solo" })],
      repos: [
        { owner: "acme", repo: "api" },
        { owner: "acme", repo: "web" },
        { owner: "solo", repo: "tools" },
      ],
      existingEnv: {},
      log: vi.fn(),
    });
    expect(out.GH_TOKEN).toBe("ghs_y");
    expect(client.mintInstallationToken).toHaveBeenCalledWith(42, {
      repositories: ["api", "web"],
      permissions: expect.objectContaining({
        contents: "write",
        metadata: "read",
        pull_requests: "write",
      }),
    });
  });

  it("matches the installation's accountLogin case-insensitively against repo owner", async () => {
    const client = {
      mintInstallationToken: vi.fn().mockResolvedValue({ token: "ghs_z", expiresAt: "" }),
    };
    const out = await resolveGithubToken({
      client: client as any,
      installations: [install({ accountLogin: "acme" })],
      repos: [{ owner: "Acme", repo: "api" }],
      existingEnv: {},
    });
    expect(out.GH_TOKEN).toBe("ghs_z");
    expect(client.mintInstallationToken).toHaveBeenCalledWith(42, {
      repositories: ["api"],
      permissions: expect.objectContaining({
        contents: "write",
        metadata: "read",
        pull_requests: "write",
      }),
    });
  });

  it("marks the installation gone and skips injection on mint failure", async () => {
    const client = {
      mintInstallationToken: vi.fn().mockRejectedValue(new GithubInstallationGoneError(42, 404)),
    };
    const onInstallationGone = vi.fn().mockResolvedValue(undefined);
    const out = await resolveGithubToken({
      client: client as any,
      installations: [install()],
      repos: [{ owner: "acme", repo: "api" }],
      existingEnv: {},
      onInstallationGone,
      log: vi.fn(),
    });
    expect(out.GH_TOKEN).toBeUndefined();
    expect(onInstallationGone).toHaveBeenCalledWith(42);
  });
});
