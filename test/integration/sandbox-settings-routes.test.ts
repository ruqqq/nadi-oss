import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import type { Env } from "../../src/env";
import type { BackendReference, ComputeBackend } from "../../src/compute/backend";
import * as computeConfig from "../../src/compute/config";
import { DEFAULT_COMPUTE_LIMITS } from "../../src/compute/config";
import { getComputeSettingsView } from "../../src/compute/settings";
import { createWorkspaceSecretsServices } from "../../src/secrets";
import { applyRegistryTestSchema } from "./helpers/registry";
import computeProviderSettingsBackfill from "../../scripts/backfills/compute-provider-settings.sql?raw";

const now = 1_800_000_000_000;
const workspaceId = "ws-sandbox-settings";

function cookie(token: string) {
  return { cookie: `better-auth.session_token=${token}` };
}

/**
 * Runs `body` against a deployment that has opted into the mock sandbox.
 * Selecting mock is gated on `DEFAULT_SANDBOX_PROVIDER=mock`, and the miniflare
 * env sets no vars, so anything exercising mock has to declare that here.
 */
async function withMockSandboxEnabled(body: () => Promise<void>): Promise<void> {
  const bag = env as unknown as Record<string, unknown>;
  const previous = bag.DEFAULT_SANDBOX_PROVIDER;
  bag.DEFAULT_SANDBOX_PROVIDER = "mock";
  try {
    await body();
  } finally {
    if (previous === undefined) delete bag.DEFAULT_SANDBOX_PROVIDER;
    else bag.DEFAULT_SANDBOX_PROVIDER = previous;
  }
}

/** Same shape as {@link withMockSandboxEnabled}, for the opposite direction:
 *  celld is the platform that WITHDRAWS a provider rather than granting one. */
async function withCelldPlatform(body: () => Promise<void>): Promise<void> {
  const bag = env as unknown as Record<string, unknown>;
  const previous = bag.NADI_PLATFORM;
  bag.NADI_PLATFORM = "celld";
  try {
    await body();
  } finally {
    if (previous === undefined) delete bag.NADI_PLATFORM;
    else bag.NADI_PLATFORM = previous;
  }
}

function daytonaProviderConfig(source: { kind: "image" | "snapshot"; value: string }) {
  return {
    kind: "daytona",
    apiKeySecretName: "sandbox:daytona",
    apiUrl: null,
    target: null,
    profiles: { small: source, medium: source },
  };
}

async function clearKv() {
  const keys = await env.SECRETS_KV.list({ prefix: `workspaces/${workspaceId}/` });
  await Promise.all(keys.keys.map((key) => env.SECRETS_KV.delete(key.name)));
}

async function clearRegistry() {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.delete(schema.providerConfigs);
  await db.delete(schema.mcpToolPolicies);
  await db.delete(schema.mcpServers);
  await db.delete(schema.threadIndex);
  await db.delete(schema.workspaceSandboxSettings);
  await db.delete(schema.agents);
  await db.delete(schema.workspaceMembers);
  await db.delete(schema.workspaces);
  await db.delete(schema.accounts);
  await db.delete(schema.sessions);
  await db.delete(schema.verifications);
  await db.delete(schema.users);
}

async function seedUserWorkspace(input?: { token?: string }) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  const userId = "user-sandbox-owner";
  const token = input?.token ?? "sandbox-owner-token";

  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@example.com`,
    name: null,
    createdAt: new Date(now),
    emailVerified: true,
    image: null,
    updatedAt: new Date(now),
  });
  await db.insert(schema.sessions).values({
    id: `session-${userId}`,
    userId,
    token,
    expiresAt: new Date(now + 60_000),
    createdAt: new Date(now),
    updatedAt: new Date(now),
    ipAddress: null,
    userAgent: null,
  });
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    name: "Sandbox Settings",
    createdAt: now,
  });
  await db.insert(schema.workspaceMembers).values({
    workspaceId,
    userId,
    role: "owner",
    createdAt: now,
  });
  await db.insert(schema.agents).values({
    id: "agent-default",
    workspaceId,
    name: "Default",
    systemPrompt: "Initial prompt",
    provider: "mock",
    model: "mock",
    createdAt: now,
  });

  return { token, workspaceId, userId };
}

describe("sandbox settings routes", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearRegistry();
    await clearKv();
  });

  it("requires authentication", async () => {
    const res = await SELF.fetch("https://nadi.test/api/settings/sandbox", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("stores Daytona API keys through the encrypted workspace secret store", async () => {
    const { token } = await seedUserWorkspace();
    const secretName = "sandbox:daytona";
    const { store } = createWorkspaceSecretsServices(env);

    const res = await SELF.fetch("https://nadi.test/api/settings/sandbox/daytona-secret", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...cookie(token) },
      body: JSON.stringify({ value: "dt_test_secret", secretName }),
    });

    expect(res.status).toBe(200);
    expect(await store.get(workspaceId, secretName)).toBe("dt_test_secret");
  });

  it("keeps Daytona secret writes, mode resolution, and reset on the configured secret name", async () => {
    const { token } = await seedUserWorkspace();
    const { store } = createWorkspaceSecretsServices(env);
    const testEnv = env as unknown as Env;
    const previous = testEnv.DAYTONA_API_KEY;
    delete testEnv.DAYTONA_API_KEY;
    try {
      const configuredSecretName = "sandbox:custom-daytona";
      const settings = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({
          provider: "daytona",
          providerConfig: {
            ...daytonaProviderConfig({ kind: "image", value: "node:22" }),
            apiKeySecretName: configuredSecretName,
          },
        }),
      });
      expect(settings.status).toBe(200);

      const rejected = await SELF.fetch("https://nadi.test/api/settings/sandbox/daytona-secret", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({ value: "orphaned-key", secretName: "sandbox:wrong-daytona" }),
      });
      expect(rejected.status).toBe(400);
      expect(await store.get(workspaceId, "sandbox:wrong-daytona")).toBeNull();

      let view = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        headers: cookie(token),
      });
      expect(await view.json()).toMatchObject({ daytonaMode: "system", daytonaAvailable: false });

      const saved = await SELF.fetch("https://nadi.test/api/settings/sandbox/daytona-secret", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({ value: "configured-key" }),
      });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ daytonaMode: "byok", daytonaAvailable: true });
      expect(await store.get(workspaceId, configuredSecretName)).toBe("configured-key");

      const cleared = await SELF.fetch("https://nadi.test/api/settings/sandbox/daytona-secret", {
        method: "DELETE",
        headers: cookie(token),
      });
      expect(cleared.status).toBe(200);
      expect(await cleared.json()).toMatchObject({
        daytonaMode: "system",
        daytonaAvailable: false,
      });
      expect(await store.get(workspaceId, configuredSecretName)).toBeNull();

      view = await SELF.fetch("https://nadi.test/api/settings/sandbox", { headers: cookie(token) });
      expect(await view.json()).toMatchObject({ daytonaMode: "system", daytonaAvailable: false });
    } finally {
      if (previous === undefined) delete testEnv.DAYTONA_API_KEY;
      else testEnv.DAYTONA_API_KEY = previous;
    }
  });

  it("reports the selected Daytona mode and its effective availability", async () => {
    const { token } = await seedUserWorkspace();
    const testEnv = env as unknown as Env;
    const previous = testEnv.DAYTONA_API_KEY;
    delete testEnv.DAYTONA_API_KEY;
    try {
      let res = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        headers: cookie(token),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        daytonaMode: "system",
        daytonaAvailable: false,
      });

      testEnv.DAYTONA_API_KEY = "system_test_key";
      res = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        headers: cookie(token),
      });
      expect(await res.json()).toMatchObject({ daytonaMode: "system", daytonaAvailable: true });

      await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({
          provider: "daytona",
          providerConfig: daytonaProviderConfig({ kind: "image", value: "node:22" }),
        }),
      });
      await SELF.fetch("https://nadi.test/api/settings/sandbox/daytona-secret", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({ value: "workspace_test_key" }),
      });

      res = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        headers: cookie(token),
      });
      expect(await res.json()).toMatchObject({
        daytonaMode: "byok",
        daytonaAvailable: true,
      });
    } finally {
      if (previous === undefined) delete testEnv.DAYTONA_API_KEY;
      else testEnv.DAYTONA_API_KEY = previous;
    }
  });

  it("idempotently clears a Daytona override and resets only provider-owned settings", async () => {
    const { token } = await seedUserWorkspace();
    const { store } = createWorkspaceSecretsServices(env);
    const testEnv = env as unknown as Env;
    const previous = testEnv.DAYTONA_API_KEY;
    testEnv.DAYTONA_API_KEY = "system_test_key";
    try {
      await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({
          enabled: true,
          provider: "daytona",
          providerConfig: {
            ...daytonaProviderConfig({ kind: "image", value: "custom-image" }),
            apiUrl: "https://daytona.example.test",
            target: "custom-target",
          },
          idleTimeoutMs: 1_234_567,
          recoveryTtlMs: 123_456_789,
          maxProcessRuntimeMs: 7_654_321,
          networkRestrictionEnabled: true,
          networkDomainAllowlist: "api.example.com",
        }),
      });
      await SELF.fetch("https://nadi.test/api/settings/sandbox/daytona-secret", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({ value: "workspace_test_key" }),
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await SELF.fetch("https://nadi.test/api/settings/sandbox/daytona-secret", {
          method: "DELETE",
          headers: cookie(token),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
          daytonaMode: "system",
          daytonaAvailable: true,
          workspace: {
            enabled: true,
            providerConfig: computeConfig.defaultProviderConfig("daytona"),
            idleTimeoutMs: 900_000,
            recoveryTtlMs: 123_456_789,
            maxProcessRuntimeMs: 7_654_321,
            networkRestrictionEnabled: true,
            networkDomainAllowlist: "api.example.com",
          },
        });
      }
      expect(await store.get(workspaceId, "sandbox:daytona")).toBeNull();
    } finally {
      if (previous === undefined) delete testEnv.DAYTONA_API_KEY;
      else testEnv.DAYTONA_API_KEY = previous;
    }
  });

  it("restores the exact Daytona key when the registry reset fails after deletion", async () => {
    const { token } = await seedUserWorkspace();
    const { store } = createWorkspaceSecretsServices(env);
    const testEnv = env as unknown as Env;
    const configuredSecretName = "sandbox:custom-daytona";

    await SELF.fetch("https://nadi.test/api/settings/sandbox", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...cookie(token) },
      body: JSON.stringify({
        provider: "daytona",
        providerConfig: {
          ...daytonaProviderConfig({ kind: "image", value: "custom-image" }),
          apiKeySecretName: configuredSecretName,
          apiUrl: "https://daytona.example.test",
          target: "custom-target",
        },
        idleTimeoutMs: 1_234_567,
      }),
    });
    await SELF.fetch("https://nadi.test/api/settings/sandbox/daytona-secret", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...cookie(token) },
      body: JSON.stringify({ value: "exact-workspace-key" }),
    });

    testEnv.COMPUTE_TEST_RESET_DAYTONA_SETTINGS = async () => {
      throw new Error("injected_registry_failure");
    };
    try {
      await expect(
        SELF.fetch("https://nadi.test/api/settings/sandbox/daytona-secret", {
          method: "DELETE",
          headers: cookie(token),
        }),
      ).rejects.toThrow("injected_registry_failure");
      expect(await store.get(workspaceId, configuredSecretName)).toBe("exact-workspace-key");

      const view = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        headers: cookie(token),
      });
      expect(await view.json()).toMatchObject({
        daytonaMode: "byok",
        daytonaAvailable: true,
        workspace: {
          providerConfig: {
            kind: "daytona",
            apiKeySecretName: configuredSecretName,
            apiUrl: "https://daytona.example.test",
            target: "custom-target",
            profiles: {
              small: { kind: "image", value: "custom-image" },
              medium: { kind: "image", value: "custom-image" },
            },
          },
          idleTimeoutMs: 1_234_567,
        },
      });
    } finally {
      delete testEnv.COMPUTE_TEST_RESET_DAYTONA_SETTINGS;
    }
  });

  describe("sprites secret + provider config", () => {
    function spritesProviderConfig(secretName = "sandbox:sprites") {
      return { kind: "sprites", apiKeySecretName: secretName };
    }

    it("PUT sprites-secret stores the KV secret and reflects byok mode", async () => {
      const { token } = await seedUserWorkspace();
      const { store } = createWorkspaceSecretsServices(env);
      await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({
          enabled: true,
          provider: "sprites",
          providerConfig: spritesProviderConfig(),
        }),
      });

      const res = await SELF.fetch("https://nadi.test/api/settings/sandbox/sprites-secret", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({ value: "sprites_test_secret" }),
      });

      expect(res.status).toBe(200);
      expect(await store.get(workspaceId, "sandbox:sprites")).toBe("sprites_test_secret");
      expect(await res.json()).toMatchObject({
        spritesMode: "byok",
        spritesSecretPresent: true,
      });
    });

    it("DELETE sprites-secret resets to system mode", async () => {
      const { token } = await seedUserWorkspace();
      const { store } = createWorkspaceSecretsServices(env);
      await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({
          enabled: true,
          provider: "sprites",
          providerConfig: spritesProviderConfig(),
        }),
      });
      await SELF.fetch("https://nadi.test/api/settings/sandbox/sprites-secret", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({ value: "sprites_test_secret" }),
      });

      const res = await SELF.fetch("https://nadi.test/api/settings/sandbox/sprites-secret", {
        method: "DELETE",
        headers: cookie(token),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        spritesMode: "system",
        spritesSecretPresent: false,
      });
      expect(await store.get(workspaceId, "sandbox:sprites")).toBeNull();
    });

    it("saves the sprites provider config and round-trips it through GET", async () => {
      const { token } = await seedUserWorkspace();
      const providerConfig = spritesProviderConfig("sandbox:sprites");

      const put = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({ enabled: true, provider: "sprites", providerConfig }),
      });
      expect(put.status).toBe(200);

      const get = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        headers: cookie(token),
      });
      expect(get.status).toBe(200);
      const view = (await get.json()) as {
        workspace: { provider: string; providerConfig: unknown };
      };
      expect(view.workspace).toMatchObject({ provider: "sprites", providerConfig });
    });

    it("rejects a sprites-secret write whose secretName does not match the configured one", async () => {
      const { token } = await seedUserWorkspace();
      const { store } = createWorkspaceSecretsServices(env);
      await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({
          enabled: true,
          provider: "sprites",
          providerConfig: spritesProviderConfig(),
        }),
      });

      const res = await SELF.fetch("https://nadi.test/api/settings/sandbox/sprites-secret", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({ value: "orphaned-key", secretName: "sandbox:wrong-sprites" }),
      });
      expect(res.status).toBe(400);
      expect(await store.get(workspaceId, "sandbox:wrong-sprites")).toBeNull();
    });
  });

  it("merges partial workspace settings updates instead of resetting omitted fields", async () => {
    const { token } = await seedUserWorkspace();

    // Full save establishes non-default values.
    const first = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...cookie(token) },
      body: JSON.stringify({
        enabled: true,
        providerConfig: {
          ...daytonaProviderConfig({ kind: "image", value: "node:22" }),
          apiKeySecretName: "custom:key",
        },
        idleTimeoutMs: 1_000_000,
        maxProcessRuntimeMs: 700_000,
      }),
    });
    expect(first.status).toBe(200);

    // Partial save toggles only `enabled`; everything else must be preserved.
    const second = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...cookie(token) },
      body: JSON.stringify({ enabled: false }),
    });
    expect(second.status).toBe(200);
    const view = (await second.json()) as {
      workspace: {
        enabled: boolean;
        providerConfig: { apiKeySecretName: string };
        idleTimeoutMs: number;
        maxProcessRuntimeMs: number;
      };
    };
    expect(view.workspace).toMatchObject({
      enabled: false,
      providerConfig: { apiKeySecretName: "custom:key" },
      idleTimeoutMs: 1_000_000,
      maxProcessRuntimeMs: 700_000,
    });
  });

  it("stores Daytona provider config and preserves it across a partial workspace update", async () => {
    const { token } = await seedUserWorkspace();
    const providerConfig = {
      kind: "daytona",
      apiKeySecretName: "sandbox:daytona",
      apiUrl: null,
      target: null,
      profiles: {
        small: { kind: "snapshot", value: "nadi-small" },
        medium: { kind: "snapshot", value: "nadi-medium" },
      },
    };

    const first = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...cookie(token) },
      body: JSON.stringify({
        enabled: true,
        provider: "daytona",
        recoveryTtlMs: 86_400_000,
        providerConfig,
      }),
    });
    expect(first.status).toBe(200);

    const second = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...cookie(token) },
      body: JSON.stringify({ enabled: false }),
    });
    expect(second.status).toBe(200);
    const view = (await second.json()) as {
      workspace: {
        provider: string;
        providerConfig: unknown;
        recoveryTtlMs: number;
      };
    };
    expect(view.workspace).toMatchObject({
      provider: "daytona",
      providerConfig,
      recoveryTtlMs: 86_400_000,
    });
  });

  it("backfills a legacy Daytona row and reads only provider config JSON", async () => {
    const { token } = await seedUserWorkspace();
    await env.REGISTRY_DB.prepare(
      "INSERT INTO workspace_sandbox_settings (workspace_id, enabled, provider, image, snapshot, small_snapshot, medium_snapshot, daytona_api_key_secret_name, idle_timeout_ms, max_process_runtime_ms, limits_json, network_restriction_enabled, network_domain_allowlist, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        workspaceId,
        1,
        "daytona",
        "legacy-image",
        "legacy-default",
        "nadi-small",
        "nadi-medium",
        "sandbox:daytona",
        900_000,
        600_000,
        "{}",
        0,
        "",
        now,
        now,
      )
      .run();
    await env.REGISTRY_DB.prepare(computeProviderSettingsBackfill).run();

    const response = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
      headers: cookie(token),
    });
    expect(response.status).toBe(200);
    const view = (await response.json()) as { workspace: Record<string, unknown> };
    expect(view.workspace).toMatchObject({
      provider: "daytona",
      providerConfig: {
        kind: "daytona",
        apiKeySecretName: "sandbox:daytona",
        apiUrl: null,
        target: null,
        profiles: {
          small: { kind: "snapshot", value: "nadi-small" },
          medium: { kind: "snapshot", value: "nadi-medium" },
        },
      },
    });
    expect(view.workspace).not.toHaveProperty("image");
    expect(view.workspace).not.toHaveProperty("snapshot");
    expect(view.workspace).not.toHaveProperty("defaultProfile");
  });

  it("does not expose a workspace default resource profile", async () => {
    const { token } = await seedUserWorkspace();
    await SELF.fetch("https://nadi.test/api/settings/sandbox", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...cookie(token) },
      body: JSON.stringify({
        enabled: true,
        providerConfig: {
          kind: "daytona",
          apiKeySecretName: "sandbox:daytona",
          apiUrl: null,
          target: null,
          profiles: {
            small: { kind: "snapshot", value: "nadi-small" },
            medium: { kind: "image", value: "node:22" },
          },
        },
        idleTimeoutMs: 950_000,
        recoveryTtlMs: 90_000_000,
        maxProcessRuntimeMs: 650_000,
      }),
    });
    const response = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
      headers: cookie(token),
    });
    expect(response.status).toBe(200);
    const view = (await response.json()) as { workspace: Record<string, unknown> | null };

    // Positive companion: prove this is a genuine, well-formed settings
    // response (not empty/undefined/wrong-shape/errored) before trusting the
    // negative assertion below to mean anything.
    expect(view.workspace).toMatchObject({
      enabled: true,
      provider: "daytona",
      providerConfig: {
        kind: "daytona",
        apiKeySecretName: "sandbox:daytona",
        apiUrl: null,
        target: null,
        profiles: {
          small: { kind: "snapshot", value: "nadi-small" },
          medium: { kind: "image", value: "node:22" },
        },
      },
      idleTimeoutMs: 950_000,
      recoveryTtlMs: 90_000_000,
      maxProcessRuntimeMs: 650_000,
    });

    // `defaultResourceProfile` was deliberately removed — the workbench is
    // now the only handle on sandbox size. This only proves something
    // because the assertions above already establish `view.workspace` is a
    // real, well-formed settings payload.
    expect(view.workspace).not.toHaveProperty("defaultResourceProfile");
    expect(view.workspace).not.toHaveProperty("defaultProfile");
  });

  it("still exposes the per-profile image sources", async () => {
    const { token } = await seedUserWorkspace();
    await SELF.fetch("https://nadi.test/api/settings/sandbox", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...cookie(token) },
      body: JSON.stringify({
        enabled: true,
        providerConfig: daytonaProviderConfig({ kind: "snapshot", value: "nadi-small" }),
      }),
    });
    const response = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
      headers: cookie(token),
    });
    expect(response.status).toBe(200);
    const view = (await response.json()) as {
      workspace: { providerConfig: { profiles: Record<string, unknown> } };
    };
    expect(view.workspace.providerConfig.profiles).toHaveProperty("medium");
  });

  it("ignores retired image, snapshot, and resource-profile fields on the agent override", async () => {
    const { token } = await seedUserWorkspace();
    await SELF.fetch("https://nadi.test/api/settings/sandbox", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...cookie(token) },
      body: JSON.stringify({
        enabled: true,
        providerConfig: daytonaProviderConfig({ kind: "snapshot", value: "nadi-small" }),
      }),
    });
    await SELF.fetch("https://nadi.test/api/settings/sandbox/daytona-secret", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...cookie(token) },
      body: JSON.stringify({ value: "dt_test_secret" }),
    });

    const response = await SELF.fetch("https://nadi.test/api/settings/sandbox/agent", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...cookie(token) },
      body: JSON.stringify({
        enabled: true,
        resourceProfile: "medium",
        image: "retired-agent-image",
        snapshot: "retired-agent-snapshot",
      }),
    });
    expect(response.status).toBe(200);
    const view = (await response.json()) as {
      agent: Record<string, unknown>;
      effective: { enabled: boolean; value?: { resourceProfile: string } };
    };
    expect(view.agent).not.toHaveProperty("resourceProfile");
    expect(view.agent).not.toHaveProperty("image");
    expect(view.agent).not.toHaveProperty("snapshot");
    // The agent-level override no longer exists — only the thread's workbench
    // snapshot drives resolution (Task 3). This settings view has no thread
    // context, so the effective profile is the bare default.
    expect(view.effective).toMatchObject({ enabled: true, value: { resourceProfile: "small" } });
  });

  it("clears an agent enabled override back to inherit on an explicit null", async () => {
    const { token } = await seedUserWorkspace();
    const putAgent = (body: unknown) =>
      SELF.fetch("https://nadi.test/api/settings/sandbox/agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify(body),
      });
    const readAgent = async (res: Response) =>
      ((await res.json()) as { agent: Record<string, unknown> }).agent;

    expect(await readAgent(await putAgent({ enabled: true }))).toMatchObject({ enabled: true });

    // Omitting a key preserves it...
    expect(await readAgent(await putAgent({ networkDomainAllowlist: "x.com" }))).toMatchObject({
      enabled: true,
    });

    // ...but an explicit null clears it. This is the only way back to "inherit".
    const cleared = await readAgent(await putAgent({ enabled: null }));
    expect(cleared.enabled).toBeNull();
  });

  it("saves + merges network restriction settings and validates domains", async () => {
    const { token } = await seedUserWorkspace();
    // enable + set domains
    let res = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...cookie(token) },
      body: JSON.stringify({
        enabled: true,
        networkRestrictionEnabled: true,
        networkDomainAllowlist: "api.acme.com,*.github.com",
      }),
    });
    expect(res.status).toBe(200);
    let view = (await res.json()) as any;
    expect(view.workspace.networkRestrictionEnabled).toBe(true);
    expect(view.workspace.networkDomainAllowlist).toBe("api.acme.com,*.github.com");

    // invalid domain rejected
    res = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...cookie(token) },
      body: JSON.stringify({
        enabled: true,
        networkDomainAllowlist: "https://bad",
      }),
    });
    expect(res.status).toBe(400);

    // partial update (omit networkDomainAllowlist) preserves it
    res = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...cookie(token) },
      body: JSON.stringify({ enabled: true, networkRestrictionEnabled: true }),
    });
    view = (await res.json()) as any;
    expect(view.workspace.networkDomainAllowlist).toBe("api.acme.com,*.github.com");
  });

  describe("POST /api/settings/sandbox/test", () => {
    function withBackendOverride(factory: NonNullable<Env["COMPUTE_TEST_BACKEND_FACTORY"]>) {
      const testEnv = env as unknown as Env;
      testEnv.COMPUTE_TEST_BACKEND_FACTORY = factory;
      return () => {
        delete testEnv.COMPUTE_TEST_BACKEND_FACTORY;
      };
    }

    function withSystemDaytonaKey(apiKey: string) {
      const testEnv = env as unknown as Env;
      const previous = testEnv.DAYTONA_API_KEY;
      testEnv.DAYTONA_API_KEY = apiKey;
      return () => {
        if (previous === undefined) delete testEnv.DAYTONA_API_KEY;
        else testEnv.DAYTONA_API_KEY = previous;
      };
    }

    // Fake compute backend for the connection-test route: the environment source
    // is passed to the FACTORY (constructor), and the route now drives a full
    // provider-neutral probe — acquire(), a `printf nadi-compute-ready` process
    // whose output it verifies, then release({ disposition: "discard" }) in a
    // finally. `sources` records each factory `source` argument.
    function spyBackend(overrides?: Partial<ComputeBackend>) {
      const runtimeRef: BackendReference = {
        provider: "fake",
        version: 1,
        payload: { kind: "runtime", sandboxId: "sbx_test" },
      };
      const processRef: BackendReference = {
        provider: "fake",
        version: 1,
        payload: { kind: "process", sandboxId: "sbx_test", processId: "p1" },
      };
      const acquire = vi.fn(async (): Promise<BackendReference> => runtimeRef);
      const startProcess = vi.fn(async () => ({
        process: processRef,
        status: "exited" as const,
        exitCode: 0,
      }));
      const getProcessStatus = vi.fn(async () => ({ status: "exited" as const, exitCode: 0 }));
      const readProcessOutput = vi.fn(async () => ({ stdout: "nadi-compute-ready", stderr: "" }));
      const release = vi.fn(async (): Promise<BackendReference | null> => null);
      const configs: Array<{
        apiKey: string;
        apiUrl: string | null;
        target: string | null;
        source: { image?: string; snapshot?: string };
      }> = [];
      const sources: Array<{ image?: string; snapshot?: string }> = [];
      const factory: NonNullable<Env["COMPUTE_TEST_BACKEND_FACTORY"]> = (config) => {
        configs.push(config);
        sources.push(config.source);
        return {
          id: "fake",
          acquire,
          startProcess,
          getProcessStatus,
          readProcessOutput,
          release,
          ...overrides,
        } as unknown as ComputeBackend;
      };
      return {
        factory,
        acquire,
        startProcess,
        getProcessStatus,
        readProcessOutput,
        release,
        sources,
        configs,
        runtimeRef,
      };
    }

    it("passes for the mock provider using the real in-memory backend (no deployment config)", async () => {
      const { token } = await seedUserWorkspace();
      // Selecting mock requires the deployment to have opted in; the miniflare
      // env sets no vars, so without this the PUT below is refused and the test
      // would be asserting against a workspace still on its previous provider.
      await withMockSandboxEnabled(async () => {
        await SELF.fetch("https://nadi.test/api/settings/sandbox", {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...cookie(token) },
          body: JSON.stringify({
            enabled: true,
            provider: "mock",
            providerConfig: { kind: "mock" },
          }),
        });

        // No backend override and no credentials: the mock backend is built
        // directly and its `printf nadi-compute-ready` probe round-trips.
        const res = await SELF.fetch("https://nadi.test/api/settings/sandbox/test", {
          method: "POST",
          headers: cookie(token),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, provider: "mock" });
      });
    });

    it("refuses to select mock on a deployment that did not opt in", async () => {
      const { token } = await seedUserWorkspace();
      const res = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({ enabled: true, provider: "mock", providerConfig: { kind: "mock" } }),
      });
      expect(res.status).toBe(400);

      // And the view does not advertise it, so the UI has nothing to render.
      const viewRes = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        headers: cookie(token),
      });
      const view = (await viewRes.json()) as { mockAvailable: boolean };
      expect(view.mockAvailable).toBe(false);
    });

    it("refuses to select cloudflare on celld, which has no containers", async () => {
      const { token } = await seedUserWorkspace();
      await withCelldPlatform(async () => {
        const res = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...cookie(token) },
          body: JSON.stringify({
            enabled: true,
            provider: "cloudflare",
            providerConfig: { kind: "cloudflare" },
          }),
        });
        expect(res.status).toBe(400);

        const viewRes = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
          headers: cookie(token),
        });
        const view = (await viewRes.json()) as { cloudflareAvailable: boolean };
        expect(view.cloudflareAvailable).toBe(false);
      });
    });

    it("still allows cloudflare on a platform that has containers", async () => {
      // The gate must be the PLATFORM, not the provider name: withdrawing it
      // everywhere would break every Cloudflare deployment, which is the only
      // place the provider is meant to work.
      const { token } = await seedUserWorkspace();
      const res = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({
          enabled: true,
          provider: "cloudflare",
          providerConfig: { kind: "cloudflare" },
        }),
      });
      expect(res.status).toBe(200);

      const viewRes = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        headers: cookie(token),
      });
      const view = (await viewRes.json()) as { cloudflareAvailable: boolean };
      expect(view.cloudflareAvailable).toBe(true);
    });

    it("uses the system Daytona key and small system snapshot without a workspace key", async () => {
      const { token } = await seedUserWorkspace();
      await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({
          enabled: true,
          providerConfig: {
            ...daytonaProviderConfig({ kind: "image", value: "workspace-image" }),
            apiUrl: "https://workspace.example",
            target: "workspace-target",
          },
        }),
      });

      const { factory, configs } = spyBackend();
      const restoreBackend = withBackendOverride(factory);
      const restoreKey = withSystemDaytonaKey("system-key");
      try {
        const res = await SELF.fetch("https://nadi.test/api/settings/sandbox/test", {
          method: "POST",
          headers: cookie(token),
        });

        expect(res.status).toBe(200);
        expect(configs).toEqual([
          { apiKey: "system-key", apiUrl: null, target: null, source: { snapshot: "nadi-small" } },
        ]);
      } finally {
        restoreKey();
        restoreBackend();
      }
    });

    it("returns 400 when the Daytona key is missing", async () => {
      const { token } = await seedUserWorkspace();
      await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({
          enabled: true,
          providerConfig: {
            ...daytonaProviderConfig({ kind: "image", value: "node:22" }),
            apiUrl: "https://workspace.example",
            target: "workspace-target",
          },
        }),
      });

      const res = await SELF.fetch("https://nadi.test/api/settings/sandbox/test", {
        method: "POST",
        headers: cookie(token),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; phase: string; error: string };
      expect(body).toEqual({
        ok: false,
        provider: "daytona",
        phase: "connection",
        error: "missing_secret",
      });
    });

    it("acquires, echoes the readiness marker, and discards through an injected fake provider", async () => {
      const { token } = await seedUserWorkspace();
      await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({
          enabled: true,
          providerConfig: {
            ...daytonaProviderConfig({ kind: "image", value: "node:22" }),
            apiUrl: "https://workspace.example",
            target: "workspace-target",
          },
        }),
      });
      await SELF.fetch("https://nadi.test/api/settings/sandbox/daytona-secret", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({ value: "dt_test_secret" }),
      });

      const { factory, acquire, readProcessOutput, release, sources, configs, runtimeRef } =
        spyBackend();
      const restore = withBackendOverride(factory);
      try {
        const res = await SELF.fetch("https://nadi.test/api/settings/sandbox/test", {
          method: "POST",
          headers: cookie(token),
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, provider: "daytona" });
        expect(sources).toEqual([{ image: "node:22" }]);
        expect(configs).toEqual([
          {
            apiKey: "dt_test_secret",
            apiUrl: "https://workspace.example",
            target: "workspace-target",
            source: { image: "node:22" },
          },
        ]);
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(readProcessOutput).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledWith(runtimeRef, { disposition: "discard" });
      } finally {
        restore();
      }
    });

    it("creates and deletes a temporary sandbox for a snapshot-only workspace", async () => {
      const { token } = await seedUserWorkspace();
      await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({
          enabled: true,
          providerConfig: daytonaProviderConfig({ kind: "snapshot", value: "team-snapshot" }),
        }),
      });
      await SELF.fetch("https://nadi.test/api/settings/sandbox/daytona-secret", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({ value: "dt_test_secret" }),
      });

      const { factory, acquire, release, sources, runtimeRef } = spyBackend();
      const restore = withBackendOverride(factory);
      try {
        const res = await SELF.fetch("https://nadi.test/api/settings/sandbox/test", {
          method: "POST",
          headers: cookie(token),
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, provider: "daytona" });
        expect(sources).toEqual([{ snapshot: "team-snapshot" }]);
        expect(sources[0]).not.toHaveProperty("image");
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledWith(runtimeRef, { disposition: "discard" });
      } finally {
        restore();
      }
    });

    it("returns 400 missing_source when both image and snapshot are empty", async () => {
      const { token } = await seedUserWorkspace();
      await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({
          enabled: true,
          providerConfig: {
            ...daytonaProviderConfig({ kind: "snapshot", value: "unused" }),
            profiles: { small: null, medium: null },
          },
        }),
      });
      await SELF.fetch("https://nadi.test/api/settings/sandbox/daytona-secret", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({ value: "dt_test_secret" }),
      });

      const res = await SELF.fetch("https://nadi.test/api/settings/sandbox/test", {
        method: "POST",
        headers: cookie(token),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; phase: string; error: string };
      expect(body).toEqual({
        ok: false,
        provider: "daytona",
        phase: "connection",
        error: "missing_source",
      });
    });

    it("reports a connection-phase failure when acquire throws", async () => {
      const { token } = await seedUserWorkspace();
      await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({
          enabled: true,
          providerConfig: daytonaProviderConfig({ kind: "image", value: "node:22" }),
        }),
      });
      await SELF.fetch("https://nadi.test/api/settings/sandbox/daytona-secret", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({ value: "dt_test_secret" }),
      });

      const { factory } = spyBackend({
        acquire: vi.fn(async () => {
          throw new Error("acquire_boom");
        }),
      });
      const restore = withBackendOverride(factory);
      try {
        const res = await SELF.fetch("https://nadi.test/api/settings/sandbox/test", {
          method: "POST",
          headers: cookie(token),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; provider: string; phase: string };
        expect(body.ok).toBe(false);
        expect(body.provider).toBe("daytona");
        expect(body.phase).toBe("connection");
      } finally {
        restore();
      }
    });

    it("reports a connection-phase failure when the readiness marker does not echo back", async () => {
      const { token } = await seedUserWorkspace();
      await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({
          enabled: true,
          providerConfig: daytonaProviderConfig({ kind: "image", value: "node:22" }),
        }),
      });
      await SELF.fetch("https://nadi.test/api/settings/sandbox/daytona-secret", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({ value: "dt_test_secret" }),
      });

      const { factory, release, runtimeRef } = spyBackend({
        readProcessOutput: vi.fn(async () => ({ stdout: "garbage", stderr: "" })),
      });
      const restore = withBackendOverride(factory);
      try {
        const res = await SELF.fetch("https://nadi.test/api/settings/sandbox/test", {
          method: "POST",
          headers: cookie(token),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; phase: string };
        expect(body.ok).toBe(false);
        expect(body.phase).toBe("connection");
        // Even on an echo mismatch, the probe must still discard the sandbox.
        expect(release).toHaveBeenCalledWith(runtimeRef, { disposition: "discard" });
      } finally {
        restore();
      }
    });

    it("returns 400 with the Cloudflare provider when deployment bindings are missing", async () => {
      const { token } = await seedUserWorkspace();
      await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({
          enabled: true,
          provider: "cloudflare",
          providerConfig: { kind: "cloudflare" },
        }),
      });

      const res = await SELF.fetch("https://nadi.test/api/settings/sandbox/test", {
        method: "POST",
        headers: cookie(token),
      });
      // The miniflare test env binds no NADI_SANDBOX_* / BACKUP_BUCKET, so
      // Cloudflare is not deployable here and the probe fails closed.
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        ok: boolean;
        provider: string;
        phase: string;
        missingConfig: string[];
      };
      expect(body.ok).toBe(false);
      expect(body.provider).toBe("cloudflare");
      expect(body.phase).toBe("connection");
      expect(body.missingConfig.length).toBeGreaterThan(0);
    });

    it("returns 400 missing_secret for sprites with no key configured", async () => {
      const { token } = await seedUserWorkspace();
      await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({
          enabled: true,
          provider: "sprites",
          providerConfig: { kind: "sprites", apiKeySecretName: "sandbox:sprites" },
        }),
      });

      // No workspace secret saved and no SPRITES_API_KEY system key set in
      // this test env, so the resolved config has no key at all.
      const res = await SELF.fetch("https://nadi.test/api/settings/sandbox/test", {
        method: "POST",
        headers: cookie(token),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        ok: false,
        provider: "sprites",
        phase: "connection",
        error: "missing_secret",
      });
      // The ok-path (an authenticated listSprites(1) succeeding) needs a real
      // or mocked sprites.dev endpoint; this suite has no fetch-injection seam
      // for the sprites client (unlike Daytona's COMPUTE_TEST_BACKEND_FACTORY),
      // so that path is left to the live smoke test per the brief.
    });

    it("reports a cleanup-phase failure when release fails after a successful acquire", async () => {
      const { token } = await seedUserWorkspace();
      await SELF.fetch("https://nadi.test/api/settings/sandbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({
          enabled: true,
          providerConfig: daytonaProviderConfig({ kind: "image", value: "node:22" }),
        }),
      });
      await SELF.fetch("https://nadi.test/api/settings/sandbox/daytona-secret", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...cookie(token) },
        body: JSON.stringify({ value: "dt_test_secret" }),
      });

      const { factory } = spyBackend({
        release: vi.fn(async () => {
          throw new Error("cleanup_failed");
        }),
      });
      const restore = withBackendOverride(factory);
      try {
        const res = await SELF.fetch("https://nadi.test/api/settings/sandbox/test", {
          method: "POST",
          headers: cookie(token),
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; phase: string; error: string };
        expect(body.ok).toBe(false);
        expect(body.phase).toBe("cleanup");
      } finally {
        restore();
      }
    });
  });
});

describe("sandbox env-var settings", () => {
  beforeEach(async () => {
    await clearRegistry();
    await clearKv();
    await seedUserWorkspace();
  });

  async function put(path: string, body: unknown) {
    return SELF.fetch(`https://nadi.test${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...cookie("sandbox-owner-token") },
      body: JSON.stringify(body),
    });
  }

  it("saves editable env vars and returns them with values", async () => {
    const res = await put("/api/settings/sandbox/env", { envVars: { NODE_ENV: "production" } });
    expect(res.status).toBe(200);
    const view = (await res.json()) as any;
    expect(view.workspace.envVars).toEqual({ NODE_ENV: "production" });
  });

  it("upserts a secret and returns its name but not its value", async () => {
    const res = await put("/api/settings/sandbox/secret-env", { envVars: { GH_TOKEN: "tok" } });
    expect(res.status).toBe(200);
    const view = (await res.json()) as any;
    expect(view.workspaceSecretEnvVars.map((s: any) => s.name)).toContain("GH_TOKEN");
    expect(JSON.stringify(view)).not.toContain("tok");
  });

  it("rejects a name present in both sets at the same scope", async () => {
    await put("/api/settings/sandbox/env", { envVars: { DUP: "1" } });
    const res = await put("/api/settings/sandbox/secret-env", { envVars: { DUP: "x" } });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid env var name", async () => {
    const res = await put("/api/settings/sandbox/env", { envVars: { "1BAD": "x" } });
    expect(res.status).toBe(400);
  });

  it("returns 400 (not 500) when individually-valid env vars serialize over the total size cap", async () => {
    const envVars = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`BIG_${i}`, "x".repeat(12000)]),
    );
    const res = await put("/api/settings/sandbox/env", { envVars });
    expect(res.status).toBe(400);
  });
});

describe("compute readiness in the settings view", () => {
  beforeEach(async () => {
    await clearRegistry();
    await clearKv();
    await seedUserWorkspace();
  });

  async function getView() {
    const res = await SELF.fetch("https://nadi.test/api/settings/sandbox", {
      method: "GET",
      headers: cookie("sandbox-owner-token"),
    });
    expect(res.status).toBe(200);
    return res.json() as Promise<{
      readiness: {
        daytona: {
          provider: string;
          ready: boolean;
          missingConfig: string[];
          unsupported: string[];
        };
        cloudflare: {
          provider: string;
          ready: boolean;
          missingConfig: string[];
          unsupported: string[];
        };
      };
    }>;
  }

  it("surfaces per-provider readiness; Daytona deployable, Cloudflare gated on unbound config", async () => {
    const view = await getView();
    expect(view.readiness.daytona).toEqual({
      provider: "daytona",
      ready: true,
      missingConfig: [],
      unsupported: [],
    });
    // The miniflare env binds no NADI_SANDBOX_* / BACKUP_BUCKET, so Cloudflare is
    // not deployable here and reports the absent config by NAME.
    expect(view.readiness.cloudflare.ready).toBe(false);
    expect(view.readiness.cloudflare.missingConfig).toContain("NADI_SANDBOX_SMALL");
  });

  it("never leaks a present config value into the serialized readiness view", async () => {
    const sentinel = "R2-SECRET-SENTINEL-DO-NOT-LEAK";
    const previous = (env as unknown as Record<string, unknown>).R2_SECRET_ACCESS_KEY;
    (env as unknown as Record<string, unknown>).R2_SECRET_ACCESS_KEY = sentinel;
    try {
      const view = await getView();
      // Setting it makes it "present" (absent from missingConfig)...
      expect(view.readiness.cloudflare.missingConfig).not.toContain("R2_SECRET_ACCESS_KEY");
      // ...but the VALUE must never appear anywhere in the response.
      expect(JSON.stringify(view)).not.toContain(sentinel);
    } finally {
      if (previous === undefined) {
        delete (env as unknown as Record<string, unknown>).R2_SECRET_ACCESS_KEY;
      } else {
        (env as unknown as Record<string, unknown>).R2_SECRET_ACCESS_KEY = previous;
      }
    }
  });
});

// Exercises `isNetworkRestricted` (src/compute/settings.ts) THROUGH
// `getComputeSettingsView`, end to end — not just `computeProviderReadiness`
// with a hand-passed boolean. A bug that keys off `networkRestrictionEnabled`
// instead of the effective `allowedHosts`, or mishandles `[]`, would ship green
// without this.
describe("isNetworkRestricted derivation through getComputeSettingsView", () => {
  beforeEach(async () => {
    await clearRegistry();
    await clearKv();
  });

  it("flags network_restrictions unsupported when the effective allowlist is a non-empty array", async () => {
    const { token } = await seedUserWorkspace();
    await SELF.fetch("https://nadi.test/api/settings/sandbox", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...cookie(token) },
      body: JSON.stringify({
        enabled: true,
        providerConfig: daytonaProviderConfig({ kind: "snapshot", value: "nadi-small" }),
        networkRestrictionEnabled: true,
        networkDomainAllowlist: "github.com",
      }),
    });
    await SELF.fetch("https://nadi.test/api/settings/sandbox/daytona-secret", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...cookie(token) },
      body: JSON.stringify({ value: "dt_test_secret" }),
    });

    const view = await getComputeSettingsView({ env, workspaceId, agentId: "agent-default" });
    expect(view.effective.enabled).toBe(true);
    expect(
      view.effective.enabled ? (view.effective.value.allowedHosts?.length ?? 0) : 0,
    ).toBeGreaterThan(0);
    expect(view.readiness.cloudflare.unsupported).toEqual(["network_restrictions"]);
    expect(view.readiness.cloudflare.ready).toBe(false);
  });

  it("does not flag network_restrictions when the effective allowlist is an empty array", async () => {
    const { token } = await seedUserWorkspace();
    await SELF.fetch("https://nadi.test/api/settings/sandbox", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...cookie(token) },
      body: JSON.stringify({ enabled: true }),
    });

    // `[]` is not reachable through the real config resolver today (an
    // unconfigured allowlist falls back to the curated default hosts, which
    // is never empty) — so this state is forced via the resolver's exported
    // seam to prove `isNetworkRestricted` treats `[]` as unrestricted, per its
    // own doc comment ("`null` and `[]` both mean unrestricted").
    const spy = vi.spyOn(computeConfig, "resolveEffectiveComputeConfig").mockReturnValue({
      enabled: true,
      value: {
        provider: "daytona",
        providerConfig: {
          kind: "daytona",
          apiKeySecretName: "sandbox:daytona",
          apiUrl: null,
          target: null,
          profiles: { small: null, medium: null },
        },
        resourceProfile: "small",
        idleTimeoutMs: 900_000,
        recoveryTtlMs: 86_400_000,
        maxProcessRuntimeMs: 600_000,
        monitorPollIntervalMs: 2_000,
        limits: DEFAULT_COMPUTE_LIMITS,
        allowedHosts: [],
        editableEnv: {},
        agentEditableEnv: {},
        secretEnvNames: [],
        environmentEditableEnv: {},
        environmentSecretEnvNames: [],
      },
    });
    try {
      const view = await getComputeSettingsView({ env, workspaceId, agentId: "agent-default" });
      expect(view.readiness.cloudflare.unsupported).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not flag network_restrictions when the effective allowlist is null (unrestricted)", async () => {
    const { token } = await seedUserWorkspace();
    await SELF.fetch("https://nadi.test/api/settings/sandbox", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...cookie(token) },
      body: JSON.stringify({
        enabled: true,
        providerConfig: daytonaProviderConfig({ kind: "snapshot", value: "nadi-small" }),
        networkRestrictionEnabled: false,
      }),
    });
    await SELF.fetch("https://nadi.test/api/settings/sandbox/daytona-secret", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...cookie(token) },
      body: JSON.stringify({ value: "dt_test_secret" }),
    });

    const view = await getComputeSettingsView({ env, workspaceId, agentId: "agent-default" });
    expect(view.effective.enabled).toBe(true);
    expect(view.effective.enabled ? view.effective.value.allowedHosts : "n/a").toBeNull();
    expect(view.readiness.cloudflare.unsupported).toEqual([]);
  });
});
