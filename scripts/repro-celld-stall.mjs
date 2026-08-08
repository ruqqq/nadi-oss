#!/usr/bin/env node
/**
 * Reproduce celld's `handler stalled: awaited work with no pending op` on the
 * first message sent to a brand-new thread.
 *
 * The failure is intermittent — roughly 1 in 3 by hand — so the point of this
 * script is a RATE, not a single hit. It creates N threads and posts the first
 * message to each, exactly as the SPA does, and reports how many were rejected.
 *
 * Why the app cannot simply catch this: `sendThreadMessage`
 * (src/http/thread-routes.ts) wraps the RPC in try/catch and would log
 * `thread.send_message_failed`. That warning never appears. celld aborts the
 * invocation ABOVE the app's handler, so the error arrives as a rejected Worker
 * call rather than as a thrown JS error the Worker can see.
 *
 *   node scripts/repro-celld-stall.mjs                # 20 iterations
 *   node scripts/repro-celld-stall.mjs --count 50
 *   node scripts/repro-celld-stall.mjs --base http://app.localhost --email you@example.com
 *
 * Requires the node to be running with AUTH_OTP_LOG_FALLBACK=true, since the
 * script signs itself in by reading the one-time code out of the container log.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";

const run = promisify(execFile);

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "http://app.localhost" },
    email: { type: "string" },
    count: { type: "string", default: "20" },
    container: { type: "string", default: "nadi-celld-celld-1" },
    // Seconds to idle between iterations. The default of 0 hammers; pass a
    // value above CELLD_IDLE_EVICT_S to force every thread's cell to be cold.
    gap: { type: "string", default: "0" },
    timeout: { type: "string", default: "150" },
    keep: { type: "boolean", default: false },
  },
});

const BASE = values.base.replace(/\/$/, "");
const COUNT = Number(values.count);
const GAP_MS = Number(values.gap) * 1000;
const CONTAINER = values.container;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read the newest sign-in code out of the node log (AUTH_OTP_LOG_FALLBACK). */
async function readOtpFromLog(since) {
  const { stdout } = await run("docker", ["logs", CONTAINER, "--since", since]);
  // Strip ANSI, then take the last `Use NNNNNN to sign in` in the window.
  const codes = [...stdout.replace(/\x1b\[[0-9;]*m/g, "").matchAll(/Use (\d{6}) to sign in/g)];
  return codes.length ? codes[codes.length - 1][1] : null;
}

async function signIn(email) {
  const started = new Date();
  const send = await fetch(
    `${BASE}/api/auth/email-otp/send-verification-otp`,
    timed({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, type: "sign-in" }),
    }),
  );
  if (!send.ok) throw new Error(`send-verification-otp: ${send.status} ${await send.text()}`);

  let otp = null;
  for (let i = 0; i < 20 && !otp; i++) {
    await sleep(500);
    otp = await readOtpFromLog(`${Math.ceil((Date.now() - started) / 1000) + 5}s`);
  }
  if (!otp) {
    throw new Error("no sign-in code in the log. Is AUTH_OTP_LOG_FALLBACK=true in celld-vars.env?");
  }

  const res = await fetch(
    `${BASE}/api/auth/sign-in/email-otp`,
    timed({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, otp }),
    }),
  );
  if (!res.ok) throw new Error(`sign-in: ${res.status} ${await res.text()}`);

  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error("sign-in returned no cookie");
  return cookie;
}

/**
 * Every request needs a deadline. A stalled handler does not always fail fast —
 * celld can leave the invocation hanging, and an un-timed `fetch` waits forever,
 * which reads as "the script is broken" rather than "the send hung". A hang IS a
 * result here, so it is recorded as one.
 *
 * The default is generous on purpose. `POST /messages` does NOT return as soon
 * as the message is queued — measured, it stays open until the model turn
 * finishes, ~40s with a slow provider. At 30s this reported 80%+ "hangs" that
 * were really just slow successes, which buried the actual signal.
 */
const TIMEOUT_MS = Number(values.timeout) * 1000;
const timed = (extra = {}) => ({ signal: AbortSignal.timeout(TIMEOUT_MS), ...extra });

/** One iteration: create a thread, then post its first message. */
async function attempt(cookie, i) {
  const headers = { "Content-Type": "application/json", cookie };
  // Track which call is in flight, so a thrown timeout is attributable to
  // create-vs-send rather than collapsing into an anonymous "throw".
  attempt.phase = "create";

  const created = await fetch(
    `${BASE}/api/threads`,
    timed({ method: "POST", headers, body: "{}" }),
  );
  if (!created.ok) {
    return {
      i,
      phase: "create",
      status: created.status,
      body: (await created.text()).slice(0, 300),
    };
  }
  // POST /api/threads answers `{ thread: summary }`, not a bare id.
  const { thread } = await created.json();
  const threadId = thread.threadId;
  attempt.phase = "send";
  attempt.threadId = threadId;

  const sent = await fetch(
    `${BASE}/api/threads/${encodeURIComponent(threadId)}/messages`,
    timed({
      method: "POST",
      headers,
      // A UIMessage, exactly as web/src/lib/new-thread-send.ts builds it. A bare
      // `{text}` is rejected by normalizeQueuedUserMessageInput as
      // queued_message_invalid, which would look like a failure but is a 400.
      body: JSON.stringify({
        message: {
          id: `msg_repro_${i}_${Date.now()}`,
          role: "user",
          parts: [{ type: "text", text: `repro ${i}` }],
        },
      }),
    }),
  );
  const body = sent.ok ? "" : (await sent.text()).slice(0, 300);
  return { i, phase: "send", threadId, status: sent.status, body, ok: sent.ok };
}

const email = values.email ?? process.env.REPRO_EMAIL;
if (!email) {
  console.error("Pass --email <address> (must be in SUPERUSER_EMAILS or already registered).");
  process.exit(2);
}

console.log(`Signing in as ${email} at ${BASE} …`);
const cookie = await signIn(email);
console.log("Signed in.\n");

const failures = [];
const created = [];

for (let i = 1; i <= COUNT; i++) {
  let result;
  attempt.threadId = undefined;
  try {
    result = await attempt(cookie, i);
  } catch (error) {
    result = {
      i,
      phase: attempt.phase ?? "throw",
      threadId: attempt.threadId,
      status: 0,
      body: String(error),
      ok: false,
    };
  }
  if (result.threadId) created.push(result.threadId);

  const text = result.body ?? "";
  const stalled = /handler stalled|no pending op/.test(text);
  // A timeout is its own outcome: the send neither succeeded nor was rejected,
  // it just never came back. Counting it as a plain failure would hide that.
  const hung = /TimeoutError|The operation was aborted/.test(text);
  if (!result.ok) {
    failures.push({ ...result, stalled, hung });
    const tag = stalled
      ? "  ← handler stalled"
      : hung
        ? `  ← no response in ${TIMEOUT_MS / 1000}s`
        : "";
    console.log(
      `  ${String(i).padStart(3)}  FAIL  ${result.phase} ${result.status}${tag}\n` +
        `        ${text.replace(/\s+/g, " ").slice(0, 200)}`,
    );
  } else {
    console.log(`  ${String(i).padStart(3)}  ok    ${result.threadId}`);
  }
  if (GAP_MS) await sleep(GAP_MS);
}

const stalls = failures.filter((f) => f.stalled).length;
const hangs = failures.filter((f) => f.hung).length;
const pct = (n) => `${((n / COUNT) * 100).toFixed(1)}%`;
console.log(`\n── ${COUNT} attempts ────────────────────────────────`);
console.log(`   ok:                ${COUNT - failures.length}`);
console.log(`   failures:          ${failures.length}`);
console.log(`   "handler stalled": ${stalls}  (${pct(stalls)})`);
console.log(`   no response:       ${hangs}  (${pct(hangs)})`);
console.log(`   other:             ${failures.length - stalls - hangs}`);

if (created.length && !values.keep) {
  console.log(`\nCleaning up ${created.length} threads (pass --keep to leave them)…`);
  let deleted = 0;
  for (const id of created) {
    const res = await fetch(`${BASE}/api/threads/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { cookie },
    });
    if (res.ok) deleted++;
  }
  console.log(`Deleted ${deleted}/${created.length}.`);
}

process.exit(stalls > 0 ? 1 : 0);
