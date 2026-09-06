/**
 * D1-backed coverage for signed-upload approval: known hosts (workspace
 * allowlist ∪ workbench additions ∪ enabled MCP hosts) skip HITL; unknown
 * hosts still require it.
 */
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolSet } from "ai";
import {
  createFileTransferTools,
  loadTrustedUploadHosts,
} from "../../src/agent/file-transfer-tools";
import type { Env } from "../../src/env";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

const WORKSPACE_ID = "ws-upload-approval";
const THREAD_ID = "thr-upload-approval";
const WORKBENCH_ID = "wb-upload-approval";
const NOW = 1_800_000_000_000;

beforeAll(async () => {
  await applyRegistryTestSchema(env.REGISTRY_DB);
});

async function seedKnownHosts() {
  const { threadId, workspaceId } = await seedRegistryThread(env.REGISTRY_DB, {
    threadId: THREAD_ID,
    workspaceId: WORKSPACE_ID,
  });
  await env.REGISTRY_DB.prepare(
    `INSERT INTO workspace_sandbox_settings
      (workspace_id, enabled, provider, provider_config_json,
       image, idle_timeout_ms, recovery_ttl_ms, max_process_runtime_ms, limits_json,
       network_restriction_enabled, network_domain_allowlist)
     VALUES (?, 1, 'cloudflare', ?, '', 900000, 86400000, 600000, '{}', 0, ?)`,
  )
    .bind(workspaceId, JSON.stringify({ kind: "cloudflare" }), "files.example\n*.github.com")
    .run();
  await env.REGISTRY_DB.prepare(
    `INSERT INTO workbenches
      (id, workspace_id, name, sandbox_env_vars_json, sandbox_network_domain_allowlist, created_at, updated_at)
     VALUES (?, ?, 'Upload bench', '{}', 'uploads.workbench.test', ?, ?)`,
  )
    .bind(WORKBENCH_ID, workspaceId, NOW, NOW)
    .run();
  await env.REGISTRY_DB.prepare(
    `INSERT INTO thread_workbench_snapshots
      (thread_id, workspace_id, workbench_id, name, setup_script, resource_profile, created_at)
     VALUES (?, ?, ?, 'Upload bench', '', 'small', ?)`,
  )
    .bind(threadId, workspaceId, WORKBENCH_ID, NOW)
    .run();
  await env.REGISTRY_DB.prepare(
    `INSERT INTO mcp_servers (id, workspace_id, name, url, enabled, created_at)
     VALUES
       ('mcp_upload_enabled', ?, 'Enabled MCP', 'https://mcp.acme.com/sse', 1, ?),
       ('mcp_upload_disabled', ?, 'Disabled MCP', 'https://disabled.acme.com/sse', 0, ?)`,
  )
    .bind(workspaceId, NOW, workspaceId, NOW)
    .run();
  return { threadId, workspaceId };
}

async function needsApprovalFor(signedUploadUrl: string): Promise<boolean> {
  const tools: ToolSet = createFileTransferTools({
    env: env as unknown as Env,
    threadId: THREAD_ID,
  });
  const needsApproval = tools.upload_to_signed_url?.needsApproval;
  if (typeof needsApproval !== "function") throw new Error("expected needsApproval function");
  return needsApproval(
    { source: { kind: "attachment", attachmentId: "att_1" }, signedUploadUrl },
    { toolCallId: "tc_1", messages: [] },
  );
}

describe("signed-upload approval against known hosts", () => {
  it("loads the workspace allowlist, workbench additions, and enabled MCP hosts", async () => {
    await seedKnownHosts();

    const hosts = await loadTrustedUploadHosts(env as unknown as Env, THREAD_ID);
    expect(hosts).toEqual(
      expect.arrayContaining([
        "files.example",
        "*.github.com",
        "uploads.workbench.test",
        "mcp.acme.com",
      ]),
    );
    expect(hosts).not.toContain("disabled.acme.com");
  });

  it("skips approval for known hosts and requires it for unknown ones", async () => {
    await seedKnownHosts();

    expect(await needsApprovalFor("https://files.example/upload?sig=secret")).toBe(false);
    expect(await needsApprovalFor("https://objects.github.com/upload")).toBe(false);
    expect(await needsApprovalFor("https://uploads.workbench.test/put")).toBe(false);
    expect(await needsApprovalFor("https://mcp.acme.com/files")).toBe(false);
    expect(await needsApprovalFor("https://unknown.example/upload")).toBe(true);
    expect(await needsApprovalFor("https://disabled.acme.com/upload")).toBe(true);
  });
});
