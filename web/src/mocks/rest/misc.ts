/**
 * Auth, skills, memories, MCP, invites, notifications, attachments, and the
 * thread-history endpoints that live outside `/api`.
 *
 * The history handlers matter even though chat itself is faked in-process
 * (Task 4): `ThreadChat` suspends on an HTTP history fetch before the chat hook
 * runs, and an unhandled request there means every thread opens degraded.
 */

import { http, HttpResponse } from "msw";
import { FEATURED_CONNECTIONS, findFeaturedServer } from "../../lib/featured-connections";
import type { McpServer, McpToolView, ToolPolicy } from "../../mcp-api";
import { getStore } from "../store";
import {
  TOOL_RUN_THREAD_ID,
  TOOL_WRITE_THREAD_ID,
  singleMcpWriteTranscript,
  toolRunTranscript,
} from "../chat/tool-run-transcript";
import { MID_TURN_THREAD_ID, midTurnTranscript } from "../chat/mid-turn-transcript";
import { HERO_THREAD_ID, heroTranscript } from "../chat/hero-transcript";
import {
  ASSISTANT_ARTIFACTS_THREAD_ID,
  MOCK_ARTIFACT_ID,
  assistantArtifactTranscript,
  liveArtifactExpiresAt,
} from "../chat/assistant-artifact-transcript";
import {
  ASSISTANT_DOWNLOAD_THREAD_ID,
  assistantDownloadTranscript,
} from "../chat/assistant-download-transcript";
import { historyUnreachable, mockId, notFound, pathParam } from "./util";

const authHandlers = [
  http.get("/api/auth/get-session", () => {
    const session = getStore().session;
    // `getSession` looks for a top-level `user`; anything else is signed out.
    return HttpResponse.json(session.authenticated ? { user: session.user } : {});
  }),
  http.post("/api/auth/email-otp/send-verification-otp", () => HttpResponse.json({ success: true })),
  http.post("/api/auth/sign-in/email-otp", () => {
    const store = getStore();
    return HttpResponse.json(store.session.authenticated ? { user: store.session.user } : {});
  }),
  http.post("/api/auth/sign-out", () => {
    getStore().session = { authenticated: false };
    return HttpResponse.json({ success: true });
  }),
];

/**
 * The mock store keeps ONE flat list of skills and one of memories, so
 * `?agentId=` (which on the real server picks between the workspace library and
 * one agent's private items) is accepted and ignored here. The store's `Skill`
 * and `Memory` are the WIRE types, and neither carries a scope field to filter
 * on. Give them one before writing a mock test that depends on the difference.
 */
const skillHandlers = [
  http.get("/api/skills", ({ request }) => {
    const archived = new URL(request.url).searchParams.get("archived") === "1";
    const skills = getStore().skills.filter((s) => (archived ? s.archivedAt : !s.archivedAt));
    return HttpResponse.json({ skills });
  }),
  http.post("/api/skills/:skillId/enabled", async ({ params, request }) => {
    const skill = getStore().skills.find((s) => s.id === pathParam(params, "skillId"));
    if (!skill) return notFound("That skill");
    const input = (await request.json().catch(() => ({}))) as { enabled?: boolean };
    skill.enabled = input.enabled ?? skill.enabled;
    skill.updatedAt = Date.now();
    return HttpResponse.json({ skill });
  }),
  http.post("/api/skills/:skillId/archive", ({ params }) => {
    const skill = getStore().skills.find((s) => s.id === pathParam(params, "skillId"));
    if (!skill) return notFound("That skill");
    skill.archivedAt = Date.now();
    skill.enabled = false;
    return HttpResponse.json({ skill });
  }),
  http.post("/api/skills/:skillId/restore", ({ params }) => {
    const skill = getStore().skills.find((s) => s.id === pathParam(params, "skillId"));
    if (!skill) return notFound("That skill");
    skill.archivedAt = null;
    return HttpResponse.json({ skill });
  }),
];

const memoryHandlers = [
  http.get("/api/memories", ({ request }) => {
    const archived = new URL(request.url).searchParams.get("archived") === "1";
    const memories = getStore().memories.filter((m) => (archived ? m.archivedAt : !m.archivedAt));
    return HttpResponse.json({ memories });
  }),
  http.post("/api/memories/:memoryId/archive", ({ params }) => {
    const memory = getStore().memories.find((m) => m.id === pathParam(params, "memoryId"));
    if (!memory) return notFound("That memory");
    memory.archivedAt = Date.now();
    return HttpResponse.json({ memory });
  }),
  http.post("/api/memories/:memoryId/restore", ({ params }) => {
    const memory = getStore().memories.find((m) => m.id === pathParam(params, "memoryId"));
    if (!memory) return notFound("That memory");
    memory.archivedAt = null;
    return HttpResponse.json({ memory });
  }),
];

/** Plausible tools for a freshly-authorized featured connection, by which one it is. */
function featuredToolsFor(server: McpServer): McpToolView[] {
  // findFeaturedServer expects (servers, connection); reuse the URL match the
  // other direction instead of duplicating its normalization logic.
  const match = FEATURED_CONNECTIONS.find((c) => findFeaturedServer([server], c) !== null);
  if (match?.id === "markdump") {
    return [
      { name: "read", description: "Read a note.", policy: "approval_required" },
      { name: "write", description: "Write a note.", policy: "approval_required" },
    ];
  }
  if (match?.id === "composio") {
    return [
      { name: "GMAIL_SEND_EMAIL", description: "Send an email from Gmail.", policy: "approval_required" },
      { name: "GOOGLECALENDAR_FIND_EVENT", description: "Find an event on the calendar.", policy: "auto_allow" },
    ];
  }
  return [];
}

const mcpHandlers = [
  http.get("/api/mcp/servers", () => HttpResponse.json({ servers: getStore().mcpServers })),
  http.post("/api/mcp/servers", async ({ request }) => {
    const store = getStore();
    const input = (await request.json().catch(() => ({}))) as { name?: string; url?: string };
    const server: McpServer = {
      id: mockId("mcp"),
      name: input.name ?? "Untitled server",
      url: input.url ?? "",
      enabled: true,
      createdAt: Date.now(),
    };
    store.mcpServers.push(server);
    // Both featured connections are OAuth servers, so a freshly added one comes
    // back needing authorization — that is the state the empower step renders.
    if (FEATURED_CONNECTIONS.some((c) => c.url === server.url)) {
      store.mcpNeedsAuth[server.id] = true;
    }
    return HttpResponse.json({ server }, { status: 201 });
  }),
  http.patch("/api/mcp/servers/:serverId", async ({ params, request }) => {
    const server = getStore().mcpServers.find((s) => s.id === pathParam(params, "serverId"));
    if (!server) return notFound("That MCP server");
    const patch = (await request.json().catch(() => ({}))) as {
      name?: string;
      enabled?: boolean;
    };
    if (typeof patch.name === "string") server.name = patch.name;
    if (typeof patch.enabled === "boolean") server.enabled = patch.enabled;
    return HttpResponse.json({ server });
  }),
  http.delete("/api/mcp/servers/:serverId", ({ params }) => {
    const store = getStore();
    const id = pathParam(params, "serverId");
    store.mcpServers = store.mcpServers.filter((s) => s.id !== id);
    delete store.mcpTools[id];
    delete store.mcpNeedsAuth[id];
    return HttpResponse.json({ ok: true });
  }),
  http.get("/api/mcp/servers/:serverId/tools", ({ params }) => {
    const id = pathParam(params, "serverId");
    const store = getStore();
    const needsAuth = store.mcpNeedsAuth[id] === true;
    return HttpResponse.json({
      needsAuth,
      // A server that needs authorization has not been introspected yet, so it
      // reports no tools — returning tools alongside needsAuth would let the UI
      // render a state the real server cannot produce.
      tools: needsAuth ? [] : (store.mcpTools[id] ?? []),
    });
  }),
  http.post("/api/mcp/servers/:serverId/authorize", ({ params }) => {
    const store = getStore();
    const id = pathParam(params, "serverId");
    if (store.mcpNeedsAuth[id]) {
      // Consent completing is modelled as the authorization clearing; the mock
      // cannot redirect (the real endpoint would return an `authUrl` here), so
      // it reports ready and the UI re-reads the tools.
      store.mcpNeedsAuth[id] = false;
      // A server the real backend just finished authorizing has already been
      // introspected — it would never come back with zero tools. Seed a couple
      // so "Connected" doesn't render a state the real server can't produce.
      if (!store.mcpTools[id] || store.mcpTools[id].length === 0) {
        const server = store.mcpServers.find((s) => s.id === id);
        if (server) store.mcpTools[id] = featuredToolsFor(server);
      }
      return HttpResponse.json({ ready: true });
    }
    return HttpResponse.json({ ready: true });
  }),
  http.put("/api/mcp/servers/:serverId/policies", async ({ params, request }) => {
    const store = getStore();
    const id = pathParam(params, "serverId");
    const input = (await request.json().catch(() => ({}))) as {
      policies?: { toolName: string; policy: ToolPolicy }[];
    };
    const tools = store.mcpTools[id] ?? [];
    for (const { toolName, policy } of input.policies ?? []) {
      const tool = tools.find((t) => t.name === toolName);
      if (tool) tool.policy = policy;
    }
    store.mcpTools[id] = tools;
    return HttpResponse.json({
      policies: tools.map((t) => ({ toolName: t.name, policy: t.policy })),
    });
  }),
];

const inviteHandlers = [
  http.get("/api/invites", () => HttpResponse.json(getStore().invites)),
  http.post("/api/invites", async ({ request }) => {
    const store = getStore();
    const input = (await request.json().catch(() => ({}))) as { email?: string };
    const invite = {
      id: mockId("inv"),
      token: input.email ? null : mockId("tok"),
      email: input.email ?? null,
      status: "pending" as const,
      createdAt: Date.now(),
      claimedAt: null,
      acceptedAt: null,
    };
    store.invites.invites.unshift(invite);
    store.invites.quota = { ...store.invites.quota, used: store.invites.quota.used + 1 };
    return HttpResponse.json({ invite }, { status: 201 });
  }),
  http.delete("/api/invites/:inviteId", ({ params }) => {
    const store = getStore();
    const id = pathParam(params, "inviteId");
    const before = store.invites.invites.length;
    store.invites.invites = store.invites.invites.filter((i) => i.id !== id);
    if (store.invites.invites.length < before) {
      store.invites.quota = {
        ...store.invites.quota,
        used: Math.max(0, store.invites.quota.used - 1),
      };
    }
    return HttpResponse.json({ ok: true });
  }),
  http.get("/api/invites/claim", () => HttpResponse.json({ valid: true, inviterEmail: null })),
  http.post("/api/invites/claim", () => HttpResponse.json({ ok: true })),
];

const notificationHandlers = [
  http.get("/api/notifications/browser", () => HttpResponse.json(getStore().notifications)),
  http.put("/api/notifications/browser/settings", async ({ request }) => {
    const store = getStore();
    const input = (await request.json().catch(() => ({}))) as {
      browserPushEnabled?: boolean;
      pushPreviewEnabled?: boolean;
    };
    // Partial, exactly like the real route: a field that was not sent is left
    // alone rather than reset to a default.
    if (typeof input.browserPushEnabled === "boolean") {
      store.notifications.browserPushEnabled = input.browserPushEnabled;
    }
    if (typeof input.pushPreviewEnabled === "boolean") {
      store.notifications.pushPreviewEnabled = input.pushPreviewEnabled;
    }
    return HttpResponse.json(store.notifications);
  }),
  http.post("/api/notifications/browser/subscriptions", () =>
    HttpResponse.json({ ok: true }, { status: 201 }),
  ),
];

const attachmentHandlers = [
  /**
   * Echo the upload back as a data URL so the composer's preview and the
   * message bubble render the real bytes instead of a broken image.
   */
  http.post("/api/threads/:threadId/attachments", async ({ request }) => {
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return HttpResponse.json({ error: "No file was uploaded." }, { status: 400 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    const mimeType = file.type || "application/octet-stream";
    return HttpResponse.json({
      id: mockId("att"),
      url: `data:${mimeType};base64,${btoa(binary)}`,
      mimeType,
    });
  }),
  http.get("*/api/attachments/:attachmentId", ({ request, params }) => {
    const id = pathParam(params, "attachmentId");
    const download = new URL(request.url).searchParams.get("download");
    const row = getStore().attachments[id];
    return mockPngResponse({
      asDownload: download === "1" || download === "true",
      filename: row?.filename ?? null,
      chart: id === "att_adl_chart",
    });
  }),
];

/** 1×1 PNG used for generic attachment bytes. */
const MOCK_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

/** 240×160 bar chart so the assistant-attachments thumbnail is actually visible. */
const MOCK_CHART_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAPAAAACgCAIAAAC9uXYyAAACLUlEQVR42u3WMRGAMBBFwehCAMVV1LGQFhnYwAlaaGkQgASqG0JmZ56Cf1tcua9TGqZiAgEtAS0BLQEtICWgJaAloCWugPdpkjKUYEGWkADLaCBFtBAC2gBDbSABlpAAy2ggRbQyipaTQpooIEGWkADLaCBBhpooIEGGmiggRbQQAtooIEGGmiggaYNaKAFNNBAAw000EADDTTQAhpoAQ000EADDTTQ+aC3GkkBDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAv3Xsa1JAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBA/wN0XWZpmIDWWKC/ejmkjIAW0BLQEtAS0AJaAloCWgJaAlpAS0BLQEtAS0ALaAloqYMeknuuOCMFpC0AAAAASUVORK5CYII=";

function mockPngResponse(input: {
  asDownload?: boolean;
  filename?: string | null;
  chart?: boolean;
}): Response {
  const binary = atob(input.chart ? MOCK_CHART_PNG_B64 : MOCK_PIXEL_PNG_B64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const headers: Record<string, string> = { "content-type": "image/png" };
  if (input.asDownload) {
    const filename = input.filename?.trim() || "attachment.png";
    headers["content-disposition"] = `attachment; filename="${filename}"`;
  }
  return new Response(bytes, { headers });
}

function feedbackHistory(threadId: string): unknown[] | null {
  const store = getStore();
  if (store.feedback.thread?.threadId !== threadId) return null;
  if (store.feedback.messages.length > 0) return store.feedback.messages;
  const draft = store.feedback.drafts[0];
  const fields = draft?.fields;
  const attachmentIds = draft?.attachmentIds ?? ["att_feedback_screenshot"];
  return [
    {
      id: "msg_feedback_start",
      role: "user",
      parts: [
        {
          type: "text",
          text: fields?.narrative ?? "The screenshot upload froze while I was writing feedback.",
        },
        ...attachmentIds.map((id) => ({
          type: "file",
          attachmentId: id,
          mediaType: "image/png",
          url: `/api/attachments/${id}`,
        })),
      ],
    },
    {
      id: "msg_feedback_followup_1",
      role: "assistant",
      parts: [{ type: "text", text: "Thanks — what did you expect to happen instead?" }],
    },
    {
      id: "msg_feedback_expected",
      role: "user",
      parts: [
        { type: "text", text: fields?.expectedBehavior ?? "The composer should stay editable." },
      ],
    },
    {
      id: "msg_feedback_followup_2",
      role: "assistant",
      parts: [
        { type: "text", text: "Got it. How often does it happen, and how much does it block you?" },
      ],
    },
    {
      id: "msg_feedback_impact",
      role: "user",
      parts: [{ type: "text", text: fields?.impact ?? "It blocks submitting the report." }],
    },
    ...(draft
      ? [
          {
            id: "msg_feedback_draft",
            role: "assistant",
            parts: [
              {
                type: "text",
                text: "I have enough detail to draft this feedback report. Please review it before sending.",
              },
              {
                type: "tool-prepare_feedback_report",
                toolCallId: "call_feedback_mock",
                state: "output-available",
                input: { category: draft.fields.category },
                output: { draft },
              },
            ],
          },
        ]
      : []),
  ];
}

/**
 * Agent transcript endpoints. These are NOT under `/api`, and they are read over
 * plain HTTP by `thread-history-fetch.ts` before any socket is dialled.
 */
function seededHistory(threadId: string): unknown[] | null {
  if (threadId === MID_TURN_THREAD_ID) return midTurnTranscript();
  if (threadId === HERO_THREAD_ID) return heroTranscript();
  if (threadId === TOOL_RUN_THREAD_ID) return toolRunTranscript();
  if (threadId === TOOL_WRITE_THREAD_ID) return singleMcpWriteTranscript();
  if (threadId === ASSISTANT_DOWNLOAD_THREAD_ID) return assistantDownloadTranscript();
  if (threadId === ASSISTANT_ARTIFACTS_THREAD_ID) {
    const artifact = getStore().artifacts[MOCK_ARTIFACT_ID];
    return assistantArtifactTranscript(artifact?.expiresAt ?? liveArtifactExpiresAt());
  }
  return feedbackHistory(threadId);
}

const historyHandlers = [
  http.get("*/think-agents/think-thread-agent/:threadId/get-messages", ({ params }) => {
    const threadId = pathParam(params, "threadId");
    if (historyUnreachable(threadId)) return HttpResponse.error();
    const seeded = seededHistory(threadId);
    if (seeded) return HttpResponse.json({ messages: seeded });
    return HttpResponse.json({ messages: [] });
  }),
];

export const miscHandlers = [
  ...authHandlers,
  ...skillHandlers,
  ...memoryHandlers,
  ...mcpHandlers,
  ...inviteHandlers,
  ...notificationHandlers,
  ...attachmentHandlers,
  ...historyHandlers,
];
