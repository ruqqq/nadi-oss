import { describe, expect, it } from "vitest";
import { applyPatchToFiles, parsePatch } from "../../../../src/compute/files/patch";

describe("parsePatch", () => {
  it("parses an empty patch into zero operations", () => {
    const patch = `*** Begin Patch\n*** End Patch`;
    expect(parsePatch(patch)).toEqual([]);
  });

  it("parses an add file operation", () => {
    const patch = `*** Begin Patch\n*** Add File: src/new.ts\n+export const flag = true;\n*** End Patch`;
    expect(parsePatch(patch)).toEqual([
      { kind: "add", path: "src/new.ts", content: "export const flag = true;\n" },
    ]);
  });

  it("parses a delete file operation", () => {
    const patch = `*** Begin Patch\n*** Delete File: src/old.ts\n*** End Patch`;
    expect(parsePatch(patch)).toEqual([{ kind: "delete", path: "src/old.ts" }]);
  });

  it("parses an update file operation with a move (plan brief fixture)", () => {
    const patch = `*** Begin Patch
*** Update File: src/value.ts
@@
-export const value = 1;
+export const value = 2;
*** Move to: src/current-value.ts
*** End Patch`;
    expect(parsePatch(patch)).toEqual([
      {
        kind: "update",
        path: "src/value.ts",
        moveTo: "src/current-value.ts",
        hunks: [
          {
            lines: [
              { kind: "remove", text: "export const value = 1;" },
              { kind: "add", text: "export const value = 2;" },
            ],
          },
        ],
      },
    ]);
  });

  it("parses an update file operation with context lines across multiple hunks", () => {
    const patch = `*** Begin Patch
*** Update File: src/list.ts
@@
 one
-two
+TWO
 three
@@
 four
-five
+FIVE
*** End Patch`;
    expect(parsePatch(patch)).toEqual([
      {
        kind: "update",
        path: "src/list.ts",
        hunks: [
          {
            lines: [
              { kind: "context", text: "one" },
              { kind: "remove", text: "two" },
              { kind: "add", text: "TWO" },
              { kind: "context", text: "three" },
            ],
          },
          {
            lines: [
              { kind: "context", text: "four" },
              { kind: "remove", text: "five" },
              { kind: "add", text: "FIVE" },
            ],
          },
        ],
      },
    ]);
  });

  it("rejects a patch missing the final End Patch marker", () => {
    const patch = `*** Begin Patch\n*** Delete File: src/old.ts`;
    expect(() => parsePatch(patch)).toThrow("compute_patch_malformed");
  });

  it("rejects a patch missing the Begin Patch marker", () => {
    const patch = `*** Delete File: src/old.ts\n*** End Patch`;
    expect(() => parsePatch(patch)).toThrow("compute_patch_malformed");
  });

  it("rejects a patch with duplicate Begin Patch markers", () => {
    const patch = `*** Begin Patch\n*** Begin Patch\n*** End Patch`;
    expect(() => parsePatch(patch)).toThrow("compute_patch_malformed");
  });

  it("rejects an unrecognized operation header", () => {
    const patch = `*** Begin Patch\n*** Rename File: src/old.ts\n*** End Patch`;
    expect(() => parsePatch(patch)).toThrow("compute_patch_malformed");
  });

  it("rejects a content line outside any operation block", () => {
    const patch = `*** Begin Patch\n+stray content\n*** End Patch`;
    expect(() => parsePatch(patch)).toThrow("compute_patch_malformed");
  });

  it("rejects a path used as more than one operation source", () => {
    const patch = `*** Begin Patch
*** Delete File: src/dup.ts
*** Update File: src/dup.ts
@@
-export const value = 1;
+export const value = 2;
*** End Patch`;
    expect(() => parsePatch(patch)).toThrow("compute_patch_duplicate_path");
  });

  it("rejects a move destination that collides with another operation's target", () => {
    const patch = `*** Begin Patch
*** Add File: src/collide.ts
+export const value = 1;
*** Update File: src/value.ts
@@
-export const value = 1;
+export const value = 2;
*** Move to: src/collide.ts
*** End Patch`;
    expect(() => parsePatch(patch)).toThrow("compute_patch_duplicate_path");
  });

  it("rejects a move destination that collides with a path the patch deletes (defect 1)", () => {
    // a.ts is moved to b.ts, and b.ts is separately deleted: writes["b.ts"]
    // followed by deletes["b.ts"] would destroy both the original and the
    // moved content, so this must be rejected at parse time.
    const patch = `*** Begin Patch
*** Update File: a.ts
@@
-const a = 1;
+const a = 2;
*** Move to: b.ts
*** Delete File: b.ts
*** End Patch`;
    expect(() => parsePatch(patch)).toThrow("compute_patch_duplicate_path");
  });

  // Aliasing: two spellings of one path are identical on disk (the file service
  // keys execution on the normalized /workspace/... form) but were distinct to
  // the raw-string dedup guard, so a write and a delete of the same file slipped
  // through and the commit's write-then-delete destroyed it.
  const ALIASES = ["./src/a.ts", "src//a.ts", "src/./a.ts"];

  for (const alias of ALIASES) {
    it(`rejects an update to src/a.ts deleted under the alias "${alias}"`, () => {
      const patch = `*** Begin Patch
*** Update File: src/a.ts
@@
 keep
-old
+new
*** Delete File: ${alias}
*** End Patch`;
      expect(() => parsePatch(patch)).toThrow("compute_patch_duplicate_path");
    });

    it(`rejects two sources naming one file via the alias "${alias}"`, () => {
      const patch = `*** Begin Patch
*** Delete File: src/a.ts
*** Delete File: ${alias}
*** End Patch`;
      expect(() => parsePatch(patch)).toThrow("compute_patch_duplicate_path");
    });
  }

  it("allows an in-place update with no move to write to its own source path", () => {
    const patch = `*** Begin Patch
*** Update File: a.ts
@@
-const a = 1;
+const a = 2;
*** End Patch`;
    expect(() => parsePatch(patch)).not.toThrow();
  });

  it("parses a blank context line that arrives with stripped trailing whitespace (defect 2)", () => {
    // Editors/terminals routinely strip trailing whitespace, so a blank
    // context line (" ") often arrives as "" instead. That must still parse
    // as a context line with empty text, not be treated as malformed.
    const patch = `*** Begin Patch
*** Update File: a.ts
@@
 one

-two
+TWO
*** End Patch`;
    expect(parsePatch(patch)).toEqual([
      {
        kind: "update",
        path: "a.ts",
        hunks: [
          {
            lines: [
              { kind: "context", text: "one" },
              { kind: "context", text: "" },
              { kind: "remove", text: "two" },
              { kind: "add", text: "TWO" },
            ],
          },
        ],
      },
    ]);
  });
});

describe("applyPatchToFiles", () => {
  it("applies the update+move fixture from the plan brief", () => {
    const patch = `*** Begin Patch
*** Update File: src/value.ts
@@
-export const value = 1;
+export const value = 2;
*** Move to: src/current-value.ts
*** End Patch`;

    expect(
      applyPatchToFiles(
        parsePatch(patch),
        new Map([["src/value.ts", "export const value = 1;\n"]]),
      ),
    ).toEqual({
      writes: new Map([["src/current-value.ts", "export const value = 2;\n"]]),
      deletes: new Set(["src/value.ts"]),
    });
  });

  it("applies an add operation", () => {
    const patch = `*** Begin Patch\n*** Add File: src/new.ts\n+export const flag = true;\n*** End Patch`;
    expect(applyPatchToFiles(parsePatch(patch), new Map())).toEqual({
      writes: new Map([["src/new.ts", "export const flag = true;\n"]]),
      deletes: new Set(),
    });
  });

  it("applies a delete operation", () => {
    const patch = `*** Begin Patch\n*** Delete File: src/old.ts\n*** End Patch`;
    expect(applyPatchToFiles(parsePatch(patch), new Map([["src/old.ts", "stale\n"]]))).toEqual({
      writes: new Map(),
      deletes: new Set(["src/old.ts"]),
    });
  });

  it("applies an update operation without a move", () => {
    const patch = `*** Begin Patch
*** Update File: src/value.ts
@@
-export const value = 1;
+export const value = 2;
*** End Patch`;
    expect(
      applyPatchToFiles(
        parsePatch(patch),
        new Map([["src/value.ts", "export const value = 1;\n"]]),
      ),
    ).toEqual({
      writes: new Map([["src/value.ts", "export const value = 2;\n"]]),
      deletes: new Set(),
    });
  });

  it("applies an empty patch as a no-op", () => {
    const patch = `*** Begin Patch\n*** End Patch`;
    expect(applyPatchToFiles(parsePatch(patch), new Map())).toEqual({
      writes: new Map(),
      deletes: new Set(),
    });
  });

  it("applies multiple hunks in source order with surrounding context", () => {
    const original = `${["one", "two", "three", "four", "five"].join("\n")}\n`;
    const patch = `*** Begin Patch
*** Update File: src/list.ts
@@
 one
-two
+TWO
 three
@@
 four
-five
+FIVE
*** End Patch`;
    expect(applyPatchToFiles(parsePatch(patch), new Map([["src/list.ts", original]]))).toEqual({
      writes: new Map([["src/list.ts", `${["one", "TWO", "three", "four", "FIVE"].join("\n")}\n`]]),
      deletes: new Set(),
    });
  });

  it("rejects a hunk whose context does not match the file exactly", () => {
    const patch = `*** Begin Patch
*** Update File: src/value.ts
@@
-export const value = 99;
+export const value = 2;
*** End Patch`;
    expect(() =>
      applyPatchToFiles(
        parsePatch(patch),
        new Map([["src/value.ts", "export const value = 1;\n"]]),
      ),
    ).toThrow("compute_patch_hunk_mismatch");
  });

  it("rejects overlapping hunks within one file", () => {
    const original = `${["one", "two", "three"].join("\n")}\n`;
    const patch = `*** Begin Patch
*** Update File: src/list.ts
@@
 one
-two
+TWO
 three
@@
-two
+deux
*** End Patch`;
    expect(() =>
      applyPatchToFiles(parsePatch(patch), new Map([["src/list.ts", original]])),
    ).toThrow("compute_patch_hunk_overlap");
  });

  it("rejects updating a file that is not present in the workspace snapshot", () => {
    const patch = `*** Begin Patch
*** Update File: src/missing.ts
@@
-export const value = 1;
+export const value = 2;
*** End Patch`;
    expect(() => applyPatchToFiles(parsePatch(patch), new Map())).toThrow(
      "compute_patch_missing_file",
    );
  });

  it("rejects deleting a file that is not present in the workspace snapshot", () => {
    const patch = `*** Begin Patch\n*** Delete File: src/missing.ts\n*** End Patch`;
    expect(() => applyPatchToFiles(parsePatch(patch), new Map())).toThrow(
      "compute_patch_missing_file",
    );
  });

  it("rejects adding a file that already exists in the workspace snapshot", () => {
    const patch = `*** Begin Patch\n*** Add File: src/existing.ts\n+content\n*** End Patch`;
    expect(() =>
      applyPatchToFiles(parsePatch(patch), new Map([["src/existing.ts", "content\n"]])),
    ).toThrow("compute_patch_file_exists");
  });
});
