import { describe, expect, it } from "vitest";
import { formatByteSize } from "./ThreadArtifactListRows";

describe("formatByteSize", () => {
  it("formats bytes, kilobytes, and megabytes", () => {
    expect(formatByteSize(0)).toBe("0 B");
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(1024)).toBe("1 KB");
    expect(formatByteSize(28_400)).toBe("28 KB");
    expect(formatByteSize(1_572_864)).toBe("1.5 MB");
    expect(formatByteSize(10 * 1024 * 1024)).toBe("10 MB");
  });

  it("renders a dash for non-finite sizes", () => {
    expect(formatByteSize(Number.NaN)).toBe("—");
    expect(formatByteSize(-1)).toBe("—");
  });
});
