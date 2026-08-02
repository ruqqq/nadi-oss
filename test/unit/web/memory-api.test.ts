import { describe, expect, it, vi } from "vitest";
import { archiveMemory, listMemories, restoreMemory } from "../../../web/src/memory-api";

const memory = {
  id: "m1",
  title: "Fact",
  kind: "fact" as const,
  content: "A fact",
  sourceThreadId: null,
  createdAt: 1,
  updatedAt: 2,
  archivedAt: null,
};

describe("memory api helpers", () => {
  it("lists active memories", async () => {
    const fetch = vi.fn(async () => Response.json({ memories: [memory] }));
    await expect(listMemories(false, fetch)).resolves.toEqual([memory]);
    expect(fetch).toHaveBeenCalledWith("/api/memories", { credentials: "include" });
  });

  it("lists archived memories", async () => {
    const fetch = vi.fn(async () => Response.json({ memories: [] }));
    await expect(listMemories(true, fetch)).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledWith("/api/memories?archived=1", { credentials: "include" });
  });

  it("archives and restores", async () => {
    const fetch = vi.fn(async () => Response.json({ memory }));
    await expect(archiveMemory("m1", fetch)).resolves.toEqual(memory);
    expect(fetch).toHaveBeenCalledWith("/api/memories/m1/archive", {
      method: "POST",
      credentials: "include",
    });
    await expect(restoreMemory("m1", fetch)).resolves.toEqual(memory);
    expect(fetch).toHaveBeenCalledWith("/api/memories/m1/restore", {
      method: "POST",
      credentials: "include",
    });
  });

  it("surfaces the server's message on a non-ok response", async () => {
    const fetch = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(listMemories(false, fetch)).rejects.toThrow("nope");
  });
});
