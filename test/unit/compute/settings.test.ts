import { describe, expect, it } from "vitest";
import { computeProviderReadiness, extractMcpHosts } from "../../../src/compute/settings";
import { buildComputeBackend } from "../../../src/compute/registry";
import { deriveSandboxId } from "../../../src/compute/backends/cloudflare";
import {
  DEFAULT_COMPUTE_LIMITS,
  defaultProviderConfig,
  parseProviderConfigJson,
  resolveDefaultSandboxProvider,
  resolveEffectiveComputeConfig,
} from "../../../src/compute/config";
import { FakeCloudflareSandboxFactory } from "./helpers/fake-cloudflare-client";
import type { Env } from "../../../src/env";
import type { ComputeBackend, ComputeSpec } from "../../../src/compute/backend";
import type { EffectiveComputeConfig, WorkspaceComputeSettings } from "../../../src/compute/types";
import { createWorkspaceSecretsServices, packB64 } from "../../../src/secrets";

function fakeKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => void values.set(key, value),
    delete: async (key: string) => void values.delete(key),
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace;
}

function daytonaEnv(daytonaApiKey?: string): Env {
  return {
    DAYTONA_API_KEY: daytonaApiKey,
    SECRETS_KV: fakeKv(),
    SECRETS_STORE_KEK_RAW_B64: packB64(new Uint8Array(32)),
  } as unknown as Env;
}

function spritesEnv(spritesApiKey?: string): Env {
  return {
    SPRITES_API_KEY: spritesApiKey,
    SECRETS_KV: fakeKv(),
    SECRETS_STORE_KEK_RAW_B64: packB64(new Uint8Array(32)),
  } as unknown as Env;
}

function spritesEffectiveConfig(): EffectiveComputeConfig {
  return {
    ...cloudflareEffectiveConfig(),
    provider: "sprites",
    providerConfig: { kind: "sprites", apiKeySecretName: "sandbox:sprites" },
  };
}

function daytonaEffectiveConfig(profile: "small" | "medium" = "small"): EffectiveComputeConfig {
  return {
    ...cloudflareEffectiveConfig(),
    provider: "daytona",
    providerConfig: {
      kind: "daytona",
      apiKeySecretName: "sandbox:daytona",
      apiUrl: "https://workspace.example",
      target: "workspace-target",
      profiles: {
        small: { kind: "image", value: "workspace-small" },
        medium: { kind: "snapshot", value: "workspace-medium" },
      },
    },
    resourceProfile: profile,
  };
}

/** A fully-configured Cloudflare deployment env; override to knock fields out. */
function cloudflareEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    NADI_SANDBOX_SMALL: {},
    NADI_SANDBOX_MEDIUM: {},
    BACKUP_BUCKET: {},
    BACKUP_BUCKET_NAME: "nadi-backups",
    CLOUDFLARE_ACCOUNT_ID: "acct-123",
    R2_ACCESS_KEY_ID: "ak",
    R2_SECRET_ACCESS_KEY: "sk",
    ...overrides,
  } as unknown as Env;
}

function cloudflareEffectiveConfig(): EffectiveComputeConfig {
  return {
    provider: "cloudflare",
    providerConfig: { kind: "cloudflare" },
    resourceProfile: "small",
    idleTimeoutMs: 900_000,
    recoveryTtlMs: 86_400_000,
    maxProcessRuntimeMs: 600_000,
    monitorPollIntervalMs: 1_000,
    limits: DEFAULT_COMPUTE_LIMITS,
    allowedHosts: null,
    editableEnv: {},
    agentEditableEnv: {},
    secretEnvNames: [],
    environmentEditableEnv: {},
    environmentSecretEnvNames: [],
  };
}

const PROBE_SPEC: ComputeSpec = {
  environmentId: "cloudflare:small",
  profile: "small",
  workspaceRoot: "/workspace",
  env: {},
  maxProcessRuntimeMs: 1_000,
  allowedHosts: null,
};

describe("computeProviderReadiness", () => {
  it("is ready when all Cloudflare deployment config is present and unrestricted", () => {
    const readiness = computeProviderReadiness({
      env: cloudflareEnv(),
      provider: "cloudflare",
      networkRestricted: false,
    });
    expect(readiness).toEqual({
      provider: "cloudflare",
      ready: true,
      missingConfig: [],
      unsupported: [],
    });
  });

  it("reports a missing Sandbox binding by name", () => {
    const readiness = computeProviderReadiness({
      env: cloudflareEnv({ NADI_SANDBOX_SMALL: undefined }),
      provider: "cloudflare",
      networkRestricted: false,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.missingConfig).toContain("NADI_SANDBOX_SMALL");
  });

  it("reports missing backup credentials by name (empty string counts as absent)", () => {
    const readiness = computeProviderReadiness({
      env: cloudflareEnv({ BACKUP_BUCKET_NAME: undefined, CLOUDFLARE_ACCOUNT_ID: "" }),
      provider: "cloudflare",
      networkRestricted: false,
    });
    expect(readiness.missingConfig).toEqual(
      expect.arrayContaining(["BACKUP_BUCKET_NAME", "CLOUDFLARE_ACCOUNT_ID"]),
    );
    expect(readiness.ready).toBe(false);
  });

  it("reports a whitespace-only config value as missing (trim, not just empty-string)", () => {
    const readiness = computeProviderReadiness({
      env: cloudflareEnv({ CLOUDFLARE_ACCOUNT_ID: "   " }),
      provider: "cloudflare",
      networkRestricted: false,
    });
    expect(readiness.missingConfig).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(readiness.ready).toBe(false);
  });

  it("marks network restrictions unsupported without treating it as missing config", () => {
    const readiness = computeProviderReadiness({
      env: cloudflareEnv(),
      provider: "cloudflare",
      networkRestricted: true,
    });
    expect(readiness.unsupported).toEqual(["network_restrictions"]);
    expect(readiness.missingConfig).toEqual([]);
    expect(readiness.ready).toBe(false);
  });

  it("never leaks a secret value into the readiness payload", () => {
    const secret = "r2-secret-value-DO-NOT-LEAK";
    const readiness = computeProviderReadiness({
      env: cloudflareEnv({ R2_SECRET_ACCESS_KEY: secret }),
      provider: "cloudflare",
      networkRestricted: false,
    });
    expect(JSON.stringify(readiness)).not.toContain(secret);
  });

  it("treats Daytona as deployable and network-capable", () => {
    const readiness = computeProviderReadiness({
      env: cloudflareEnv(),
      provider: "daytona",
      networkRestricted: true,
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.missingConfig).toEqual([]);
    expect(readiness.unsupported).toEqual([]);
  });

  it("treats Sprites as deployable and network-capable", () => {
    const readiness = computeProviderReadiness({
      env: cloudflareEnv(),
      provider: "sprites",
      networkRestricted: true,
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.missingConfig).toEqual([]);
    expect(readiness.unsupported).toEqual([]);
  });
});

describe("sprites provider config plumbing", () => {
  it("round-trips a valid sprites provider config through JSON", () => {
    const json = JSON.stringify({ kind: "sprites", apiKeySecretName: "sandbox:sprites" });
    expect(parseProviderConfigJson(json)).toEqual({
      kind: "sprites",
      apiKeySecretName: "sandbox:sprites",
    });
  });

  it("rejects a sprites provider config missing apiKeySecretName", () => {
    const json = JSON.stringify({ kind: "sprites" });
    expect(() => parseProviderConfigJson(json)).toThrow("invalid_provider_config_json");
  });

  it("defaultProviderConfig('sprites') returns the sandbox:sprites default", () => {
    expect(defaultProviderConfig("sprites")).toEqual({
      kind: "sprites",
      apiKeySecretName: "sandbox:sprites",
    });
  });

  it("resolveDefaultSandboxProvider recognizes 'sprites'", () => {
    expect(resolveDefaultSandboxProvider({ DEFAULT_SANDBOX_PROVIDER: "sprites" })).toBe("sprites");
  });

  function spritesWorkspace(): WorkspaceComputeSettings {
    return {
      enabled: true,
      provider: "sprites",
      providerConfig: { kind: "sprites", apiKeySecretName: "sandbox:sprites" },
      idleTimeoutMs: 900_000,
      recoveryTtlMs: 86_400_000,
      maxProcessRuntimeMs: 600_000,
      limits: DEFAULT_COMPUTE_LIMITS,
      networkRestrictionEnabled: false,
      networkDomainAllowlist: "",
      envVars: {},
    };
  }

  it("bails missing_secret for a sprites workspace without a credential", () => {
    const result = resolveEffectiveComputeConfig({
      workspace: spritesWorkspace(),
      agent: null,
      daytonaCredentialPresent: false,
      daytonaProfiles: { small: null, medium: null },
      spritesCredentialPresent: false,
    });
    expect(result).toEqual({ enabled: false, reason: "missing_secret" });
  });

  it("enables a sprites workspace once a credential is present, without computing environmentId", () => {
    const result = resolveEffectiveComputeConfig({
      workspace: spritesWorkspace(),
      agent: null,
      daytonaCredentialPresent: false,
      daytonaProfiles: { small: null, medium: null },
      spritesCredentialPresent: true,
    });
    expect(result.enabled).toBe(true);
    if (result.enabled) {
      expect(result.value.provider).toBe("sprites");
      expect(result.value).not.toHaveProperty("environmentId");
    }
  });
});

describe("buildComputeBackend cloudflare dispatch", () => {
  it("constructs a Cloudflare backend and derives identity from workspace+thread", async () => {
    const factory = new FakeCloudflareSandboxFactory();
    const backend = await buildComputeBackend(
      cloudflareEnv(),
      "ws-x",
      "thread-y",
      cloudflareEffectiveConfig(),
      { cloudflareFactory: factory },
    );
    expect(backend.id).toBe("cloudflare");
    // Prove threadId is plumbed through: the DO id must be derived from BOTH
    // workspace and thread, never from environmentId.
    await backend.acquire(PROBE_SPEC);
    expect(factory.calls[0]?.id).toBe(deriveSandboxId("ws-x", "thread-y"));
  });

  it("fails closed when a Sandbox binding is absent at runtime", async () => {
    const factory = new FakeCloudflareSandboxFactory();
    await expect(
      buildComputeBackend(
        cloudflareEnv({ NADI_SANDBOX_SMALL: undefined }),
        "ws-x",
        "thread-y",
        cloudflareEffectiveConfig(),
        { cloudflareFactory: factory },
      ),
    ).rejects.toThrow();
  });

  // The backend is built on the agent path, which has no readiness gate. It must
  // therefore demand everything readiness demands -- including the SigV4 presign
  // credentials. `useLocalBucket` is a constant `false`, so `createBackup` always
  // presigns; a deploy carrying the three bindings but no R2 secrets would acquire,
  // exec, and discard happily, then fail the FIRST recoverable release.
  it.each([
    "BACKUP_BUCKET_NAME",
    "CLOUDFLARE_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ])("fails closed when %s is absent at runtime", async (name) => {
    const factory = new FakeCloudflareSandboxFactory();
    await expect(
      buildComputeBackend(
        cloudflareEnv({ [name]: undefined }),
        "ws-x",
        "thread-y",
        cloudflareEffectiveConfig(),
        { cloudflareFactory: factory },
      ),
    ).rejects.toThrow(new RegExp(name));
  });
});

describe("buildComputeBackend Daytona dispatch", () => {
  function captureBackend() {
    const configs: Array<{
      apiKey: string;
      apiUrl: string | null;
      target: string | null;
      source: { image?: string; snapshot?: string };
    }> = [];
    const factory = (config: (typeof configs)[number]): ComputeBackend => {
      configs.push(config);
      return { id: "daytona" } as ComputeBackend;
    };
    return { configs, factory };
  }

  it.each([
    ["small", "nadi-small"],
    ["medium", "nadi-medium"],
  ] as const)("uses the system credential and %s system snapshot", async (profile, snapshot) => {
    const env = daytonaEnv("system-key");
    const { configs, factory } = captureBackend();

    await buildComputeBackend(env, "ws-x", "thread-y", daytonaEffectiveConfig(profile), {
      daytonaFactory: factory,
    });

    expect(configs).toEqual([
      { apiKey: "system-key", apiUrl: null, target: null, source: { snapshot } },
    ]);
  });

  it("uses the complete workspace bundle when a workspace credential exists", async () => {
    const env = daytonaEnv("system-key");
    const { writer } = createWorkspaceSecretsServices(env);
    await writer.ensureWorkspaceDek("ws-x");
    await writer.set("ws-x", "sandbox:daytona", "workspace-key");
    const { configs, factory } = captureBackend();

    await buildComputeBackend(env, "ws-x", "thread-y", daytonaEffectiveConfig("medium"), {
      daytonaFactory: factory,
    });

    expect(configs).toEqual([
      {
        apiKey: "workspace-key",
        apiUrl: "https://workspace.example",
        target: "workspace-target",
        source: { snapshot: "workspace-medium" },
      },
    ]);
  });

  it("fails safely when the effective Daytona credential is missing", async () => {
    await expect(
      buildComputeBackend(daytonaEnv(), "ws-x", "thread-y", daytonaEffectiveConfig()),
    ).rejects.toMatchObject({
      code: "compute_unavailable",
      message: "compute_daytona_secret_missing",
    });
  });

  it("fails safely when the BYOK profile is incomplete", async () => {
    const env = daytonaEnv("system-key");
    const { writer } = createWorkspaceSecretsServices(env);
    await writer.ensureWorkspaceDek("ws-x");
    await writer.set("ws-x", "sandbox:daytona", "workspace-key");
    const config = daytonaEffectiveConfig();
    if (config.providerConfig.kind === "daytona") config.providerConfig.profiles.small = null;

    await expect(buildComputeBackend(env, "ws-x", "thread-y", config)).rejects.toMatchObject({
      code: "compute_unavailable",
      message: "compute_daytona_source_missing",
    });
  });
});

describe("buildComputeBackend Sprites dispatch", () => {
  it("returns the spritesFactory override's backend, passing the resolved BYOK key", async () => {
    const env = spritesEnv("system-key");
    const { writer } = createWorkspaceSecretsServices(env);
    await writer.ensureWorkspaceDek("ws-x");
    await writer.set("ws-x", "sandbox:sprites", "workspace-key");

    const calls: Array<{ apiKey: string }> = [];
    const fakeBackend = { id: "sprites" } as ComputeBackend;
    const spritesFactory = (config: { apiKey: string }): ComputeBackend => {
      calls.push(config);
      return fakeBackend;
    };

    const backend = await buildComputeBackend(env, "ws-x", "thread-y", spritesEffectiveConfig(), {
      spritesFactory,
    });

    expect(backend).toBe(fakeBackend);
    expect(calls).toEqual([{ apiKey: "workspace-key" }]);
  });

  it("fails closed when no sprites key is resolvable", async () => {
    await expect(
      buildComputeBackend(spritesEnv(), "ws-x", "thread-y", spritesEffectiveConfig()),
    ).rejects.toMatchObject({
      code: "compute_unavailable",
      message: "compute_sprites_secret_missing",
    });
  });
});

describe("extractMcpHosts", () => {
  it("returns lowercased hostnames of enabled servers only, deduped", () => {
    const hosts = extractMcpHosts([
      { url: "https://MCP.acme.com/sse", enabled: true },
      { url: "https://mcp.acme.com/other", enabled: true },
      { url: "https://disabled.acme.com", enabled: false },
      { url: "not a url", enabled: true },
      { url: "https://api.example.com:8443/x", enabled: true },
    ]);
    expect(hosts).toContain("mcp.acme.com");
    expect(hosts).toContain("api.example.com");
    expect(hosts).not.toContain("disabled.acme.com");
    expect(hosts.filter((h) => h === "mcp.acme.com")).toHaveLength(1);
  });
});
