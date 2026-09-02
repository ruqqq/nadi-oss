// @vitest-environment jsdom

import { afterAll, afterEach, beforeEach, beforeAll, describe, expect, it } from "vitest";
import { setupServer } from "../../../web/node_modules/msw/node";
import { restHandlers } from "../../../web/src/mocks/rest";
import { getStore, resetStore, seedStore } from "../../../web/src/mocks/store";
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
});
