// @vitest-environment jsdom

import { afterAll, afterEach, beforeEach, beforeAll, describe, expect, it } from "vitest";
import { setupServer } from "../../../web/node_modules/msw/node";
import { restHandlers } from "../../../web/src/mocks/rest";
import { getStore, resetStore, seedStore } from "../../../web/src/mocks/store";
import type { ThreadSummary } from "../../../web/src/threads-api";
import { listThreads } from "../../../web/src/threads-api";
import { serializeThread } from "../../../src/http/thread-serialize";

const server = setupServer(...(restHandlers as unknown as Parameters<typeof setupServer>));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  resetStore();
});
afterAll(() => server.close());

/** Same reason as `skills-mock-contract.test.ts`: the handlers are registered
 *  origin-relative, so requests must resolve against the jsdom document. */
const mswFetch: typeof fetch = (input, init) => {
  const url =
    typeof input === "string" ? new URL(input, globalThis.location.href).toString() : input;
  return fetch(url, init);
};

/**
 * `readOnly` / `readOnlyReason` are the mocked app's one derived pair: the
 * server computes them from a live join on `agents`, and the mock re-implements
 * that in `applyLiveReadOnly`. Two implementations of one rule is exactly the
 * shape that has shipped wire-contract regressions on this branch, so this
 * drives the mock through the real client and checks every row against the
 * REAL serializer rather than against a second copy of the expectation.
 */
describe("mock /api/threads — readOnly agrees with the server serializer", () => {
  beforeEach(() => seedStore("agent-gone"));

  it("derives the same readOnly and reason the server would", async () => {
    const { threads } = await listThreads(mswFetch, "all");
    const store = getStore();

    expect(threads.length).toBeGreaterThan(0);
    // The scenario has to actually contain the interesting rows, or this test
    // passes by covering nothing.
    expect(threads.map((thread) => thread.readOnlyReason)).toEqual(
      expect.arrayContaining(["agent_disabled", "agent_deleted", "thread_archived", undefined]),
    );

    // The overlap has to be IN the sample, or the loop below compares the two
    // implementations on a case where their orderings cannot disagree.
    const overlapping = store.agents.find(
      (agent) => agent.archivedAt !== null && agent.enabled === false,
    );
    expect(overlapping).toBeDefined();
    expect(
      threads.find((thread) => thread.agentId === overlapping?.id)?.readOnlyReason,
    ).toBe("agent_deleted");

    for (const thread of threads) {
      const agent = store.agents.find((candidate) => candidate.id === thread.agentId);
      const expected = serializeThread({
        id: thread.threadId,
        workspaceId: thread.workspaceId,
        agentId: thread.agentId,
        runtime: thread.runtime,
        title: thread.title,
        source: thread.source,
        lastMessagePreview: thread.lastMessagePreview,
        archivedAt: thread.archivedAt,
        // An agent the store does not carry is the mock's stand-in for a row
        // the join did not return: unknown, not disabled.
        agentArchivedAt: agent?.archivedAt ?? null,
        agentEnabled: agent === undefined ? null : agent.enabled,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      });

      expect({
        readOnly: thread.readOnly,
        readOnlyReason: thread.readOnlyReason,
      }).toEqual({ readOnly: expected.readOnly, readOnlyReason: expected.readOnlyReason });
    }
  });

  /**
   * The handlers that BUILD or MUTATE a thread run after `getStore()` has
   * already swept the store, so their own response has to derive its state
   * rather than inherit the sweep's. Archiving is the one such site where the
   * difference is observable in a response: without the re-derivation this
   * answers `readOnly: false` and only agrees from the next read on.
   */
  it("archives with the reason already set, in the same response", async () => {
    const { threads } = await listThreads(mswFetch, "active");
    const target = threads.find((thread) => !thread.readOnly);
    expect(target).toBeDefined();

    const response = await mswFetch(`/api/threads/${target?.threadId}/archive`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      thread: { readOnly: boolean; readOnlyReason?: string };
    };

    expect(body.thread).toMatchObject({ readOnly: true, readOnlyReason: "thread_archived" });
  });

  it("re-derives after an agent is turned off, the way the live join does", async () => {
    const before = await listThreads(mswFetch, "all");
    const live = before.threads.find((thread) => thread.agentId === "wb_nadi");
    expect(live).toBeDefined();
    expect(live?.readOnly).toBe(false);

    const response = await mswFetch("/api/agents/wb_nadi", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(response.status).toBe(200);

    const after = await listThreads(mswFetch, "all");
    const now = after.threads.find((thread) => thread.threadId === live?.threadId);
    expect(now).toMatchObject({ readOnly: true, readOnlyReason: "agent_disabled" });
  });

  /**
   * The feedback thread is a `ThreadSummary` that lives OUTSIDE `store.threads`,
   * and it used to hardcode `readOnly: false`. On the server it goes through the
   * same `serializeThread` as every other thread
   * (`src/http/feedback-routes.ts:454`), so a disabled agent makes it read-only
   * there.
   *
   * No scenario reaches this state on its own: the feedback thread's agent is
   * `store.settings.agent`, and no scenario carries a matching row in
   * `store.agents` — an unknown agent is "unknown", not "disabled". The row is
   * therefore added here rather than seeded, and both directions are asserted so
   * a helper that silently returned `undefined` could not pass.
   */
  async function fetchFeedbackThread() {
    const response = await mswFetch("/api/feedback/thread", { method: "POST" });
    expect(response.status).toBe(200);
    return ((await response.json()) as { thread: ThreadSummary }).thread;
  }

  it("derives the feedback thread's readOnly from its agent, both ways", async () => {
    const store = getStore();
    const agentId = store.settings?.agent.id;
    expect(agentId).toBeDefined();
    expect(store.agents.some((agent) => agent.id === agentId)).toBe(false);

    // An agent the store does not carry: unknown, not disabled.
    expect(await fetchFeedbackThread()).toMatchObject({ readOnly: false });

    store.agents.push({ ...store.agents[0]!, id: agentId!, enabled: true, archivedAt: null });
    expect(await fetchFeedbackThread()).toMatchObject({ readOnly: false });

    const seeded = getStore().agents.find((agent) => agent.id === agentId)!;
    seeded.enabled = false;
    const disabled = await fetchFeedbackThread();
    expect(disabled).toMatchObject({ readOnly: true, readOnlyReason: "agent_disabled" });

    // The same row, through the REAL serializer.
    const expected = serializeThread({
      id: disabled.threadId,
      workspaceId: disabled.workspaceId,
      agentId: disabled.agentId,
      runtime: disabled.runtime,
      title: disabled.title,
      source: disabled.source,
      lastMessagePreview: disabled.lastMessagePreview,
      archivedAt: disabled.archivedAt,
      agentArchivedAt: seeded.archivedAt,
      agentEnabled: seeded.enabled,
      createdAt: disabled.createdAt,
      updatedAt: disabled.updatedAt,
    });
    expect({ readOnly: disabled.readOnly, readOnlyReason: disabled.readOnlyReason }).toEqual({
      readOnly: expected.readOnly,
      readOnlyReason: expected.readOnlyReason,
    });

    // ...and back: re-enabling clears BOTH fields, so a stale `readOnlyReason`
    // left behind by the sweep would fail here.
    seeded.enabled = true;
    const reenabled = await fetchFeedbackThread();
    expect(reenabled.readOnly).toBe(false);
    expect(reenabled.readOnlyReason).toBeUndefined();
  });

  /**
   * The BUILD site, separately: `applyLiveReadOnly` runs on the way INTO the
   * handler, when there is still no feedback row to sweep, so the first response
   * is whatever `feedbackThread()` constructs. Ordering is the whole test — the
   * agent has to be disabled before the thread is ever asked for.
   */
  it("builds the feedback thread already read-only when its agent is off", async () => {
    const store = getStore();
    const agentId = store.settings?.agent.id;
    store.agents.push({ ...store.agents[0]!, id: agentId!, enabled: false, archivedAt: null });
    expect(store.feedback.thread).toBeNull();

    expect(await fetchFeedbackThread()).toMatchObject({
      readOnly: true,
      readOnlyReason: "agent_disabled",
    });
  });
});
