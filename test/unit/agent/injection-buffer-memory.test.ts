import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createMemoryInjectionBuffer } from "../../../src/agent/injection-buffer";

const msg = (id: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text: id }] });

describe("createMemoryInjectionBuffer", () => {
  it("enqueues, peeks FIFO without deleting, and empties only after deleteDrained", () => {
    const b = createMemoryInjectionBuffer();
    expect(b.isEmpty()).toBe(true);
    expect(
      b.enqueue({ dedupeKey: "a", kind: "watcher-completion", message: msg("a"), now: 1 }),
    ).toBe(true);
    expect(
      b.enqueue({ dedupeKey: "b", kind: "subagent-completion", message: msg("b"), now: 2 }),
    ).toBe(true);
    expect(b.isEmpty()).toBe(false);

    const peeked = b.peekAll();
    expect(peeked.map((d) => d.message.id)).toEqual(["a", "b"]);
    expect(peeked.map((d) => d.kind)).toEqual(["watcher-completion", "subagent-completion"]);
    // peekAll does NOT delete: re-peeking returns the same rows.
    expect(b.isEmpty()).toBe(false);
    expect(b.peekAll().map((d) => d.message.id)).toEqual(["a", "b"]);

    b.deleteDrained(peeked.map((d) => d.seq));
    expect(b.isEmpty()).toBe(true);
    expect(b.peekAll()).toEqual([]);
  });

  it("deleteDrained is a no-op for an empty seq list", () => {
    const b = createMemoryInjectionBuffer();
    b.enqueue({ dedupeKey: "a", kind: "watcher-completion", message: msg("a"), now: 1 });
    b.deleteDrained([]);
    expect(b.peekAll().map((d) => d.message.id)).toEqual(["a"]);
  });

  it("dedupes by key (existence-check + INSERT semantics)", () => {
    const b = createMemoryInjectionBuffer();
    expect(
      b.enqueue({ dedupeKey: "x", kind: "watcher-completion", message: msg("x1"), now: 1 }),
    ).toBe(true);
    expect(
      b.enqueue({ dedupeKey: "x", kind: "watcher-completion", message: msg("x2"), now: 2 }),
    ).toBe(false);
    expect(b.peekAll().map((d) => d.message.id)).toEqual(["x1"]);
  });

  it("pendingKeys returns only the given kind, in seq order", () => {
    const b = createMemoryInjectionBuffer();
    b.enqueue({ dedupeKey: "u1", kind: "user-message", message: msg("u1"), now: 1 });
    b.enqueue({ dedupeKey: "w1", kind: "watcher-completion", message: msg("w1"), now: 2 });
    b.enqueue({ dedupeKey: "u2", kind: "user-message", message: msg("u2"), now: 3 });
    expect(b.pendingKeys("user-message")).toEqual(["u1", "u2"]);
    expect(b.pendingKeys("watcher-completion")).toEqual(["w1"]);
    expect(b.pendingKeys("subagent-completion")).toEqual([]);
  });

  it("remove returns the message and drops it when pending, null when absent", () => {
    const b = createMemoryInjectionBuffer();
    b.enqueue({ dedupeKey: "u1", kind: "user-message", message: msg("u1"), now: 1 });
    b.enqueue({ dedupeKey: "u2", kind: "user-message", message: msg("u2"), now: 2 });
    // absent key → null, nothing removed
    expect(b.remove("nope")).toBeNull();
    expect(b.pendingKeys("user-message")).toEqual(["u1", "u2"]);
    // pending key → returns its message and removes only that entry
    expect(b.remove("u1")?.id).toBe("u1");
    expect(b.pendingKeys("user-message")).toEqual(["u2"]);
  });

  it("remove is idempotent: a second remove of the same key is null (too-late race)", () => {
    const b = createMemoryInjectionBuffer();
    b.enqueue({ dedupeKey: "u1", kind: "user-message", message: msg("u1"), now: 1 });
    const first = b.remove("u1");
    expect(first?.id).toBe("u1");
    expect(b.remove("u1")).toBeNull();
    expect(b.pendingKeys("user-message")).toEqual([]);
  });

  it("remove with a kind filter only removes an entry of that kind", () => {
    const b = createMemoryInjectionBuffer();
    b.enqueue({ dedupeKey: "w1", kind: "watcher-completion", message: msg("w1"), now: 1 });
    // wrong kind → no-op, entry stays
    expect(b.remove("w1", "user-message")).toBeNull();
    expect(b.pendingKeys("watcher-completion")).toEqual(["w1"]);
    // matching kind → removed
    expect(b.remove("w1", "watcher-completion")?.id).toBe("w1");
    expect(b.pendingKeys("watcher-completion")).toEqual([]);
  });
});
