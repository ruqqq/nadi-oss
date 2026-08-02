import { describe, expect, test } from "vitest";
import { resolveRefreshedThreadsPage } from "./thread-refresh";

describe("resolveRefreshedThreadsPage", () => {
  test("carries the real nextCursor on a successful fetch", async () => {
    const result = await resolveRefreshedThreadsPage({
      list: async () => ({ threads: [], nextCursor: "cursor_1" }),
    });
    expect(result.nextCursor).toBe("cursor_1");
  });

  test("returns the fetched page as-is on success", async () => {
    const page = [{ threadId: "t1" }] as never[];
    const result = await resolveRefreshedThreadsPage({
      list: async () => ({ threads: page, nextCursor: null }),
    });
    expect(result.threads).toBe(page);
    expect(result.nextCursor).toBeNull();
  });

  test("the offline fallback yields an empty no-op page and no cursor", async () => {
    const result = await resolveRefreshedThreadsPage({
      list: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(result.threads).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  test("rethrows a real server error", async () => {
    await expect(
      resolveRefreshedThreadsPage({
        list: async () => {
          throw new Error("Workspace not found");
        },
      }),
    ).rejects.toThrow("Workspace not found");
  });
});
