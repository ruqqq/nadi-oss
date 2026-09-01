import { describe, expect, it } from "vitest";
import { mergeSecretValuesIntoEnv, resolveComputeEnvVars } from "../../../src/compute/env-resolve";
import { resolveEffectiveComputeConfig } from "../../../src/compute/config";
import { packB64 } from "../../../src/secrets";
import type { Env } from "../../../src/env";
import type {
  AgentComputeSettings,
  EffectiveComputeConfig,
  WorkspaceComputeSettings,
} from "../../../src/compute/types";

describe("mergeSecretValuesIntoEnv", () => {
  it("layers editable, then workspace secrets, then agent secrets (agent wins)", () => {
    const result = mergeSecretValuesIntoEnv({
      workspaceEditable: { NODE_ENV: "prod", SHARED: "editable" },
      agentEditable: {},
      workspaceSecrets: { GH_TOKEN: "ws", SHARED: "wsSecret" },
      agentSecrets: { GH_TOKEN: "agent" },
    });
    expect(result).toEqual({ NODE_ENV: "prod", SHARED: "wsSecret", GH_TOKEN: "agent" });
  });

  // The `environment` layer that used to sit between workspace and agent is
  // gone: the agent carries what it carried now, so it was the same values in
  // two slots. What remains is four layers, and the ordering rules that mattered
  // — secrets over editable, agent over workspace — are unchanged.
  it("layers agent over workspace, and secrets over editable", () => {
    const merged = mergeSecretValuesIntoEnv({
      workspaceEditable: { A: "ws-e", W: "ws-e", P: "ws-e" },
      agentEditable: { A: "ag-e", P: "ag-e", Q: "ag-e" },
      workspaceSecrets: { A: "ws-s", S: "ws-s" },
      agentSecrets: { A: "ag-s" },
    });
    expect(merged.A).toBe("ag-s"); // agent secret beats ws secret and all editable
    expect(merged.W).toBe("ws-e");
    expect(merged.S).toBe("ws-s");
    // Editable-tier ordering, isolated from any secret layer:
    expect(merged.P).toBe("ag-e"); // agent editable beats ws editable (no secret for P)
    expect(merged.Q).toBe("ag-e");
  });
});

describe("resolveEffectiveComputeConfig (resource profile)", () => {
  const baseInput = {
    workspace: {
      enabled: true,
      provider: "daytona",
      providerConfig: {
        kind: "daytona",
        apiKeySecretName: "s",
        apiUrl: null,
        target: null,
        profiles: {
          small: { kind: "snapshot", value: "small-ok" },
          medium: { kind: "snapshot", value: "medium-ok" },
        },
      },
      idleTimeoutMs: 900_000,
      recoveryTtlMs: 86_400_000,
      maxProcessRuntimeMs: 600_000,
      limits: {
        tailMaxLines: 1,
        tailMaxBytes: 1,
        grepMaxMatches: 1,
        grepMaxContextLines: 1,
        grepMaxReturnedLines: 1,
        grepMaxBytes: 1,
        readMaxLines: 1,
        readMaxBytes: 1,
        maxProcessOutputBytes: 1,
        maxThreadOutputBytes: 1,
        maxUploadBytes: 1,
        maxDownloadBytes: 1,
      },
      networkRestrictionEnabled: false,
      networkDomainAllowlist: "",
      envVars: {},
    } satisfies WorkspaceComputeSettings,
    agent: {
      sandboxEnabled: true,
      agentEnabled: true,
      archivedAt: null,
      idleTimeoutMs: null,
      maxProcessRuntimeMs: null,
      networkDomainAllowlist: null,
      envVars: null,
    } satisfies AgentComputeSettings,
    daytonaCredentialPresent: true,
    daytonaProfiles: {
      small: { kind: "snapshot" as const, value: "small-ok" },
      medium: { kind: "snapshot" as const, value: "medium-ok" },
    },
  };

  // The defect: `AgentComputeSettings.enabled` was populated from
  // `agents.sandbox_enabled`, so the "is this agent off?" check read a
  // DIFFERENT COLUMN. Disabling an agent left every live thread of its holding
  // a full sandbox while the UI said "Turn this off to stop the agent from
  // running". They are separate settings and BOTH must withhold the machine.
  it.each([
    ["the agent's own switch is off", { agentEnabled: false }],
    ["the agent is deleted", { archivedAt: 1_800_000_000_000 }],
    ["the agent works without a machine", { sandboxEnabled: false }],
  ])("gives no compute when %s", (_label, patch) => {
    const result = resolveEffectiveComputeConfig({
      ...baseInput,
      agent: { ...baseInput.agent, ...patch },
      agentResourceProfile: "small",
    });
    expect(result).toEqual({ enabled: false, reason: "disabled" });
  });

  it("still gives compute to an enabled, undeleted agent with sandbox on", () => {
    const result = resolveEffectiveComputeConfig({
      ...baseInput,
      agentResourceProfile: "small",
    });
    expect(result.enabled).toBe(true);
  });

  it("takes the resource profile from the thread's agent", () => {
    const result = resolveEffectiveComputeConfig({
      ...baseInput,
      agentResourceProfile: "medium",
    });
    expect(result.enabled).toBe(true);
    expect(result.enabled && result.value.resourceProfile).toBe("medium");
  });

  it("falls back to small when the snapshot predates the profile column", () => {
    const result = resolveEffectiveComputeConfig({
      ...baseInput,
      agentResourceProfile: null,
    });
    expect(result.enabled && result.value.resourceProfile).toBe("small");
  });

  it("validates the source of the agent's profile, not the default", () => {
    const result = resolveEffectiveComputeConfig({
      ...baseInput,
      workspace: {
        ...baseInput.workspace,
        providerConfig: {
          kind: "daytona",
          apiKeySecretName: "s",
          apiUrl: null,
          target: null,
          profiles: { small: { kind: "snapshot", value: "ok" }, medium: null },
        },
      },
      daytonaProfiles: { small: { kind: "snapshot", value: "ok" }, medium: null },
      agentResourceProfile: "medium",
    });
    expect(result.enabled).toBe(false);
    expect(!result.enabled && result.reason).toBe("missing_source");
  });

  it("reports missing_source when the selected BYOK profile is absent", () => {
    const result = resolveEffectiveComputeConfig({
      ...baseInput,
      daytonaCredentialPresent: true,
      daytonaProfiles: { small: { kind: "snapshot", value: "ok" }, medium: null },
      agentResourceProfile: "medium",
    });

    expect(result.enabled).toBe(false);
    expect(!result.enabled && result.reason).toBe("missing_source");
  });
});

describe("resolveComputeEnvVars (config -> env-resolve wiring)", () => {
  // Minimal in-memory KVNamespace stand-in, matching test/unit/compute/env-secrets.test.ts.
  function fakeKv(): KVNamespace {
    const map = new Map<string, string>();
    return {
      get: async (k: string) => map.get(k) ?? null,
      put: async (k: string, v: string) => void map.set(k, v),
      delete: async (k: string) => void map.delete(k),
      list: async ({ prefix }: { prefix?: string } = {}) => ({
        keys: [...map.keys()]
          .filter((k) => !prefix || k.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
        cacheStatus: null,
      }),
    } as unknown as KVNamespace;
  }

  function fakeEnv(): Env {
    return {
      SECRETS_KV: fakeKv(),
      SECRETS_STORE_KEK_RAW_B64: packB64(new Uint8Array(32)),
    } as unknown as Env;
  }

  it("agent editable beats workspace editable through the pre-collapsed editableEnv", async () => {
    // Build the config the same way src/compute/config.ts does: `editableEnv`
    // is workspace+agent pre-collapsed, `agentEditableEnv` is agent-only.
    const result = resolveEffectiveComputeConfig({
      workspace: {
        enabled: true,
        provider: "cloudflare",
        providerConfig: { kind: "cloudflare" },
        idleTimeoutMs: 900_000,
        recoveryTtlMs: 86_400_000,
        maxProcessRuntimeMs: 600_000,
        limits: {
          tailMaxLines: 1,
          tailMaxBytes: 1,
          grepMaxMatches: 1,
          grepMaxContextLines: 1,
          grepMaxReturnedLines: 1,
          grepMaxBytes: 1,
          readMaxLines: 1,
          readMaxBytes: 1,
          maxProcessOutputBytes: 1,
          maxThreadOutputBytes: 1,
          maxUploadBytes: 1,
          maxDownloadBytes: 1,
        },
        networkRestrictionEnabled: false,
        networkDomainAllowlist: "",
        // Present in workspace only, and in workspace+agent: the agent must win
        // the shared one and the workspace-only one must survive.
        envVars: { WORKSPACE_ONLY: "workspace-value", AGENT_AND_ENV: "workspace-value" },
      },
      agent: {
        sandboxEnabled: true,
        agentEnabled: true,
        archivedAt: null,
        idleTimeoutMs: null,
        maxProcessRuntimeMs: null,
        networkDomainAllowlist: null,
        envVars: { AGENT_AND_ENV: "agent-value" },
      },
      daytonaCredentialPresent: true,
      daytonaProfiles: { small: null, medium: null },
    });
    if (!result.enabled) throw new Error("expected enabled config");
    const config: EffectiveComputeConfig = { ...result.value };

    const resolved = await resolveComputeEnvVars({
      env: fakeEnv(),
      workspaceId: "ws1",
      agentId: "agent1",
      config,
    });

    // A workspace-only var survives the merge untouched.
    expect(resolved.WORKSPACE_ONLY).toBe("workspace-value");
    // The agent wins a shared name, both through the pre-collapsed
    // `editableEnv` and through its own re-applied slot.
    expect(resolved.AGENT_AND_ENV).toBe("agent-value");
  });
});
