import { describe, expect, it } from "vitest";
import {
  buildThreadPushPayload,
  pushPayloadForRecipient,
  pushableThreadTitle,
  shouldSendThreadPush,
} from "../../../src/notifications/thread-notifications";

const fast = {
  type: "thread.completed",
  startedAt: 1000,
  occurredAt: 3000,
  hadWatchedWork: false,
} as const;

describe("shouldSendThreadPush", () => {
  it("suppresses a fast human-initiated completion (under the 12s threshold)", () => {
    expect(shouldSendThreadPush({ ...fast, isAutomatonRun: false })).toBe(false);
  });

  it("always notifies a fast automaton completion — the user is by definition away", () => {
    expect(shouldSendThreadPush({ ...fast, isAutomatonRun: true })).toBe(true);
  });

  it("still notifies a slow human completion", () => {
    expect(
      shouldSendThreadPush({ ...fast, occurredAt: 1000 + 12_000, isAutomatonRun: false }),
    ).toBe(true);
  });

  it("never thresholds attention_required or failed", () => {
    expect(
      shouldSendThreadPush({
        type: "thread.attention_required",
        occurredAt: 1,
        isAutomatonRun: false,
      }),
    ).toBe(true);
    expect(
      shouldSendThreadPush({
        type: "thread.failed",
        startedAt: 0,
        occurredAt: 1,
        isAutomatonRun: false,
      }),
    ).toBe(true);
  });
});

describe("pushableThreadTitle", () => {
  it("offers the title once the thread has earned one", () => {
    expect(pushableThreadTitle({ title: "Fixing the flaky login test", titleSet: true })).toBe(
      "Fixing the flaky login test",
    );
  });

  // Naming can legitimately not happen (an attachment-only first message), and
  // shouting "New thread" at someone's lock screen helps nobody.
  it("withholds the placeholder of an unnamed thread", () => {
    expect(pushableThreadTitle({ title: "New thread", titleSet: false })).toBeNull();
  });
});

describe("buildThreadPushPayload", () => {
  it("names the automaton instead of the generic copy", () => {
    expect(
      buildThreadPushPayload({
        type: "thread.completed",
        threadId: "thr_1",
        automatonName: "Daily briefing",
      }),
    ).toMatchObject({ title: "Daily briefing is ready" });
  });

  // The completion push only fires when the user walked away from a long turn, so
  // it has to say WHICH thread finished -- "Thread ready" named nothing.
  it("names the thread that finished", () => {
    expect(
      buildThreadPushPayload({
        type: "thread.completed",
        threadId: "thr_1",
        threadTitle: "Fixing the flaky login test",
      }),
    ).toEqual({
      title: "Fixing the flaky login test",
      body: "Nadi finished — tap to read the reply.",
      url: "/threads/thr_1",
    });
  });

  it("prefers the automaton name over the thread title", () => {
    expect(
      buildThreadPushPayload({
        type: "thread.completed",
        threadId: "thr_1",
        automatonName: "Daily briefing",
        threadTitle: "Daily briefing — 2026-07-11",
      }),
    ).toMatchObject({ title: "Daily briefing is ready", body: "Nadi finished this run." });
  });

  it("falls back to generic copy for an unnamed thread", () => {
    expect(buildThreadPushPayload({ type: "thread.completed", threadId: "thr_1" })).toMatchObject({
      title: "Thread ready",
    });
    expect(
      buildThreadPushPayload({ type: "thread.completed", threadId: "thr_1", threadTitle: "  " }),
    ).toMatchObject({ title: "Thread ready" });
  });

  it("keeps attention copy action-oriented for an automaton", () => {
    expect(
      buildThreadPushPayload({
        type: "thread.attention_required",
        threadId: "thr_1",
        automatonName: "Markdump upkeep",
      }),
    ).toMatchObject({ title: "Markdump upkeep needs you" });
  });
});

describe("buildThreadPushPayload with a reply preview", () => {
  const preview = "The CSV writer dropped the last row when the buffer flushed early.";

  it("shows the reply instead of the generic completion copy", () => {
    expect(
      buildThreadPushPayload({
        type: "thread.completed",
        threadId: "thr_1",
        threadTitle: "Fixing the payroll export",
        preview,
      }),
    ).toEqual({
      title: "Fixing the payroll export",
      body: preview,
      url: "/threads/thr_1",
    });
  });

  it("shows the trailing narration on an attention push", () => {
    expect(
      buildThreadPushPayload({
        type: "thread.attention_required",
        threadId: "thr_1",
        preview: "Tests pass. I'll force-push to main now.",
      }),
    ).toMatchObject({
      title: "Action needed",
      body: "Tests pass. I'll force-push to main now.",
    });
  });

  it("shows the declared reason on a failure push", () => {
    expect(
      buildThreadPushPayload({
        type: "thread.failed",
        threadId: "thr_1",
        automatonName: "Nightly digest",
        preview: "Exited 1: pnpm test failed",
      }),
    ).toMatchObject({ title: "Nightly digest failed", body: "Exited 1: pnpm test failed" });
  });

  it("leaves the title alone — the preview only ever replaces the body", () => {
    const withPreview = buildThreadPushPayload({
      type: "thread.completed",
      threadId: "thr_1",
      automatonName: "Daily briefing",
      preview,
    });
    const without = buildThreadPushPayload({
      type: "thread.completed",
      threadId: "thr_1",
      automatonName: "Daily briefing",
    });
    expect(withPreview.title).toBe(without.title);
    expect(withPreview.url).toBe(without.url);
  });

  // A user who opted out, and a turn that ended with no prose, both land here.
  // These pin the fallback so it cannot drift for people who turned previews off.
  it("falls back to the exact generic copy when there is no preview", () => {
    for (const preview of [null, undefined, "", "   "] as const) {
      expect(
        buildThreadPushPayload({ type: "thread.completed", threadId: "thr_1", preview }),
      ).toEqual({
        title: "Thread ready",
        body: "Nadi finished — tap to read the reply.",
        url: "/threads/thr_1",
      });
      expect(
        buildThreadPushPayload({ type: "thread.attention_required", threadId: "thr_1", preview }),
      ).toEqual({
        title: "Action needed",
        body: "Open the thread to continue.",
        url: "/threads/thr_1",
      });
      expect(buildThreadPushPayload({ type: "thread.failed", threadId: "thr_1", preview })).toEqual(
        {
          title: "Run failed",
          body: "Open the thread to check what happened.",
          url: "/threads/thr_1",
        },
      );
    }
  });
});

describe("pushPayloadForRecipient", () => {
  const event = {
    type: "thread.completed",
    threadId: "thr_1",
    threadTitle: "Fixing the payroll export",
    preview: "The CSV writer dropped the last row.",
  } as const;

  it("gives no payload at all to a user who has browser push off", () => {
    expect(
      pushPayloadForRecipient({
        ...event,
        settings: { browserPushEnabled: false, pushPreviewEnabled: true },
      }),
    ).toBeNull();
  });

  it("gives no payload to a user with no settings row", () => {
    expect(pushPayloadForRecipient({ ...event, settings: undefined })).toBeNull();
  });

  it("includes the reply for a user who has previews on", () => {
    expect(
      pushPayloadForRecipient({
        ...event,
        settings: { browserPushEnabled: true, pushPreviewEnabled: true },
      }),
    ).toMatchObject({ body: "The CSV writer dropped the last row." });
  });

  it("withholds the reply from a user who has previews off", () => {
    expect(
      pushPayloadForRecipient({
        ...event,
        settings: { browserPushEnabled: true, pushPreviewEnabled: false },
      }),
    ).toMatchObject({ body: "Nadi finished — tap to read the reply." });
  });

  // The whole point of a per-recipient signature: one event, two members of the
  // same workspace, two different bodies. A payload built once for the workspace
  // could not satisfy this.
  it("sends different bodies to two members who disagree about previews", () => {
    const optedIn = pushPayloadForRecipient({
      ...event,
      settings: { browserPushEnabled: true, pushPreviewEnabled: true },
    });
    const optedOut = pushPayloadForRecipient({
      ...event,
      settings: { browserPushEnabled: true, pushPreviewEnabled: false },
    });

    expect(optedIn!.body).not.toBe(optedOut!.body);
    // ...but they still agree on where the notification points, and on the
    // thread name, which previews never governed.
    expect(optedIn!.title).toBe(optedOut!.title);
    expect(optedIn!.url).toBe(optedOut!.url);
  });
});
