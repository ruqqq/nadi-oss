// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, test } from "vitest";
import type { CachedMessages } from "./thread-history-cache-policy";
import { purgeCachedHistory, readCachedHistory, writeCachedHistory } from "./thread-history-cache";

function messages(id: string): CachedMessages {
  return [{ id, role: "user", parts: [{ type: "text", text: "hi" }] }] as CachedMessages;
}

beforeEach(async () => {
  await purgeCachedHistory();
});

describe("thread-history cache", () => {
  test("reads back what it wrote", async () => {
    await writeCachedHistory("t1", messages("m1"));
    expect(await readCachedHistory("t1")).toEqual(messages("m1"));
  });

  test("returns null for a thread that was never cached", async () => {
    expect(await readCachedHistory("nope")).toBeNull();
  });

  test("overwrites an existing entry rather than appending", async () => {
    await writeCachedHistory("t1", messages("m1"));
    await writeCachedHistory("t1", messages("m2"));
    expect(await readCachedHistory("t1")).toEqual(messages("m2"));
  });

  test("round-trips an empty transcript", async () => {
    await writeCachedHistory("t1", [] as CachedMessages);
    expect(await readCachedHistory("t1")).toEqual([]);
  });

  test("purge removes every entry", async () => {
    await writeCachedHistory("t1", messages("m1"));
    await writeCachedHistory("t2", messages("m2"));
    await purgeCachedHistory();
    expect(await readCachedHistory("t1")).toBeNull();
    expect(await readCachedHistory("t2")).toBeNull();
  });

  test("evicts the least-recently-opened entry beyond the cap", async () => {
    // Cap is 50; write 51 threads and the first one written must fall off.
    for (let i = 0; i < 51; i++) {
      await writeCachedHistory(`t${i}`, messages(`m${i}`));
    }
    expect(await readCachedHistory("t0")).toBeNull();
    expect(await readCachedHistory("t50")).toEqual(messages("m50"));
  });

  test("a re-written thread is not the eviction victim", async () => {
    for (let i = 0; i < 50; i++) {
      await writeCachedHistory(`t${i}`, messages(`m${i}`));
    }
    // Touch the oldest so it becomes the most recent, then overflow by one.
    await writeCachedHistory("t0", messages("m0-again"));
    await writeCachedHistory("overflow", messages("m-overflow"));

    expect(await readCachedHistory("t0")).toEqual(messages("m0-again"));
    expect(await readCachedHistory("t1")).toBeNull();
  });
});

// The sign-out shape: purgeCachedHistory() runs, then navigate() unmounts
// <ThreadChat> and flushes its debounced settle-write — so the write is in
// flight *across* the purge, not before or after it. Every other test in this
// file awaits between calls and so can never see this.
describe("purge racing an in-flight write", () => {
  // The exact sign-out ordering: purge is called, and before its `clear` can
  // even reach the store the unmount-flush issues a write. IndexedDB serializes
  // the two readwrite transactions in creation order — purge's first — so the
  // put lands AFTER the clear and re-inserts the signed-out transcript.
  test("a write issued while a purge is in flight is abandoned", async () => {
    const purge = purgeCachedHistory();
    const write = writeCachedHistory("t1", messages("m1"));
    await Promise.all([purge, write]);

    expect(await readCachedHistory("t1")).toBeNull();
  });

  // The mirror ordering: the write starts first and the purge overtakes it.
  test("a purge starting while a write is in flight still wins", async () => {
    const write = writeCachedHistory("t1", messages("m1"));
    const purge = purgeCachedHistory();
    await Promise.all([write, purge]);

    expect(await readCachedHistory("t1")).toBeNull();
  });

  test("purging with several writes racing it leaves nothing behind", async () => {
    const purge = purgeCachedHistory();
    const writes = ["t1", "t2", "t3"].map((id) => writeCachedHistory(id, messages(id)));
    await Promise.all([purge, ...writes]);

    for (const id of ["t1", "t2", "t3"]) {
      expect(await readCachedHistory(id)).toBeNull();
    }
  });

  // The epoch must gate writes that span a purge, not wedge the cache forever.
  test("a write starting after the purge completes is stored normally", async () => {
    await writeCachedHistory("t1", messages("m1"));
    await purgeCachedHistory();
    await writeCachedHistory("t2", messages("m2"));

    expect(await readCachedHistory("t1")).toBeNull();
    expect(await readCachedHistory("t2")).toEqual(messages("m2"));
  });

  test("repeated purges do not permanently disable writes", async () => {
    await purgeCachedHistory();
    await purgeCachedHistory();
    await purgeCachedHistory();
    await writeCachedHistory("t1", messages("m1"));

    expect(await readCachedHistory("t1")).toEqual(messages("m1"));
  });
});

describe("purgeCachedHistory", () => {
  test("is safe to call when nothing was ever cached", async () => {
    await expect(purgeCachedHistory()).resolves.toBeUndefined();
  });

  test("leaves the store usable afterwards", async () => {
    await writeCachedHistory("t1", messages("m1"));
    await purgeCachedHistory();
    await writeCachedHistory("t2", messages("m2"));
    expect(await readCachedHistory("t1")).toBeNull();
    expect(await readCachedHistory("t2")).toEqual(messages("m2"));
  });
});
