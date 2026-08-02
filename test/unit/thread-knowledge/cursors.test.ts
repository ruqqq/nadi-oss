import { describe, expect, it } from "vitest";
import {
  decodeKnowledgeCursor,
  encodeKnowledgeCursor,
  fingerprintKnowledgeQuery,
} from "../../../src/thread-knowledge/cursors";

const listQuery = {
  operation: "list" as const,
  status: "all" as const,
  includeAutomata: false,
};

const searchQuery = {
  operation: "search" as const,
  query: "deployment Friday",
  status: "all" as const,
  includeAutomata: false,
};

const readQuery = {
  operation: "read" as const,
  threadId: "thr_abc",
  order: "chronological" as const,
  includeAutomata: false,
};

describe("knowledge cursors", () => {
  describe("list", () => {
    it("round-trips", () => {
      const fingerprint = fingerprintKnowledgeQuery(listQuery);
      const encoded = encodeKnowledgeCursor({
        version: 1,
        operation: "list",
        fingerprint,
        updatedAt: 1_800_000_000_000,
        id: "thr_list",
      });
      expect(decodeKnowledgeCursor(encoded)).toEqual({
        version: 1,
        operation: "list",
        fingerprint,
        updatedAt: 1_800_000_000_000,
        id: "thr_list",
      });
    });

    it("rejects malformed base64", () => {
      expect(decodeKnowledgeCursor("")).toBeNull();
      expect(decodeKnowledgeCursor("not-base64!!")).toBeNull();
    });

    it("rejects unsupported version", () => {
      const raw = btoa(
        JSON.stringify({
          version: 2,
          operation: "list",
          fingerprint: "abc",
          updatedAt: 1,
          id: "t",
        }),
      );
      expect(decodeKnowledgeCursor(raw)).toBeNull();
    });

    it("rejects fingerprint mismatch", () => {
      const fingerprint = fingerprintKnowledgeQuery(listQuery);
      const encoded = encodeKnowledgeCursor({
        version: 1,
        operation: "list",
        fingerprint,
        updatedAt: 1,
        id: "thr_1",
      });
      const otherFingerprint = fingerprintKnowledgeQuery({ ...listQuery, status: "active" });
      expect(decodeKnowledgeCursor(encoded, fingerprint)).toEqual(decodeKnowledgeCursor(encoded));
      expect(decodeKnowledgeCursor(encoded, otherFingerprint)).toBeNull();
    });
  });

  describe("search", () => {
    it("round-trips", () => {
      const fingerprint = fingerprintKnowledgeQuery(searchQuery);
      const encoded = encodeKnowledgeCursor({
        version: 1,
        operation: "search",
        fingerprint,
        offset: 10,
      });
      expect(decodeKnowledgeCursor(encoded)).toEqual({
        version: 1,
        operation: "search",
        fingerprint,
        offset: 10,
      });
    });

    it("rejects malformed base64", () => {
      expect(decodeKnowledgeCursor("%%%")).toBeNull();
    });

    it("rejects unsupported version", () => {
      const raw = btoa(
        JSON.stringify({ version: 0, operation: "search", fingerprint: "abc", offset: 0 }),
      );
      expect(decodeKnowledgeCursor(raw)).toBeNull();
    });

    it("rejects fingerprint mismatch", () => {
      const fingerprint = fingerprintKnowledgeQuery(searchQuery);
      const encoded = encodeKnowledgeCursor({
        version: 1,
        operation: "search",
        fingerprint,
        offset: 5,
      });
      const otherFingerprint = fingerprintKnowledgeQuery({ ...searchQuery, query: "other terms" });
      expect(decodeKnowledgeCursor(encoded, otherFingerprint)).toBeNull();
    });
  });

  describe("read", () => {
    it("round-trips", () => {
      const fingerprint = fingerprintKnowledgeQuery(readQuery);
      const encoded = encodeKnowledgeCursor({
        version: 1,
        operation: "read",
        fingerprint,
        messageId: "msg_42",
        position: 7,
      });
      expect(decodeKnowledgeCursor(encoded)).toEqual({
        version: 1,
        operation: "read",
        fingerprint,
        messageId: "msg_42",
        position: 7,
      });
    });

    it("rejects malformed base64", () => {
      expect(decodeKnowledgeCursor("not-valid")).toBeNull();
    });

    it("rejects unsupported version", () => {
      const raw = btoa(
        JSON.stringify({
          version: 99,
          operation: "read",
          fingerprint: "abc",
          messageId: "m",
          position: 1,
        }),
      );
      expect(decodeKnowledgeCursor(raw)).toBeNull();
    });

    it("rejects fingerprint mismatch", () => {
      const fingerprint = fingerprintKnowledgeQuery(readQuery);
      const encoded = encodeKnowledgeCursor({
        version: 1,
        operation: "read",
        fingerprint,
        messageId: "msg_1",
        position: 2,
      });
      const otherFingerprint = fingerprintKnowledgeQuery({ ...readQuery, threadId: "thr_other" });
      expect(decodeKnowledgeCursor(encoded, otherFingerprint)).toBeNull();
    });
  });

  describe("fingerprintKnowledgeQuery", () => {
    const baseList = {
      operation: "list" as const,
      status: "all" as const,
      includeAutomata: false,
    };

    it("differs for different operations", () => {
      expect(fingerprintKnowledgeQuery(baseList)).not.toBe(
        fingerprintKnowledgeQuery({ ...searchQuery, query: "x" }),
      );
      expect(fingerprintKnowledgeQuery(baseList)).not.toBe(fingerprintKnowledgeQuery(readQuery));
    });

    it("differs for different status", () => {
      expect(fingerprintKnowledgeQuery(baseList)).not.toBe(
        fingerprintKnowledgeQuery({ ...baseList, status: "active" }),
      );
    });

    it("differs for different project", () => {
      expect(fingerprintKnowledgeQuery(baseList)).not.toBe(
        fingerprintKnowledgeQuery({ ...baseList, projectId: "proj_1" }),
      );
    });

    it("differs for includeAutomata", () => {
      expect(fingerprintKnowledgeQuery(baseList)).not.toBe(
        fingerprintKnowledgeQuery({ ...baseList, includeAutomata: true }),
      );
    });

    it("differs for since", () => {
      expect(fingerprintKnowledgeQuery(baseList)).not.toBe(
        fingerprintKnowledgeQuery({ ...baseList, since: 1 }),
      );
    });

    it("differs for until", () => {
      expect(fingerprintKnowledgeQuery(baseList)).not.toBe(
        fingerprintKnowledgeQuery({ ...baseList, until: 2 }),
      );
    });

    it("differs for order", () => {
      expect(fingerprintKnowledgeQuery(readQuery)).not.toBe(
        fingerprintKnowledgeQuery({ ...readQuery, order: "reverse" }),
      );
    });

    it("differs for thread ID", () => {
      expect(fingerprintKnowledgeQuery(readQuery)).not.toBe(
        fingerprintKnowledgeQuery({ ...readQuery, threadId: "thr_other" }),
      );
    });

    it("differs for normalized search query", () => {
      const a = fingerprintKnowledgeQuery({ ...searchQuery, query: "deploy" });
      const b = fingerprintKnowledgeQuery({ ...searchQuery, query: "worker" });
      expect(a).not.toBe(b);
    });

    it("differs for raw search queries that normalize to the same FTS query", () => {
      const a = fingerprintKnowledgeQuery({ ...searchQuery, query: "deploy" });
      const b = fingerprintKnowledgeQuery({ ...searchQuery, query: "deploy!!!" });
      expect(a).not.toBe(b);
    });

    it("is stable for the same inputs", () => {
      const a = fingerprintKnowledgeQuery(baseList);
      const b = fingerprintKnowledgeQuery({ ...baseList });
      expect(a).toBe(b);
    });
  });
});
