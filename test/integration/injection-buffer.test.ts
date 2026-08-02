import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { InjectionBuffer } from "../../src/agent/injection-buffer";

function storageOf(agent: unknown): DurableObjectStorage {
  return (agent as { ctx: { storage: DurableObjectStorage } }).ctx.storage;
}
const msg = (id: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text: id }] });

describe("InjectionBuffer (real DO SQLite)", () => {
  it("migrates idempotently, dedupes, peeks FIFO without deleting, then deletes by seq", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("thr_injection_buffer"),
    );
    await runInDurableObject(stub, async (agent: unknown) => {
      const b = new InjectionBuffer(storageOf(agent));
      b.migrate();
      b.migrate(); // idempotent
      expect(b.isEmpty()).toBe(true);
      expect(
        b.enqueue({ dedupeKey: "k1", kind: "watcher-completion", message: msg("m1"), now: 1 }),
      ).toBe(true);
      expect(
        b.enqueue({ dedupeKey: "k1", kind: "watcher-completion", message: msg("dup"), now: 2 }),
      ).toBe(false);
      expect(
        b.enqueue({ dedupeKey: "k2", kind: "subagent-completion", message: msg("m2"), now: 3 }),
      ).toBe(true);
      expect(b.isEmpty()).toBe(false);

      const peeked = b.peekAll();
      expect(peeked.map((d) => d.message.id)).toEqual(["m1", "m2"]);
      // peekAll is read-only: the rows are still there, and a crash between
      // peek and persist would leave them for the next drain to retry.
      expect(b.isEmpty()).toBe(false);
      expect(b.peekAll().map((d) => d.message.id)).toEqual(["m1", "m2"]);

      // deleteDrained only removes the given seqs, and only after the caller
      // has durably persisted the peeked messages elsewhere.
      b.deleteDrained(peeked.map((d) => d.seq));
      expect(b.isEmpty()).toBe(true);
      expect(b.peekAll()).toEqual([]);
    });
  });

  it("deleteDrained no-ops on an empty seq list", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("thr_injection_buffer_noop"),
    );
    await runInDurableObject(stub, async (agent: unknown) => {
      const b = new InjectionBuffer(storageOf(agent));
      b.migrate();
      b.enqueue({ dedupeKey: "k1", kind: "watcher-completion", message: msg("m1"), now: 1 });
      b.deleteDrained([]);
      expect(b.peekAll().map((d) => d.message.id)).toEqual(["m1"]);
    });
  });

  it("pendingKeys filters by kind; remove drops by dedupeKey and is idempotent", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("thr_injection_buffer_steer"),
    );
    await runInDurableObject(stub, async (agent: unknown) => {
      const b = new InjectionBuffer(storageOf(agent));
      b.migrate();
      b.enqueue({ dedupeKey: "u1", kind: "user-message", message: msg("u1"), now: 1 });
      b.enqueue({ dedupeKey: "w1", kind: "watcher-completion", message: msg("w1"), now: 2 });
      b.enqueue({ dedupeKey: "u2", kind: "user-message", message: msg("u2"), now: 3 });

      expect(b.pendingKeys("user-message")).toEqual(["u1", "u2"]);
      expect(b.pendingKeys("watcher-completion")).toEqual(["w1"]);

      // remove a pending user-message → returns its message, drops only it
      expect(b.remove("u1")?.id).toBe("u1");
      expect(b.pendingKeys("user-message")).toEqual(["u2"]);
      // second remove of the same key → null (too-late race), no throw
      expect(b.remove("u1")).toBeNull();
      // absent key → null
      expect(b.remove("nope")).toBeNull();
      // the other kinds are untouched
      expect(b.pendingKeys("watcher-completion")).toEqual(["w1"]);
    });
  });
});
