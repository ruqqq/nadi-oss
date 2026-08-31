/**
 * `/api/bootstrap` — the single most important handler in the mock.
 *
 * Two reasons:
 *  1. The wire shape is NOT `BootstrapData`. `bootstrap-api.ts` reads a nested
 *     `session: {authenticated, user}` and derives `voiceEnabled`/`workersAiEnabled`
 *     from `features: {voiceInput, workersAi, feedbackAdmin, backgroundWork,
 *     agentNetworkAllowlist}`. `backgroundWork` is workspace-effective.
 *     Send the flat interface and the
 *     app renders signed-out.
 *  2. This endpoint doubles as the app's reachability probe. Without it the
 *     probe fails, the app latches offline, and the shell flips to the sign-in
 *     gate a second or so after first paint.
 *
 * The cursor field is `threadsNextCursor` here and `nextCursor` on
 * `/api/threads`. They are not interchangeable.
 */

import { http, HttpResponse } from "msw";
import { getStore } from "../store";
import { encodeCursor } from "./util";

/** Matches the server's first-page cap; the app pages from here via
 *  `/api/threads?cursor=`. */
const BOOTSTRAP_PAGE_SIZE = 25;

export const bootstrapHandlers = [
  http.get("/api/bootstrap", () => {
    const store = getStore();
    const active = [...store.threads]
      .filter((t) => t.status === "active" && t.kind !== "feedback")
      .sort((a, b) => b.updatedAt - a.updatedAt);

    return HttpResponse.json({
      // The deployment name, which the app uses as its document title. Sent
      // here so the mocked app titles its tab the same way the real one does.
      appName: "Nadi",
      session: store.session,
      settings: store.settings,
      threads: active.slice(0, BOOTSTRAP_PAGE_SIZE),
      threadsNextCursor:
        active.length > BOOTSTRAP_PAGE_SIZE ? encodeCursor(BOOTSTRAP_PAGE_SIZE) : null,
      projects: store.projects.filter((p) => p.archivedAt === null),
      // Same AgentSummary shape GET /api/agents returns (see mocks/rest/agents.ts)
      // — bootstrap is a first-paint alias for the same list, not a lighter one.
      agents: store.agents.filter((a) => a.archivedAt === null),
      features: {
        voiceInput: false,
        workersAi: false,
        feedbackAdmin: store.features.feedbackAdmin,
        backgroundWork: store.features.backgroundWork,
        agentNetworkAllowlist: store.features.agentNetworkAllowlist,
      },
    });
  }),
];
