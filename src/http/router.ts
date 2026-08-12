import type { Env } from "../env";
import { routeAuth } from "./auth-routes";
import { routeBootstrap } from "./bootstrap-routes";
import { routeAttachments } from "./attachment-routes";
import { routeArtifacts } from "./artifact-routes";
import { routeFeedback } from "./feedback-routes";
import { routeThreads } from "./thread-routes";
import { routeMcp } from "./mcp-routes";
import { routeSettings } from "./settings-routes";
import { routeSandboxSettings } from "./sandbox-settings-routes";
import { routeGithub } from "./github-routes";
import { routeDebug } from "./debug-routes";
import { routeCompletion } from "./completion-routes";
import { routeSkills } from "./skill-routes";
import { routeMemories } from "./memory-routes";
import { routeProjects } from "./project-routes";
import { routeWorkbenches } from "./workbench-routes";
import { routeNotifications } from "./notification-routes";
import { routeAutomata } from "./automaton-routes";
import { routeInvites } from "./invite-routes";

export async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const debug = await routeDebug(req, env);
  if (debug) return debug;
  // Unauthenticated by design — gated only by the completion HMAC, since a
  // sandbox posting here has no session. Must sit before the authenticated
  // routes below.
  const completion = await routeCompletion(req, env);
  if (completion) return completion;
  const auth = await routeAuth(req, env);
  if (auth) return auth;
  const invites = await routeInvites(req, env);
  if (invites) return invites;
  const bootstrap = await routeBootstrap(req, env);
  if (bootstrap) return bootstrap;
  const projects = await routeProjects(req, env);
  if (projects) return projects;
  const workbenches = await routeWorkbenches(req, env);
  if (workbenches) return workbenches;
  const feedback = await routeFeedback(req, env, ctx);
  if (feedback) return feedback;
  const attachments = await routeAttachments(req, env);
  if (attachments) return attachments;
  const artifacts = await routeArtifacts(req, env);
  if (artifacts) return artifacts;
  const threads = await routeThreads(req, env, ctx);
  if (threads) return threads;
  const automata = await routeAutomata(req, env, ctx);
  if (automata) return automata;
  const mcp = await routeMcp(req, env);
  if (mcp) return mcp;
  const skills = await routeSkills(req, env);
  if (skills) return skills;
  const memories = await routeMemories(req, env);
  if (memories) return memories;
  const notifications = await routeNotifications(req, env);
  if (notifications) return notifications;
  const sandboxSettings = await routeSandboxSettings(req, env);
  if (sandboxSettings) return sandboxSettings;
  const github = await routeGithub(req, env);
  if (github) return github;
  const settings = await routeSettings(req, env, ctx);
  if (settings) return settings;
  return Response.json({ ok: true, route: "root" });
}
