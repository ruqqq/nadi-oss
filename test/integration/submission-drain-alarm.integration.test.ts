import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

type Initializable = { __unsafe_ensureInitialized(): Promise<void> };

// NADI_PLATFORM is celld-only and absent from the Cloudflare-generated env type;
// the pool's env object still accepts it (same trick as the bootstrap suite).
const platformEnv = env as typeof env & { NADI_PLATFORM?: string | undefined };

/**
 * Think kicks its durable-submission drain fire-and-forget, and celld drops any
 * continuation belonging to work that outlived its request — so that drain
 * claimed the row `running` and then died mid-turn, forever, because only
 * `pending` rows are ever picked up again. The fix suppresses the detached kick
 * where the platform cannot carry it, leaving the drain alarm Think schedules
 * alongside it as the only driver.
 *
 * workerd carries detached work fine, so this cannot reproduce the cut itself.
 * What it does guard is the half that has to be true for the fix to work: with
 * the detached kick gone, the alarm alone still runs the turn to completion.
 */
describe("a durable submission on a platform where detached work dies", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("still completes, driven by the drain alarm alone", async () => {
    const previousPlatform = platformEnv.NADI_PLATFORM;
    platformEnv.NADI_PLATFORM = "celld";
    try {
      const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
        threadId: "thr_submission_alarm_drain",
        provider: "mock",
        model: "mock",
      });
      const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

      const observed = await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
        await (agent as unknown as Initializable).__unsafe_ensureInitialized();

        // The kick must be shadowed on the instance — without this the detached
        // drain is back and the alarm is no longer load-bearing.
        const shadowed = Object.hasOwn(agent, "_startSubmissionDrain");

        await agent.submitMessages([
          {
            id: "msg-alarm-drain",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
          },
        ]);

        // Poll the DO's own event loop rather than guessing a tick count: under
        // a loaded suite a fixed wait is a flake.
        let submissions = await agent.listSubmissions({ limit: 5 });
        for (let attempt = 0; attempt < 600; attempt += 1) {
          submissions = await agent.listSubmissions({ limit: 5 });
          if (submissions.every((row) => row.status !== "pending" && row.status !== "running")) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }

        return { shadowed, submissions, messages: agent.messages.map((m) => m.role) };
      });

      expect(observed.shadowed).toBe(true);
      expect(observed.submissions.map((row) => row.status)).toEqual(["completed"]);
      expect(observed.messages).toContain("assistant");
    } finally {
      if (previousPlatform === undefined) delete platformEnv.NADI_PLATFORM;
      else platformEnv.NADI_PLATFORM = previousPlatform;
    }
  });
});
