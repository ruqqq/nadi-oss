import type { ThinkSubmissionInspection } from "@cloudflare/think";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  cancelQueuedUserMessageFromBatch,
  normalizeQueuedUserMessageInput,
  queuedBatchFromMetadata,
  submitQueuedUserMessageBatch,
  type QueuedSubmissionPort,
} from "../../../src/agent/queued-user-messages";

const snapshot = {
  provider: "mock-tool-call",
  model: "mock-model-2",
  modelInputModalities: ["text"],
  modelSupportsReasoning: true,
};

const otherSnapshot = {
  ...snapshot,
  model: "mock-model-3",
};

/** A queued message the client asserts a switch on, exactly the shape a
 *  direct send carries — `metadata` is the ONE channel a switch enters the
 *  queue through now (see `queued-user-messages.ts`'s
 *  `normalizeQueuedUserMessageInput`, which reads it straight off here). */
function textMessage(text: string, id: string, modelSwitch?: typeof snapshot): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
    ...(modelSwitch ? { metadata: modelSwitch } : {}),
  };
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
 * Pure-module coverage of the per-item model-switch binding: `metadata` on
 * the queued message is now the only source (see `model-switch-request.ts`),
 * so this proves `normalizeQueuedUserMessageInput` reads it, the item
 * survives `queuedBatchFromMetadata`'s round trip (or degrades cleanly), and
 * a merge/cancel preserves (or drops) each item's OWN switch correctly. This
 * module stores per-item switches only — it has no selection logic of its
 * own; WHICH switch out of a flushed batch actually applies is decided once,
 * at commit time, by `model-switch-request.ts`'s `effectiveModelSwitchRequest`
 * scanning `this.messages` (see `model-switch-request.test.ts`'s "the LAST
 * trailing user message wins over an earlier one — a flushed queued batch"
 * for that rule asserted against the live path). No `ThinkThreadAgent`
 * import here, so this stays in the plain-node `unit` project — the real-DO
 * behaviours (cancellation carrying a switch away end to end, the commit
 * itself) live in `test/integration/queued-model-switch.integration.test.ts`
 * instead, same split `queued-user-messages.test.ts` already uses for
 * everything else in this module.
 */
describe("queued message model binding", () => {
  it("normalizeQueuedUserMessageInput captures the switch off the message's own metadata", () => {
    const normalized = normalizeQueuedUserMessageInput({
      message: textMessage("hi", "m1", snapshot),
    });
    expect(normalized.item.modelSwitch).toEqual(snapshot);
  });

  it("a message with no metadata carries no switch", () => {
    const normalized = normalizeQueuedUserMessageInput({ message: textMessage("hi", "m1") });
    expect(normalized.item.modelSwitch).toBeUndefined();
  });

  it("round-trips a captured switch through queuedBatchFromMetadata", () => {
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

  it("cancelling ONE item of a batch removes only that item's switch — THE rule", async () => {
    // "run the tests" queues with no switch asserted; "then summarise" queues
    // with the picker having since chosen a model, so only IT carries one.
    const { port, latest } = fakePort({});
    await submitQueuedUserMessageBatch(
      port,
      normalizeQueuedUserMessageInput({ message: textMessage("run the tests", "m1") }),
    );
    await submitQueuedUserMessageBatch(
      port,
      normalizeQueuedUserMessageInput({ message: textMessage("then summarise", "m2", snapshot) }),
    );

    const batchBeforeCancel = queuedBatchFromMetadata(latest()?.metadata);
    expect(batchBeforeCancel?.items.map((item) => item.clientMessageId)).toEqual(["m1", "m2"]);
    expect(
      batchBeforeCancel?.items.find((item) => item.clientMessageId === "m2")?.modelSwitch,
    ).toEqual(snapshot);

    // Cancel ONLY m2. If the switch had been stored on the BATCH instead of
    // the item, it would outlive m2 and silently apply to the sibling m1
    // never chose it for.
    await cancelQueuedUserMessageFromBatch(port, latest()?.submissionId ?? "", "m2");

    const batchAfterCancel = queuedBatchFromMetadata(latest()?.metadata);
    expect(batchAfterCancel?.items.map((item) => item.clientMessageId)).toEqual(["m1"]);
    expect(batchAfterCancel?.items.every((item) => !item.modelSwitch)).toBe(true);
  });

  it("a merge preserves each item's own switch — WHICH one is effective is decided downstream", async () => {
    const { port, latest } = fakePort({});
    await submitQueuedUserMessageBatch(
      port,
      normalizeQueuedUserMessageInput({ message: textMessage("first", "m1", snapshot) }),
    );
    await submitQueuedUserMessageBatch(
      port,
      normalizeQueuedUserMessageInput({
        message: textMessage("second", "m2", otherSnapshot),
      }),
    );

    // This module has no selection logic of its own: it stores what each
    // item carried, unmodified. `effectiveModelSwitchRequest`
    // (`model-switch-request.ts`) is what later picks "the last surviving
    // item wins" out of the applied messages at commit time — asserted there
    // in "the LAST trailing user message wins over an earlier one — a
    // flushed queued batch".
    const batch = queuedBatchFromMetadata(latest()?.metadata);
    expect(batch?.items.map((item) => item.clientMessageId)).toEqual(["m1", "m2"]);
    expect(batch?.items.find((item) => item.clientMessageId === "m1")?.modelSwitch).toEqual(
      snapshot,
    );
    expect(batch?.items.find((item) => item.clientMessageId === "m2")?.modelSwitch).toEqual(
      otherSnapshot,
    );
  });
});
