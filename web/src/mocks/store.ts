/**
 * Mutable in-memory database backing the mocked app (`mock.html`).
 *
 * Dev-only. Nothing reachable from `web/index.html` may import this module —
 * see the isolation guard in `scripts/check-mock-isolation.mjs`.
 *
 * The store is deliberately plain data using the REAL wire types from the
 * `*-api.ts` modules, so a shape drift in production types breaks the mock at
 * typecheck time rather than silently rendering a fiction.
 *
 * `scenarios/index.ts` imports only the TYPES from here, so the value-level
 * dependency runs one way (store -> scenarios) with no runtime cycle.
 */

import type { AuthSession } from "../auth-api";
import type { AutomatonSummary } from "../automata-api";
import type { FeedbackDraftView, FeedbackReportDetail } from "../feedback-api";
import type { GithubRepo, GithubSettings } from "../github-api";
import type { InvitesResponse } from "../invites-api";
import type { McpServer, McpToolView } from "../mcp-api";
import type { Memory } from "../memory-api";
import type { BrowserNotificationsResponse } from "../notifications-api";
import type { ProjectSummary } from "../projects-api";
import type { SandboxSettingsResponse } from "../sandbox-settings-api";
import type { AgentSettingsResponse, PrivacySettings, WebToolsSettings } from "../settings-api";
import type { Skill } from "../skills-api";
import type { ThreadSummary } from "../threads-api";
import type { VoiceSettingsResponse } from "../voice-settings-api";
import type { UserPreferences } from "../user-preferences-api";
import type { AgentSummary } from "../agents-api";
import { SCENARIOS } from "./scenarios";

/**
 * Failures a scenario asks the handlers to inject.
 *
 * Kept as explicit data rather than sniffed out of the seeded rows: a handler
 * that infers "this is the error scenario" from a thread title silently stops
 * failing the day someone reworders the fixture.
 */
/** Ephemeral HTML artifact row backing GET /api/artifacts/:id. */
export interface MockArtifact {
  id: string;
  threadId: string;
  title: string;
  entryPath: string;
  fileCount: number;
  byteSize: number;
  expiresAt: number;
  status: "active" | "expired";
  createdAt: number;
  /** When true, republish fails because the stored files were already swept. */
  filesGone?: boolean;
}

/** Committed (or pending) attachment row backing the thread artifacts list. */
export interface MockAttachment {
  id: string;
  threadId: string;
  filename: string | null;
  mimeType: string;
  byteSize: number;
  status: "pending" | "committed";
  createdAt: number;
}

export interface MockFaults {
  /**
   * Thread ids whose history load fails at the TRANSPORT level, i.e. the fetch
   * rejects. That is the only failure that trips `ThreadHistoryErrorBoundary` —
   * `fetchThreadHistoryDetailed` turns a non-ok status into a degraded empty
   * transcript instead of throwing, which renders "No messages yet".
   */
  historyUnreachableThreadIds: string[];
  /**
   * When set, `POST /api/threads/:threadId/messages` waits this many ms and then
   * fails. The delay is the point: it makes the optimistic first-message bubble
   * observable in `sending` before it settles into `failed` with a Retry.
   */
  messageSendFailsAfterMs: number | null;
  /** Force feedback message submission to fail so the manual fallback renders. */
  feedbackModelFails: boolean;
  /** When set, feedback message submission returns 429 with this Retry-After. */
  feedbackRateLimitedRetryAfterSeconds: number | null;
}

export interface MockStore {
  session: AuthSession;
  settings: AgentSettingsResponse | null;
  threads: ThreadSummary[];
  projects: ProjectSummary[];
  agents: AgentSummary[];
  automata: AutomatonSummary[];
  skills: Skill[];
  memories: Memory[];
  mcpServers: McpServer[];
  /** Keyed by MCP server id. Absent = the server exposes no tools. */
  mcpTools: Record<string, McpToolView[]>;
  /** Server ids that report `needsAuth` until authorize is called for them. */
  mcpNeedsAuth: Record<string, boolean>;
  invites: InvitesResponse;
  github: GithubSettings;
  /** Flat list; the handler pages over it by `installationId`. */
  githubRepositories: GithubRepo[];
  notifications: BrowserNotificationsResponse;
  webTools: WebToolsSettings;
  privacy: PrivacySettings;
  sandbox: SandboxSettingsResponse;
  /** Whether the scenario's operator-provided Daytona configuration is complete. */
  daytonaSystemAvailable: boolean;
  voice: VoiceSettingsResponse;
  preferences: UserPreferences;
  features: {
    feedbackAdmin: boolean;
    /** Workspace-effective background work capability returned by bootstrap. */
    backgroundWork: boolean;
    agentNetworkAllowlist: boolean;
  };
  feedback: {
    thread: ThreadSummary | null;
    drafts: FeedbackDraftView[];
    reports: FeedbackReportDetail[];
    seenReportIds: string[];
    messages: unknown[];
    transcriptsByReportId: Record<string, unknown[]>;
  };
  /** Keyed by artifact id. Seeded by scenarios that exercise artifact chips. */
  artifacts: Record<string, MockArtifact>;
  /** Keyed by attachment id. Seeded by scenarios that exercise downloads. */
  attachments: Record<string, MockAttachment>;
  faults: MockFaults;
}

let store: MockStore | null = null;

/** The active store. Throws if a scenario was never seeded — a mock that
 *  silently serves an empty database is indistinguishable from a broken one. */
export function getStore(): MockStore {
  if (!store) throw new Error("Mock store not seeded. Call seedStore(name) first.");
  return store;
}

export function resetStore(): void {
  store = null;
}

/** Replaces the store with a fresh instance of the named scenario.
 *  An unknown name falls back to `default` with a warning — a typo in the URL
 *  should still render an app rather than a blank page. */
export function seedStore(name: string): MockStore {
  const build = SCENARIOS[name];
  if (!build) {
    console.warn(
      `[mock] unknown scenario "${name}"; falling back to "default". Known: ${Object.keys(SCENARIOS).join(", ")}`,
    );
  }
  const fallback = SCENARIOS.default;
  if (!build && !fallback) throw new Error("[mock] no default scenario registered");
  store = (build ?? fallback!)();
  return store;
}
