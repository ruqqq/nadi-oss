import { describe, expect, it } from "vitest";
import { extractThreadId } from "./notification-url";

describe("extractThreadId", () => {
  it("extracts the id from a /threads/:id path", () => {
    expect(extractThreadId("/threads/thr_abc123")).toBe("thr_abc123");
  });

  it("decodes a percent-encoded id (as the server encodes it)", () => {
    expect(extractThreadId(`/threads/${encodeURIComponent("thr/with space")}`)).toBe(
      "thr/with space",
    );
  });

  it("returns null for the root and other routes", () => {
    expect(extractThreadId("/")).toBeNull();
    expect(extractThreadId("/chats")).toBeNull();
    expect(extractThreadId("/settings")).toBeNull();
  });

  it("returns null for a nested path under /threads", () => {
    expect(extractThreadId("/threads/thr_1/extra")).toBeNull();
  });

  it("returns null for a bare /threads with no id", () => {
    expect(extractThreadId("/threads/")).toBeNull();
    expect(extractThreadId("/threads")).toBeNull();
  });

  it("returns null for a full origin URL (only bare paths are routed)", () => {
    expect(extractThreadId("https://nadi.app/threads/thr_1")).toBeNull();
  });
});
