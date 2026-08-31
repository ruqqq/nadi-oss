import { routeAgentRequest } from "agents";
import { handleArtifactHostRequest } from "./artifacts/serve";
import type { Env } from "./env";
import { authorizeAgentRequest } from "./agent-routing/authorize";
import { rewriteToPublicOrigin } from "./agent-routing/public-origin";
import { VOICE_PARTY_PREFIX, rewriteVoiceRoom } from "./agent-routing/voice-room";
import { validateRequestSession } from "./auth/session";
import { canonicalRedirectUrl } from "./http/canonical-host";
import { route } from "./http/router";
import { log, setLogLevel } from "./log";
import { CRON_LAST_DAILY_RUN_KEY, CRON_LAST_TICK_KEY, stampCronRun } from "./celld/cron-liveness";
import { autoArchiveIdleThreads } from "./agent/auto-archive";
import { AUTOMATA_CRON, fireDueAutomata } from "./automata/fire-due";
import { repairStaleThreadSearchProjections } from "./thread-knowledge/repair";
export { ThinkThreadAgent } from "./agent/think-thread-agent";
export { SubAgent } from "./agent/subagent";
export { WorkspaceMcpAgent } from "./agent/workspace-mcp-agent";
export { UserHub } from "./agent/user-hub";
export { VoiceAgent } from "./agent/voice-agent";
export {
  ContainerProxy,
  NadiSandboxSmall,
  NadiSandboxMedium,
} from "./compute/cloudflare-sandbox-classes";
export { AgentSandbox } from "./compute/agent-sandbox-do";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    setLogLevel(env.LOG_LEVEL);
    log.debug("worker.fetch", { method: req.method, url: req.url });

    const url = new URL(req.url);
    const artifactsHost = (env.ARTIFACTS_HOST ?? "").trim().toLowerCase();
    if (artifactsHost !== "" && url.hostname.toLowerCase() === artifactsHost) {
      return handleArtifactHostRequest(req, env);
    }

    const canonical = canonicalRedirectUrl(url, env);
    if (canonical !== null) {
      return Response.redirect(canonical, 308);
    }

    // /api/auth/* → Better Auth (no change)
    if (url.pathname.startsWith("/api/auth/")) {
      return route(req, env, ctx);
    }

    // MCP OAuth callback: the OAuth provider redirects here anonymously (a plain
    // GET with ?code&state) after consent. Do NOT run authorizeAgentRequest — the
    // request carries no session and the Agents SDK validates the `state` param
    // itself. routeAgentRequest forwards to the originating WorkspaceMcpAgent DO,
    // whose auto-wrapped onRequest completes the code exchange.
    //
    // Scope tightly to a non-WebSocket GET: the callback is always a GET redirect,
    // so this does NOT expose the DO's @callable RPC (which needs a WebSocket
    // upgrade) to unauthenticated callers. WS / non-GET requests to this path fall
    // through to the session guard below (which 404s a non-thread-agent path).
    if (
      url.pathname.startsWith("/agents/workspace-mcp-agent/") &&
      req.method === "GET" &&
      req.headers.get("upgrade")?.toLowerCase() !== "websocket"
    ) {
      // Behind a TLS-terminating proxy the Worker sees http:// while the OAuth
      // provider was given the https:// callback built from APP_BASE_URL. The
      // SDK matches by origin, so without this the callback falls through to
      // the base onRequest and answers "Not implemented". No-op wherever the
      // request already arrives on the public origin.
      const publicUrl = rewriteToPublicOrigin(url, env.APP_BASE_URL);
      const forwarded = publicUrl ? new Request(publicUrl, req) : req;
      return (
        (await routeAgentRequest(forwarded, env)) ?? new Response("Not found", { status: 404 })
      );
    }

    if (url.pathname.startsWith("/think-agents/")) {
      const authz = await authorizeAgentRequest(req, env);
      if (!authz.authorized) return authz.response;
      return (
        (await routeAgentRequest(req, env, { prefix: "think-agents" })) ??
        new Response("Not found", { status: 404 })
      );
    }

    // Voice dictation. The Agents/PartySocket client picks the room, so we
    // discard it and route to the DO named for the authenticated user — the
    // client can never reach another user's VoiceAgent.
    if (url.pathname.startsWith(VOICE_PARTY_PREFIX)) {
      const session = await validateRequestSession(env, req);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const rewritten = new Request(rewriteVoiceRoom(url, session.user.id), req);
      return (
        (await routeAgentRequest(rewritten, env)) ?? new Response("Not found", { status: 404 })
      );
    }

    // /agents/* → validate the Better Auth session and authorize the registered
    // thread workspace before handing off to the Agents SDK.
    if (url.pathname.startsWith("/agents/")) {
      const authz = await authorizeAgentRequest(req, env);
      if (!authz.authorized) return authz.response;
      return (await routeAgentRequest(req, env)) ?? new Response("Not found", { status: 404 });
    }

    // /live → user-scoped live-update hub. The DO id is derived from the
    // authenticated session (never from a client-supplied name), so a client
    // can only ever subscribe to its own hub.
    if (url.pathname === "/live") {
      const session = await validateRequestSession(env, req);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const id = env.USER_HUB.idFromName(session.user.id);
      return env.USER_HUB.get(id).fetch(req);
    }

    if (url.pathname.startsWith("/api/")) {
      return route(req, env, ctx);
    }

    return env.ASSETS?.fetch(req) ?? route(req, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    setLogLevel(env.LOG_LEVEL);
    // celld-only liveness marker, best-effort and a no-op on Cloudflare. Both
    // platforms run this same handler now — celld v0.3.0 runs cron natively —
    // but only celld has no dashboard to ask whether it fired.
    // `controller.scheduledTime` is the OCCURRENCE, not the moment the handler
    // started, which is what makes a late run distinguishable from a missed one.
    await stampCronRun(env, CRON_LAST_TICK_KEY, controller.scheduledTime);
    if (controller.cron === AUTOMATA_CRON) {
      const result = await fireDueAutomata(env);
      log.info("worker.scheduled.automata", result);
      return;
    }
    const result = await autoArchiveIdleThreads(env);
    log.info("worker.scheduled.auto_archive", result);
    const repairResult = await repairStaleThreadSearchProjections(env);
    log.info("worker.scheduled.thread_search_repair", repairResult);
    // Stamped only after the sweep succeeds: a throw above leaves the marker
    // untouched, so the endpoint shows the last run that actually completed.
    await stampCronRun(env, CRON_LAST_DAILY_RUN_KEY, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
