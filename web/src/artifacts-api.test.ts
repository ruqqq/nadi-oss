import { describe, expect, it, vi } from "vitest";
import { listThreadArtifacts } from "./artifacts-api";

describe("listThreadArtifacts", () => {
  it("GETs the thread artifacts route and returns both lists", async () => {
    const payload = {
      artifacts: [
        {
          id: "art_1",
          title: "Dashboard",
          entryPath: "index.html",
          fileCount: 2,
          byteSize: 1024,
          expiresAt: 2,
          status: "active",
          url: "/api/artifacts/art_1",
          createdAt: 1,
        },
      ],
      downloads: [
        {
          id: "att_1",
          filename: "chart.png",
          mimeType: "image/png",
          byteSize: 80,
          url: "/api/attachments/att_1",
          createdAt: 3,
        },
      ],
    };
    const fetchImpl = vi.fn(async () => Response.json(payload));

    await expect(listThreadArtifacts("thr_1", fetchImpl)).resolves.toEqual(payload);
    expect(fetchImpl).toHaveBeenCalledWith("/api/threads/thr_1/artifacts", {
      credentials: "include",
    });
  });

  it("surfaces server errors via errorFromResponse", async () => {
    const fetchImpl = vi.fn(async () => new Response("Not found", { status: 404 }));
    await expect(listThreadArtifacts("thr_missing", fetchImpl)).rejects.toThrow("Not found");
  });
});
