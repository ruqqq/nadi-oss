import { getAgentByName } from "agents";
import type { Env } from "../env";
import { deriveCompletionSecret, verifyCompletionToken } from "../compute/completion-token";

/** RPC surface this route calls on the thread's `ThinkThreadAgent` DO. */
interface CompletionThreadStub {
  reportProcessCompletion(input: {
    processId: string;
    exitCode: number;
  }): Promise<{ accepted: boolean; reason?: string }>;
}

/**
 * The push half of background-work completion. Unauthenticated by design —
 * there is no session inside a sandbox — so the HMAC is the entire gate, and
 * the token is scoped to one `(threadId, processId)` pair. The body's
 * `processId` must match the token's: without that check a valid token could
 * report a *different* process in the same thread.
 */
export async function routeCompletion(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== "/api/compute/completion" || req.method !== "POST") return null;

  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const secret = await deriveCompletionSecret(env.BETTER_AUTH_SECRET);
  const claims = await verifyCompletionToken(secret, token, Date.now());
  if (!claims) return Response.json({ error: "invalid_token" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { processId?: string; exitCode?: number }
    | null;
  const processId = body?.processId;
  const exitCode = body?.exitCode;
  // `Number.isInteger`, not `typeof === "number"`: the exit code lands
  // verbatim in the terminal's detail and in the model-facing sentence, and
  // `NaN`/`Infinity`/a float are not exit codes a real process can produce.
  if (typeof processId !== "string" || typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  if (processId !== claims.processId) {
    return Response.json({ error: "process_mismatch" }, { status: 403 });
  }

  // `getAgentByName`, never `namespace.get(idFromName())` — the raw form skips
  // `onStart()` and the agent comes up unprimed.
  const agent = (await getAgentByName(
    env.THINK_THREAD_AGENT,
    claims.threadId,
  )) as unknown as CompletionThreadStub;
  const result = await agent.reportProcessCompletion({ processId, exitCode });
  return Response.json(result);
}
