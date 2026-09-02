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
import type { Skill } from "../../skills-api";
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
 * `?agentId=` picks the SCOPE, exactly as the server does: absent means the
 * workspace library (`store.skills`), present means that one agent's private
 * skills (`store.agentSkills[agentId]`). Every handler on this route resolves
 * it the same way — a lookup that searched only the library would 404 an
 * agent's own skill, and a listing that ignored the parameter would render a
 * state the real app cannot produce (the agent's Skills panel and
 * `/api/agents/:id/skills` disagreeing about the same agent).
 *
 * Memories still keep ONE flat list; `Memory` carries no scope field to filter
 * on. Give it one before writing a mock test that depends on the difference.
 */
function skillScope(requestUrl: string): { list: Skill[]; agentId: string | null } {
  const agentId = new URL(requestUrl).searchParams.get("agentId");
  const store = getStore();
  if (!agentId) return { list: store.skills, agentId: null };
  // Materialise the bucket so a later write into it mutates the store.
  const own = (store.agentSkills[agentId] ??= []);
  return { list: own, agentId };
}

/**
 * How many agents a library skill is live on — the server's rule: unarchived
 * agents, minus those that excluded it, minus those whose own skill of that
 * name shadows it. A DISABLED agent still counts. An archived or agent-private
 * skill is live on nobody.
 */
function liveOnAgentCount(skill: Skill): number {
  const store = getStore();
  if (skill.archivedAt) return 0;
  if (!store.skills.some((s) => s.id === skill.id)) return 0;
  return store.agents.filter((agent) => {
    if (agent.archivedAt) return false;
    if ((store.skillExclusions[agent.id] ?? []).includes(skill.id)) return false;
    return !(store.agentSkills[agent.id] ?? []).some(
      (own) => own.name === skill.name && !own.archivedAt,
    );
  }).length;
}

/**
 * The two name failures the server can answer with, verbatim, so a mocked
 * collision renders the same sentence the real one does
 * (`nameError` in `src/http/skill-routes.ts`).
 */
const SKILL_NAME_MESSAGE =
  "A skill name can only use lowercase letters, numbers, dashes and underscores";
const SKILL_DUPLICATE_MESSAGE = "A skill with this name is already active";

/**
 * `normalizeSkillName`'s rule, re-stated (the real one lives in a repository
 * that pulls in drizzle and cannot be imported into the web bundle): trim,
 * lowercase, whitespace to dashes, then `^[a-z0-9_-]{1,80}$` or nothing.
 */
function normalizeSkillName(raw: string): string | null {
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, "-");
  if (!normalized || normalized.length > 80 || !/^[a-z0-9_-]+$/.test(normalized)) return null;
  return normalized;
}

/** The server's body validation: three string fields, all required on create. */
function badSkillFields(input: Record<string, unknown>, require: boolean): string | null {
  for (const field of ["name", "description", "body"] as const) {
    const value = input[field];
    if (value === undefined) {
      if (require) return `${field} is required`;
      continue;
    }
    if (typeof value !== "string") return `${field} must be a string`;
  }
  return null;
}

/** Library rows come back name-ordered and count-annotated, as the server's do. */
function byName(a: Skill, b: Skill) {
  return a.name.localeCompare(b.name);
}

const skillHandlers = [
  http.get("/api/skills", ({ request }) => {
    const archived = new URL(request.url).searchParams.get("archived") === "1";
    const { list, agentId } = skillScope(request.url);
    const scoped = list.filter((s) => (archived ? s.archivedAt : !s.archivedAt)).sort(byName);
    // The count is a LIBRARY-scope field, and never sent on the archived tab:
    // on an agent's own skills it would always read 1, and its presence would
    // imply the skill is shared; on an archived row the server's
    // `countAgentsLiveOn` requires `archived_at IS NULL`, so it skips the query
    // rather than sending a zero (`src/http/skill-routes.ts` `listSkills`).
    // Absent is not zero — sending 0 here would render a state the real app
    // cannot produce.
    if (agentId || archived) return HttpResponse.json({ skills: scoped });
    return HttpResponse.json({
      skills: scoped.map((s) => ({ ...s, liveOnAgentCount: liveOnAgentCount(s) })),
    });
  }),
  // Library CRUD. The scope is `?agentId=` like every other write here, so the
  // same handler serves an agent's private skills — the settings tab only ever
  // calls the library form.
  http.post("/api/skills", async ({ request }) => {
    const { list } = skillScope(request.url);
    const input = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const invalid = badSkillFields(input, true);
    if (invalid) return HttpResponse.text(invalid, { status: 400 });
    const name = normalizeSkillName(String(input.name));
    if (!name) return HttpResponse.text(SKILL_NAME_MESSAGE, { status: 400 });
    if (list.some((s) => s.name === name && !s.archivedAt))
      return HttpResponse.text(SKILL_DUPLICATE_MESSAGE, { status: 409 });
    const now = Date.now();
    const skill: Skill = {
      id: mockId("skl"),
      name,
      description: String(input.description),
      body: String(input.body),
      enabled: true,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    list.push(skill);
    // 201, and no `liveOnAgentCount`: the server's create returns the plain
    // `serialize`, so a mock that annotated it would let the client depend on a
    // field the real route never sends.
    return HttpResponse.json({ skill }, { status: 201 });
  }),
  http.patch("/api/skills/:skillId", async ({ params, request }) => {
    const { list } = skillScope(request.url);
    const skill = list.find((s) => s.id === pathParam(params, "skillId") && !s.archivedAt);
    if (!skill) return notFound("That skill");
    const input = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const invalid = badSkillFields(input, false);
    if (invalid) return HttpResponse.text(invalid, { status: 400 });
    if (input.name !== undefined) {
      const name = normalizeSkillName(String(input.name));
      if (!name) return HttpResponse.text(SKILL_NAME_MESSAGE, { status: 400 });
      if (name !== skill.name && list.some((s) => s.name === name && !s.archivedAt))
        return HttpResponse.text(SKILL_DUPLICATE_MESSAGE, { status: 409 });
      skill.name = name;
    }
    if (input.description !== undefined) skill.description = String(input.description);
    if (input.body !== undefined) skill.body = String(input.body);
    skill.updatedAt = Date.now();
    return HttpResponse.json({ skill });
  }),
  http.post("/api/skills/:skillId/enabled", async ({ params, request }) => {
    const skill = skillScope(request.url).list.find((s) => s.id === pathParam(params, "skillId"));
    if (!skill) return notFound("That skill");
    const input = (await request.json().catch(() => ({}))) as { enabled?: boolean };
    skill.enabled = input.enabled ?? skill.enabled;
    skill.updatedAt = Date.now();
    return HttpResponse.json({ skill });
  }),
  http.post("/api/skills/:skillId/archive", ({ params, request }) => {
    const skill = skillScope(request.url).list.find((s) => s.id === pathParam(params, "skillId"));
    if (!skill) return notFound("That skill");
    // `archiveById` writes archivedAt and updatedAt ONLY. Clearing `enabled`
    // here made an archive->restore round trip come back disabled, which the
    // real app cannot produce.
    skill.archivedAt = Date.now();
    skill.updatedAt = Date.now();
    return HttpResponse.json({ skill });
  }),
  http.post("/api/skills/:skillId/restore", ({ params, request }) => {
    const { list } = skillScope(request.url);
    const skill = list.find((s) => s.id === pathParam(params, "skillId"));
    if (!skill) return notFound("That skill");
    // The partial unique index is on ACTIVE names, so restoring onto a name
    // something else has taken since is the server's 409 - the one failure this
    // route has, and it was undrivable in the mocked app.
    if (list.some((s) => s.id !== skill.id && s.name === skill.name && !s.archivedAt))
      return HttpResponse.text("A skill with this name is already active", { status: 409 });
    skill.archivedAt = null;
    skill.updatedAt = Date.now();
    return HttpResponse.json({ skill });
  }),

  // Promote an agent's private skill into the library: the SAME row moves, so
  // it keeps its id — a copy here would let the mock disagree with the server
  // about whether the id in hand still resolves.
  http.post("/api/skills/:skillId/move-to-library", ({ params, request }) => {
    const store = getStore();
    const { list, agentId } = skillScope(request.url);
    if (!agentId)
      return HttpResponse.text("Name the agent this skill belongs to with ?agentId=", {
        status: 400,
      });
    const index = list.findIndex(
      (s) => s.id === pathParam(params, "skillId") && !s.archivedAt,
    );
    const skill = list[index];
    if (!skill) return notFound("That skill");
    if (store.skills.some((s) => s.name === skill.name && !s.archivedAt))
      return HttpResponse.text("A library skill with this name is already active", { status: 409 });
    list.splice(index, 1);
    skill.updatedAt = Date.now();
    store.skills.push(skill);
    return HttpResponse.json({ skill });
  }),

  // Fork a skill onto one agent: a NEW id, and the source stays where it was.
  http.post("/api/skills/:skillId/copy-to-agent", async ({ params, request }) => {
    const store = getStore();
    const { list } = skillScope(request.url);
    const input = (await request.json().catch(() => ({}))) as { agentId?: string };
    if (!input.agentId) return HttpResponse.text("agentId must be a string", { status: 400 });
    if (!store.agents.some((a) => a.id === input.agentId)) return notFound("That agent");
    const source = list.find((s) => s.id === pathParam(params, "skillId") && !s.archivedAt);
    if (!source) return notFound("That skill");
    const own = (store.agentSkills[input.agentId] ??= []);
    if (own.some((s) => s.name === source.name && !s.archivedAt))
      return HttpResponse.text("That agent already has a skill with this name", { status: 409 });
    const skill: Skill = { ...source, id: mockId("skl"), createdAt: Date.now(), updatedAt: Date.now() };
    own.push(skill);
    return HttpResponse.json({ skill });
  }),

  // The agent-scoped view: the WHOLE library annotated for this agent, plus
  // the agent's own. Deliberately not the post-exclusion set the model loads —
  // an excluded row has to stay listed or the toggle has nothing to turn on.
  http.get("/api/agents/:agentId/skills", ({ params }) => {
    const store = getStore();
    const agentId = pathParam(params, "agentId");
    if (!store.agents.some((a) => a.id === agentId)) return notFound("That agent");
    const own = store.agentSkills[agentId] ?? [];
    const excluded = store.skillExclusions[agentId] ?? [];
    const library = store.skills
      .filter((s) => !s.archivedAt)
      .sort(byName)
      .map((s) => ({
        ...s,
        excluded: excluded.includes(s.id),
        shadowedByOwnSkillId:
          own.find((o) => o.name === s.name && !o.archivedAt)?.id ?? null,
      }));
    return HttpResponse.json({ library, own: own.filter((s) => !s.archivedAt).sort(byName) });
  }),
  http.post("/api/agents/:agentId/skills/:skillId/exclusion", async ({ params, request }) => {
    const store = getStore();
    const agentId = pathParam(params, "agentId");
    const skillId = pathParam(params, "skillId");
    if (!store.agents.some((a) => a.id === agentId)) return notFound("That agent");
    // Only a live LIBRARY skill can be excluded, exactly as the server rules —
    // an agent's private skill is archived, not excluded.
    if (!store.skills.some((s) => s.id === skillId && !s.archivedAt)) return notFound("That skill");
    const input = (await request.json().catch(() => ({}))) as { excluded?: boolean };
    const current = store.skillExclusions[agentId] ?? [];
    store.skillExclusions[agentId] = input.excluded
      ? current.includes(skillId)
        ? current
        : [...current, skillId]
      : current.filter((id) => id !== skillId);
    return new HttpResponse(null, { status: 204 });
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
