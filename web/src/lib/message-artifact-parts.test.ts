import { describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import {
  collectMessageArtifactParts,
  formatArtifactExpiryHint,
  mintArtifactViewUrl,
  republishArtifact,
} from "./message-artifact-parts";

type Part = UIMessage["parts"][number];

describe("collectMessageArtifactParts", () => {
  it("returns a chip from a successful exec_publish_artifact tool result", () => {
    const parts: Part[] = [
      {
        type: "tool-exec_publish_artifact",
        toolCallId: "call_1",
        state: "output-available",
        input: { path: "/workspace/dist" },
        output: {
          artifactId: "art_1",
          title: "Landing page",
          expiresAt: 1_700_000_000_000,
          url: "/api/artifacts/art_1",
        },
      } as Part,
    ];
    expect(collectMessageArtifactParts(parts)).toEqual([
      {
        artifactId: "art_1",
        title: "Landing page",
        expiresAt: 1_700_000_000_000,
        url: "/api/artifacts/art_1",
      },
    ]);
  });

  it("builds the stable url from artifactId when url is omitted", () => {
    const parts: Part[] = [
      {
        type: "tool-exec_publish_artifact",
        toolCallId: "call_1",
        state: "output-available",
        input: { path: "/workspace/dist" },
        output: {
          artifactId: "art_9",
          title: "Preview",
          expiresAt: 1_700_000_000_000,
        },
      } as Part,
    ];
    expect(collectMessageArtifactParts(parts)[0]?.url).toBe("/api/artifacts/art_9");
  });

  it("ignores incomplete or errored publish tool parts", () => {
    const parts: Part[] = [
      {
        type: "tool-exec_publish_artifact",
        toolCallId: "call_1",
        state: "input-available",
        input: { path: "/workspace/dist" },
      } as Part,
      {
        type: "tool-exec_publish_artifact",
        toolCallId: "call_2",
        state: "output-available",
        input: { path: "/workspace/dist" },
        output: { ok: false, error: "artifact_too_large" },
      } as Part,
    ];
    expect(collectMessageArtifactParts(parts)).toEqual([]);
  });

  it("dedupes by artifact id when the tool appears more than once", () => {
    const output = {
      artifactId: "art_1",
      title: "Landing page",
      expiresAt: 1_700_000_000_000,
      url: "/api/artifacts/art_1",
    };
    const parts: Part[] = [
      {
        type: "tool-exec_publish_artifact",
        toolCallId: "call_1",
        state: "output-available",
        input: { path: "/workspace/dist" },
        output,
      } as Part,
      {
        type: "tool-exec_publish_artifact",
        toolCallId: "call_2",
        state: "output-available",
        input: { path: "/workspace/dist" },
        output,
      } as Part,
    ];
    expect(collectMessageArtifactParts(parts)).toHaveLength(1);
  });
});

describe("formatArtifactExpiryHint", () => {
  const now = 1_700_000_000_000;

  it("labels expired artifacts", () => {
    expect(formatArtifactExpiryHint(now - 1, now)).toBe("Expired");
  });

  it("shows remaining time before expiry", () => {
    expect(formatArtifactExpiryHint(now + 2 * 60 * 60 * 1000, now)).toBe("2h left");
    expect(formatArtifactExpiryHint(now + 26 * 60 * 60 * 1000, now)).toBe("1d left");
  });
});

describe("mintArtifactViewUrl", () => {
  it("POSTs to the view route with credentials and returns viewUrl", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ viewUrl: "https://artifacts.example.com/v/tok/art_1/" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(mintArtifactViewUrl("/api/artifacts/art_1", fetchFn)).resolves.toBe(
      "https://artifacts.example.com/v/tok/art_1/",
    );
    expect(fetchFn).toHaveBeenCalledWith("/api/artifacts/art_1/view", {
      method: "POST",
      credentials: "include",
    });
  });

  it("surfaces server errors via errorFromResponse", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("Artifact expired", { status: 410 }));

    await expect(mintArtifactViewUrl("/api/artifacts/art_1", fetchFn)).rejects.toThrow(
      "Artifact expired",
    );
  });
});

describe("republishArtifact", () => {
  it("POSTs to the republish route and returns the new expiresAt", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ expiresAt: 1_800_000_000_000, status: "active" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(republishArtifact("/api/artifacts/art_1", fetchFn)).resolves.toEqual({
      expiresAt: 1_800_000_000_000,
    });
    expect(fetchFn).toHaveBeenCalledWith("/api/artifacts/art_1/republish", {
      method: "POST",
      credentials: "include",
    });
  });

  it("surfaces server errors via errorFromResponse", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response("This artifact's files are gone. Ask the assistant to publish it again.", {
        status: 410,
      }),
    );

    await expect(republishArtifact("/api/artifacts/art_1", fetchFn)).rejects.toThrow(
      "This artifact's files are gone. Ask the assistant to publish it again.",
    );
  });
});
