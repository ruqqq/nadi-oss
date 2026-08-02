import { describe, expect, it } from "vitest";
import {
  activeSteeringMessages,
  addSteer,
  deriveSteeringChips,
  isCancellableSteerState,
  removeSteer,
  withCancelling,
  type SteeringMessage,
} from "./steering-messages";

const steer = (id: string, extra: Partial<SteeringMessage> = {}): SteeringMessage => ({
  clientMessageId: id,
  text: `text-${id}`,
  createdAt: 0,
  ...extra,
});

const set = (...ids: string[]) => new Set(ids);

describe("deriveSteeringChips", () => {
  // signature: (local, pendingKeys, seenKeys, messageIds)
  it("marks a buffered steer 'steering' (key in pendingKeys)", () => {
    const chips = deriveSteeringChips([steer("s1")], set("s1"), set("s1"), set());
    expect(chips).toEqual([
      { clientMessageId: "s1", text: "text-s1", createdAt: 0, state: "steering" },
    ]);
  });

  it("a not-yet-observed steer stays 'steering' (absent from BOTH pending and seen)", () => {
    // The fresh-steer case: no poll has run, so it's absent from pendingKeys —
    // but it must NOT flash 'sent'. seenKeys empty → default steering.
    const chips = deriveSteeringChips([steer("s1")], set(), set(), set());
    expect(chips.map((c) => c.state)).toEqual(["steering"]);
  });

  it("marks a drained steer 'sent' only after it was seen then went absent", () => {
    // seenKeys has s1 (a poll observed it in the buffer), pendingKeys no longer → sent
    const chips = deriveSteeringChips([steer("s1")], set(), set("s1"), set());
    expect(chips.map((c) => c.state)).toEqual(["sent"]);
  });

  it("marks a steer 'cancelling' while the flag is set, regardless of pending", () => {
    const chips = deriveSteeringChips(
      [steer("s1", { cancelling: true })],
      set("s1"),
      set("s1"),
      set(),
    );
    expect(chips.map((c) => c.state)).toEqual(["cancelling"]);
  });

  it("drops a settled steer (id present in transcript) — no chip", () => {
    const chips = deriveSteeringChips([steer("s1")], set("s1"), set("s1"), set("s1"));
    expect(chips).toEqual([]);
  });

  it("handles a mix: one steering, one sent, one settled", () => {
    const local = [steer("a"), steer("b"), steer("c")];
    // a still buffered; b seen-then-drained (sent); c settled into transcript
    const chips = deriveSteeringChips(local, set("a"), set("a", "b"), set("c"));
    expect(chips.map((c) => [c.clientMessageId, c.state])).toEqual([
      ["a", "steering"],
      ["b", "sent"],
    ]);
  });
});

describe("activeSteeringMessages", () => {
  it("keeps unsettled steers and drops settled ones", () => {
    const local = [steer("a"), steer("b")];
    expect(activeSteeringMessages(local, set("b")).map((s) => s.clientMessageId)).toEqual(["a"]);
  });
});

describe("isCancellableSteerState", () => {
  it("is cancellable only while steering", () => {
    expect(isCancellableSteerState("steering")).toBe(true);
    expect(isCancellableSteerState("cancelling")).toBe(false);
    expect(isCancellableSteerState("sent")).toBe(false);
  });
});

describe("local updaters", () => {
  it("addSteer appends and dedupes by clientMessageId", () => {
    const one = addSteer([], steer("a"));
    expect(one.map((s) => s.clientMessageId)).toEqual(["a"]);
    expect(addSteer(one, steer("a"))).toBe(one); // idempotent → same ref
    expect(addSteer(one, steer("b")).map((s) => s.clientMessageId)).toEqual(["a", "b"]);
  });

  it("withCancelling toggles the flag for one row only", () => {
    const local = [steer("a"), steer("b")];
    const flagged = withCancelling(local, "a", true);
    expect(flagged.find((s) => s.clientMessageId === "a")?.cancelling).toBe(true);
    expect(flagged.find((s) => s.clientMessageId === "b")?.cancelling).toBeUndefined();
    // clearing it again (too-late reconcile)
    expect(
      withCancelling(flagged, "a", false).find((s) => s.clientMessageId === "a")?.cancelling,
    ).toBe(false);
  });

  it("removeSteer drops the row (confirmed cancel)", () => {
    expect(removeSteer([steer("a"), steer("b")], "a").map((s) => s.clientMessageId)).toEqual(["b"]);
  });
});
