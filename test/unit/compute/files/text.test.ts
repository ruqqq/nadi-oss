import { describe, expect, it } from "vitest";
import { decodeTextFile } from "../../../../src/compute/files/text";

describe("decodeTextFile", () => {
  it("decodes valid UTF-8 text", () => {
    const bytes = new TextEncoder().encode("hello, world").buffer;
    expect(decodeTextFile(bytes)).toBe("hello, world");
  });

  it("rejects invalid UTF-8 as a binary file", () => {
    expect(() => decodeTextFile(new Uint8Array([0xff]).buffer)).toThrow("compute_binary_file");
  });

  it("rejects NUL-containing content as a binary file", () => {
    const bytes = new Uint8Array([0x68, 0x69, 0x00, 0x68, 0x69]).buffer;
    expect(() => decodeTextFile(bytes)).toThrow("compute_binary_file");
  });
});
