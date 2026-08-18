import type { ThinkSubmissionInspection } from "@cloudflare/think";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  cancelQueuedUserMessageFromBatch,
  effectiveModelSwitch,
  normalizeQueuedUserMessageInput,
  queuedBatchFromMetadata,
  submitQueuedUserMessageBatch,
  withCapturedModelSwitch,
  type QueuedSubmissionPort,
} from "../../../src/agent/queued-user-messages";

const snapshot = {
  provider: "mock-tool-call",
  model: "mock-model-2",
  modelInputModalities: ["text"],
  showReasoning: true,
  reasoningEffort: "medium" as const,
  modelSupportsReasoning: true,
};

const otherSnapshot = {
  ...snapshot,
  model: "mock-model-3",
};

function textMessage(text: string, id: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function inspection(
  overrides: Partial<ThinkSubmissionInspection> & Pick<ThinkSubmissionInspection, "submissionId">,
): ThinkSubmissionInspection {
  return { status: "pending", createdAt: 100, ...overrides };
}

/**
 * Same fake-`QueuedSubmissionPort` harness `queued-user-messages.test.ts`
 * uses for `submitQueuedUserMessageBatch`/`cancelQueuedUserMessageFromBatch` —
 * a plain in-memory log, no DO. Lets behaviours 5 and 6 (the per-item
 * cancellation rule, and last-surviving-item-wins) be proven deterministically:
 * a real DO's automatic submission drain can race a merge attempt (a waiting
 * message may already have run by the time the next one queues — see
 * `think-thread-agent.integration.test.ts`'s "timing tolerant" merge test),
 * which would make an assertion about which switch a *merged* batch ends up
 * carrying flaky. Working the merge/cancel machinery directly sidesteps that.
 */
function fakePort({
  submissions = [],
  applied = new Set<string>(),
}: {
  submissions?: ThinkSubmissionInspection[];
  applied?: Set<string>;
}): { port: QueuedSubmissionPort; latest: () => ThinkSubmissionInspection | undefined } {
  let store = [...submissions];
  const port: QueuedSubmissionPort = {
    listSubmissions: async () => store,
    inspectSubmission: async (submissionId) =>
      store.find((s) => s.submissionId === submissionId) ?? null,
    cancelSubmission: async (submissionId) => {
      store = store.map((s) => (s.submissionId === submissionId ? { ...s, status: "aborted" } : s));
    },
    submitMessages: async (messages, options) => {
      const next = inspection({
        submissionId: `sub-${store.length}`,
        status: "running",
        metadata: options.metadata,
      });
      store = [...store, next];
      return next;
    },
    appliedMessageIds: () => applied,
  };
  return { port, latest: () => [...store].reverse().find((s) => s.status !== "aborted") };
}

/**
 * Pure-module coverage of the per-item model-switch binding (task 7):
 * `queuedBatchFromMetadata` parsing a captured switch on an item, degrading a
 * malformed one, and `effectiveModelSwitch`'s last-surviving-item rule. No
 * `ThinkThreadAgent` import here, so this stays in the plain-node `unit`
 * project — the real-DO behaviours (capture on queue, cancellation carrying
 * a switch away, the same rule proven end to end) live in
 * `test/integration/queued-model-switch.integration.test.ts` instead, same
 * split `queued-user-messages.test.ts` already uses for everything else in
 * this module.
 */
describe("queued message model binding", () => {
  it("round-trips a captured switch on the item", () => {
    const batch = queuedBatchFromMetadata({
      nadiKind: "queued_user_message",
      items: [
        {
          clientMessageId: "m1",
          textPreview: "hi",
          attachmentCount: 0,
          attachments: [],
          modelSwitch: snapshot,
        },
      ],
    });
    expect(batch?.items[0]?.modelSwitch).toEqual(snapshot);
  });

  it("ignores a malformed captured switch rather than failing the item", () => {
    const batch = queuedBatchFromMetadata({
      nadiKind: "queued_user_message",
      items: [
        {
          clientMessageId: "m1",
          textPreview: "hi",
          attachmentCount: 0,
          attachments: [],
          modelSwitch: { provider: 42 },
        },
      ],
    });
    expect(batch).not.toBeNull();
    expect(batch?.items[0]?.modelSwitch).toBeUndefined();
  });

  it("legacy v1 metadata still parses and carries no switch", () => {
    // Legacy shape: the item's own fields sit at the metadata top level,
    // with no `items` array and no `modelSwitch` — predates this feature
    // entirely, so "no switch" is the only correct reading.
    const batch = queuedBatchFromMetadata({
      nadiKind: "queued_user_message",
      clientMessageId: "legacy-1",
      textPreview: "legacy hello",
      attachmentCount: 0,
      attachments: [],
    });
    expect(batch?.items[0]?.modelSwitch).toBeUndefined();
  });

  it("effectiveModelSwitch: the last surviving item that carries one wins", () => {
    expect(
      effectiveModelSwitch([
        { clientMessageId: "m1", textPreview: "a", attachmentCount: 0, attachments: [] },
        {
          clientMessageId: "m2",
          textPreview: "b",
          attachmentCount: 0,
          attachments: [],
          modelSwitch: snapshot,
        },
        { clientMessageId: "m3", textPreview: "c", attachmentCount: 0, attachments: [] },
      ]),
    ).toEqual(snapshot);
  });

  it("effectiveModelSwitch: null when no item carries a switch", () => {
    expect(
      effectiveModelSwitch([
        { clientMessageId: "m1", textPreview: "a", attachmentCount: 0, attachments: [] },
      ]),
    ).toBeNull();
  });

  it("cancelling ONE item of a batch removes only that item's switch — THE rule", async () => {
    // "run the tests" queues with no switch pending; "then summarise" queues
    // after a picker change, so only IT carries a switch.
    const { port, latest } = fakePort({});
    await submitQueuedUserMessageBatch(
      port,
      withCapturedModelSwitch(
        normalizeQueuedUserMessageInput({ message: textMessage("run the tests", "m1") }),
        null,
      ),
    );
    await submitQueuedUserMessageBatch(
      port,
      withCapturedModelSwitch(
        normalizeQueuedUserMessageInput({ message: textMessage("then summarise", "m2") }),
        snapshot,
      ),
    );

    const batchBeforeCancel = queuedBatchFromMetadata(latest()?.metadata);
    expect(batchBeforeCancel?.items.map((item) => item.clientMessageId)).toEqual(["m1", "m2"]);
    expect(effectiveModelSwitch(batchBeforeCancel?.items ?? [])).toEqual(snapshot);

    // Cancel ONLY m2. If the switch had been stored on the BATCH instead of
    // the item, it would outlive m2 and silently apply to the sibling m1
    // never chose it for.
    await cancelQueuedUserMessageFromBatch(port, latest()?.submissionId ?? "", "m2");

    const batchAfterCancel = queuedBatchFromMetadata(latest()?.metadata);
    expect(batchAfterCancel?.items.map((item) => item.clientMessageId)).toEqual(["m1"]);
    expect(effectiveModelSwitch(batchAfterCancel?.items ?? [])).toBeNull();
  });

  it("the last surviving switch in a batch wins", async () => {
    const { port, latest } = fakePort({});
    await submitQueuedUserMessageBatch(
      port,
      withCapturedModelSwitch(
        normalizeQueuedUserMessageInput({ message: textMessage("first", "m1") }),
        snapshot,
      ),
    );
    await submitQueuedUserMessageBatch(
      port,
      withCapturedModelSwitch(
        normalizeQueuedUserMessageInput({ message: textMessage("second", "m2") }),
        otherSnapshot,
      ),
    );

    const batch = queuedBatchFromMetadata(latest()?.metadata);
    expect(batch?.items.map((item) => item.clientMessageId)).toEqual(["m1", "m2"]);
    expect(effectiveModelSwitch(batch?.items ?? [])).toEqual(otherSnapshot);
  });
});
