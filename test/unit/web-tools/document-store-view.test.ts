import { describe, expect, it } from "vitest";
import { buildDocumentChunkView } from "../../../src/web/document-store";
import { readOutputChunks, grepOutputChunks } from "../../../src/compute/output";

const BODY = ["line one", "line two apple", "line three", "line four apple"].join("\n") + "\n";

describe("buildDocumentChunkView", () => {
  it("produces a single stdout chunk spanning the whole body", () => {
    const chunks = buildDocumentChunkView(BODY);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.stream).toBe("stdout");
    expect(chunks[0]!.lineStart).toBe(1);
    expect(chunks[0]!.lineEnd).toBe(4);
  });

  it("supports line-range reads via readOutputChunks", () => {
    const chunks = buildDocumentChunkView(BODY);
    const out = readOutputChunks(chunks, {
      stream: "stdout",
      startLine: 2,
      endLine: 3,
      maxBytes: 50_000,
    });
    expect(out.text).toContain("line two apple");
    expect(out.text).toContain("line three");
    expect(out.text).not.toContain("line four");
  });

  it("supports grep via grepOutputChunks", () => {
    const chunks = buildDocumentChunkView(BODY);
    const out = grepOutputChunks(chunks, {
      pattern: "apple",
      stream: "stdout",
      caseSensitive: false,
      contextLines: 0,
      maxMatches: 50,
      maxReturnedLines: 200,
      maxBytes: 50_000,
    });
    expect(out.matches).toHaveLength(2);
  });
});
