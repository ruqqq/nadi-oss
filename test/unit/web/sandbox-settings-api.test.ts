import { describe, expect, it, vi } from "vitest";
import type { ComputeSettingsView } from "../../../src/compute/settings";
import {
  clearDaytonaOverride,
  clearSpritesOverride,
  getSandboxSettings,
  saveDaytonaSecret,
  saveSpritesSecret,
  saveWorkspaceSandboxSettings,
  type SandboxSettingsResponse,
} from "../../../web/src/sandbox-settings-api";

/**
 * Compile-time wire contract: whatever GET /api/settings/sandbox actually returns
 * must be readable through the types the SPA declares. The two sides are declared
 * independently, so without this a server-side rename type-checks on both ends and
 * only fails in the browser — which is exactly how the provider-neutral compute
 * refactor shipped a crashing settings page.
 *
 * This structurally covers the `readiness` field too: drop or rename a readiness
 * member on the server `ComputeSettingsView` and this assignment stops compiling.
 *
 * Enforced by the root `pnpm run typecheck` (test/unit/web is in its project).
 */
const _wireContract = (view: ComputeSettingsView): SandboxSettingsResponse => view;
void _wireContract;

describe("sandbox settings api", () => {
  it("loads sandbox settings", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        workspace: null,
        agent: null,
        daytonaSecretPresent: false,
        workspaceSecretEnvVars: [],
        agentSecretEnvVars: [],
        effective: { enabled: false },
      }),
    ) as never;
    await getSandboxSettings(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("/api/settings/sandbox", { credentials: "include" });
  });

  it("round-trips a workspace and agent profile through the response types", async () => {
    const body: SandboxSettingsResponse = {
      workspace: {
        enabled: true,
        provider: "daytona",
        providerConfig: {
          kind: "daytona",
          apiKeySecretName: "sandbox:daytona",
          apiUrl: null,
          target: null,
          profiles: {
            small: { kind: "snapshot", value: "nadi-small" },
            medium: { kind: "image", value: "daytonaio/sandbox:latest" },
          },
        },
        idleTimeoutMs: 900000,
        recoveryTtlMs: 86400000,
        maxProcessRuntimeMs: 600000,
        networkRestrictionEnabled: true,
        networkDomainAllowlist: "a.com,b.com",
        envVars: {},
      },
      agent: {
        enabled: null,
        idleTimeoutMs: null,
        maxProcessRuntimeMs: null,
        networkDomainAllowlist: "c.com",
        envVars: null,
      },
      daytonaMode: "byok",
      daytonaAvailable: true,
      daytonaSecretPresent: true,
      spritesMode: "byok",
      spritesAvailable: true,
      spritesSecretPresent: true,
      workspaceSecretEnvVars: [],
      agentSecretEnvVars: [],
      readiness: {
        daytona: { provider: "daytona", ready: true, missingConfig: [], unsupported: [] },
        cloudflare: {
          provider: "cloudflare",
          ready: false,
          missingConfig: ["NADI_SANDBOX_SMALL", "BACKUP_BUCKET"],
          unsupported: ["network_restrictions"],
        },
        sprites: { provider: "sprites", ready: true, missingConfig: [], unsupported: [] },
      },
      effective: {
        enabled: true,
        value: { resourceProfile: "medium", allowedHosts: ["a.com", "b.com", "c.com"] },
      },
    };
    const fetchImpl = vi.fn(async () => Response.json(body)) as never;
    const result = await getSandboxSettings(fetchImpl);
    const config = result.workspace?.providerConfig;
    expect(config?.kind === "daytona" && config.profiles.small).toEqual({
      kind: "snapshot",
      value: "nadi-small",
    });
    expect(result.agent).not.toHaveProperty("resourceProfile");
    expect(result.workspace).not.toHaveProperty("defaultProfile");
    expect(result.workspace?.networkDomainAllowlist).toBe("a.com,b.com");
    expect(result.effective.value?.allowedHosts).toEqual(["a.com", "b.com", "c.com"]);
    // Readiness is a distinct, provider-keyed verdict: missing config vs an
    // unsupported capability stay separate all the way to the browser.
    expect(result.readiness.daytona.ready).toBe(true);
    expect(result.readiness.cloudflare.ready).toBe(false);
    expect(result.readiness.cloudflare.missingConfig).toEqual([
      "NADI_SANDBOX_SMALL",
      "BACKUP_BUCKET",
    ]);
    expect(result.readiness.cloudflare.unsupported).toEqual(["network_restrictions"]);
  });

  it("sends network restriction fields in the workspace PUT body", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        workspace: null,
        agent: null,
        daytonaSecretPresent: false,
        workspaceSecretEnvVars: [],
        agentSecretEnvVars: [],
        effective: { enabled: false },
      }),
    ) as never;
    await saveWorkspaceSandboxSettings(
      { networkRestrictionEnabled: true, networkDomainAllowlist: "a.com" },
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/settings/sandbox",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ networkRestrictionEnabled: true, networkDomainAllowlist: "a.com" }),
      }),
    );
  });

  it("saves Daytona secret without exposing it in URLs", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        workspace: null,
        agent: null,
        daytonaSecretPresent: true,
        workspaceSecretEnvVars: [],
        agentSecretEnvVars: [],
        effective: { enabled: false },
      }),
    ) as never;
    await saveDaytonaSecret({ value: "dt_test", secretName: "sandbox:daytona" }, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/settings/sandbox/daytona-secret",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ value: "dt_test", secretName: "sandbox:daytona" }),
      }),
    );
  });

  it("clears the Daytona override with a credentialed DELETE", async () => {
    const body = {
      workspace: null,
      agent: null,
      daytonaMode: "system" as const,
      daytonaAvailable: true,
      daytonaSecretPresent: false,
      workspaceSecretEnvVars: [],
      agentSecretEnvVars: [],
      effective: { enabled: false },
    };
    const fetchImpl = vi.fn(async () => Response.json(body)) as never;

    expect(await clearDaytonaOverride(fetchImpl)).toEqual(body);
    expect(fetchImpl).toHaveBeenCalledWith("/api/settings/sandbox/daytona-secret", {
      method: "DELETE",
      credentials: "include",
    });
  });

  it("uses an action-specific error when resetting Daytona configuration fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 })) as never;

    await expect(clearDaytonaOverride(fetchImpl)).rejects.toThrow(
      "Something went wrong while trying to reset Daytona configuration. Please try again.",
    );
  });

  it("saves Sprites secret without exposing it in URLs", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        workspace: null,
        agent: null,
        spritesSecretPresent: true,
        workspaceSecretEnvVars: [],
        agentSecretEnvVars: [],
        effective: { enabled: false },
      }),
    ) as never;
    await saveSpritesSecret({ value: "sprites_test", secretName: "sandbox:sprites" }, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/settings/sandbox/sprites-secret",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ value: "sprites_test", secretName: "sandbox:sprites" }),
      }),
    );
  });

  it("clears the Sprites override with a credentialed DELETE", async () => {
    const body = {
      workspace: null,
      agent: null,
      spritesMode: "system" as const,
      spritesAvailable: true,
      spritesSecretPresent: false,
      workspaceSecretEnvVars: [],
      agentSecretEnvVars: [],
      effective: { enabled: false },
    };
    const fetchImpl = vi.fn(async () => Response.json(body)) as never;

    expect(await clearSpritesOverride(fetchImpl)).toEqual(body);
    expect(fetchImpl).toHaveBeenCalledWith("/api/settings/sandbox/sprites-secret", {
      method: "DELETE",
      credentials: "include",
    });
  });

  it("uses an action-specific error when resetting Sprites configuration fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 })) as never;

    await expect(clearSpritesOverride(fetchImpl)).rejects.toThrow(
      "Something went wrong while trying to reset Sprites configuration. Please try again.",
    );
  });
});
