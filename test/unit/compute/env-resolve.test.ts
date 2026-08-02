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
      environmentEditable: {},
      agentEditable: {},
      workspaceSecrets: { GH_TOKEN: "ws", SHARED: "wsSecret" },
      environmentSecrets: {},
      agentSecrets: { GH_TOKEN: "agent" },
    });
    expect(result).toEqual({ NODE_ENV: "prod", SHARED: "wsSecret", GH_TOKEN: "agent" });
  });

  it("layers environment between workspace and agent, secrets over editable", () => {
    const merged = mergeSecretValuesIntoEnv({
      workspaceEditable: { A: "ws-e", W: "ws-e", P: "ws-e" },
      environmentEditable: { A: "env-e", E: "env-e", P: "env-e", Q: "env-e" },
      agentEditable: { A: "ag-e", Q: "ag-e" },
      workspaceSecrets: { A: "ws-s", S: "ws-s" },
      environmentSecrets: { A: "env-s" },
      agentSecrets: {},
    });
    expect(merged.A).toBe("env-s"); // env secret beats ws secret & all editable
    expect(merged.W).toBe("ws-e");
    expect(merged.E).toBe("env-e");
    expect(merged.S).toBe("ws-s");
    // Editable-tier ordering, isolated from any secret layer:
    expect(merged.P).toBe("env-e"); // env editable beats ws editable (no secret for P)
    expect(merged.Q).toBe("ag-e"); // agent editable beats env editable (no secret for Q)
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
      enabled: true,
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

  it("takes the resource profile from the thread's workbench snapshot", () => {
    const result = resolveEffectiveComputeConfig({
      ...baseInput,
      workbenchResourceProfile: "medium",
    });
    expect(result.enabled).toBe(true);
    expect(result.enabled && result.value.resourceProfile).toBe("medium");
  });

  it("falls back to small when the snapshot predates the profile column", () => {
    const result = resolveEffectiveComputeConfig({
      ...baseInput,
      workbenchResourceProfile: null,
    });
    expect(result.enabled && result.value.resourceProfile).toBe("small");
  });

  it("validates the source of the workbench's profile, not the default", () => {
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
      workbenchResourceProfile: "medium",
    });
    expect(result.enabled).toBe(false);
    expect(!result.enabled && result.reason).toBe("missing_source");
  });

  it("reports missing_source when the selected BYOK profile is absent", () => {
    const result = resolveEffectiveComputeConfig({
      ...baseInput,
      daytonaCredentialPresent: true,
      daytonaProfiles: { small: { kind: "snapshot", value: "ok" }, medium: null },
      workbenchResourceProfile: "medium",
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

  it("agent editable beats environment editable; environment editable beats workspace editable", async () => {
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
        // WORKSPACE key present in workspace+environment: environment must win.
        envVars: { WORKSPACE_AND_ENV: "workspace-value" },
      },
      agent: {
        enabled: true,
        idleTimeoutMs: null,
        maxProcessRuntimeMs: null,
        networkDomainAllowlist: null,
        // AGENT key present in agent+environment: agent must win.
        envVars: { AGENT_AND_ENV: "agent-value" },
      },
      daytonaCredentialPresent: true,
      daytonaProfiles: { small: null, medium: null },
    });
    if (!result.enabled) throw new Error("expected enabled config");
    const config: EffectiveComputeConfig = {
      ...result.value,
      environmentEditableEnv: {
        WORKSPACE_AND_ENV: "environment-value",
        AGENT_AND_ENV: "environment-value",
      },
    };

    const resolved = await resolveComputeEnvVars({
      env: fakeEnv(),
      workspaceId: "ws1",
      agentId: "agent1",
      environmentId: null,
      config,
    });

    // Environment beats workspace when there's no agent override for the key.
    expect(resolved.WORKSPACE_AND_ENV).toBe("environment-value");
    // Agent beats environment even though environment sits "above" the
    // pre-collapsed workspace+agent `editableEnv` slot.
    expect(resolved.AGENT_AND_ENV).toBe("agent-value");
  });
});
