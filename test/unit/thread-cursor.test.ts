import { describe, expect, it } from "vitest";
import {
  decodeThreadCursor,
  encodeThreadCursor,
  fingerprintThreadQuery,
} from "../../src/http/thread-cursor";

describe("thread cursor", () => {
  it("round-trips a sort position", () => {
    const cursor = encodeThreadCursor({
      sortValue: 1_800_000_000_000,
      id: "thr_abc",
      fingerprint: fingerprintThreadQuery({ sortKey: "updatedAt", project: "all" }),
    });
    expect(decodeThreadCursor(cursor)).toEqual({
      sortValue: 1_800_000_000_000,
      id: "thr_abc",
      fingerprint: fingerprintThreadQuery({ sortKey: "updatedAt", project: "all" }),
    });
  });

  it("round-trips an id containing the delimiter", () => {
    // Ids are opaque; a naive split(":") would truncate this one and page from
    // the wrong place rather than failing.
    const fingerprint = fingerprintThreadQuery({ sortKey: "updatedAt", project: "all" });
    const cursor = encodeThreadCursor({ sortValue: 1, id: "thr:a:b", fingerprint });
    expect(decodeThreadCursor(cursor)).toEqual({ sortValue: 1, id: "thr:a:b", fingerprint });
  });

  it("round-trips a q containing the delimiter and colons", () => {
    // The fingerprint is derived from `q`, not literally embedded, but this
    // guards that a colon-heavy `q` still produces a stable, delimiter-safe
    // fingerprint that round-trips through encode/decode intact.
    const fingerprint = fingerprintThreadQuery({
      sortKey: "updatedAt",
      project: "all",
      q: "a:b::c",
    });
    expect(fingerprint).not.toContain(":");
    const cursor = encodeThreadCursor({ sortValue: 1, id: "thr_1", fingerprint });
    expect(decodeThreadCursor(cursor)).toEqual({ sortValue: 1, id: "thr_1", fingerprint });
  });

  it("rejects junk rather than guessing a position", () => {
    expect(decodeThreadCursor("")).toBeNull();
    expect(decodeThreadCursor("not-base64!!")).toBeNull();
    expect(decodeThreadCursor(btoa("nosortvalue"))).toBeNull();
    expect(decodeThreadCursor(btoa("abc:thr_1"))).toBeNull();
    expect(decodeThreadCursor(btoa("abc:fp"))).toBeNull();
    expect(decodeThreadCursor(btoa("abc::thr_1"))).toBeNull();
  });

  describe("fingerprintThreadQuery", () => {
    it("differs for different sort keys", () => {
      expect(fingerprintThreadQuery({ sortKey: "updatedAt", project: "all" })).not.toBe(
        fingerprintThreadQuery({ sortKey: "archivedAt", project: "all" }),
      );
    });

    it("differs for different q", () => {
      expect(
        fingerprintThreadQuery({ sortKey: "updatedAt", project: "all", q: "deploy" }),
      ).not.toBe(fingerprintThreadQuery({ sortKey: "updatedAt", project: "all", q: "worker" }));
    });

    it("differs for different project filters", () => {
      const all = fingerprintThreadQuery({ sortKey: "updatedAt", project: "all" });
      const unassigned = fingerprintThreadQuery({ sortKey: "updatedAt", project: "unassigned" });
      const proj = fingerprintThreadQuery({
        sortKey: "updatedAt",
        project: { projectId: "proj_1" },
      });
      expect(new Set([all, unassigned, proj]).size).toBe(3);
    });

    it("is stable for the same inputs", () => {
      const a = fingerprintThreadQuery({ sortKey: "updatedAt", project: "all", q: "deploy" });
      const b = fingerprintThreadQuery({ sortKey: "updatedAt", project: "all", q: "  deploy  " });
      expect(a).toBe(b);
    });
  });
});
