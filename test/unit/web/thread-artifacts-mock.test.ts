import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupServer } from "../../../web/node_modules/msw/node";
import { listThreadArtifacts } from "../../../web/src/artifacts-api";
import { ASSISTANT_ARTIFACTS_THREAD_ID } from "../../../web/src/mocks/chat/assistant-artifact-transcript";
import { ASSISTANT_DOWNLOAD_THREAD_ID } from "../../../web/src/mocks/chat/assistant-download-transcript";
import { restHandlers } from "../../../web/src/mocks/rest";
import { resetStore, seedStore } from "../../../web/src/mocks/store";

const server = setupServer(...(restHandlers as unknown as Parameters<typeof setupServer>));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  resetStore();
});
afterAll(() => server.close());

const mswFetch: typeof fetch = (input, init) => {
  const url = typeof input === "string" ? new URL(input, "http://localhost").toString() : input;
  return fetch(url, init);
};

describe("mock thread artifacts list", () => {
  beforeEach(() => seedStore("assistant-artifacts"));

  it("returns the seeded artifact for the assistant-artifacts thread", async () => {
    const result = await listThreadArtifacts(ASSISTANT_ARTIFACTS_THREAD_ID, mswFetch);
    expect(result.artifacts).toEqual([
      expect.objectContaining({
        id: "art_mock_dashboard",
        title: "Usage dashboard",
        url: "/api/artifacts/art_mock_dashboard",
      }),
    ]);
    expect(result.artifacts[0]!.expiresAt).toBeGreaterThan(Date.now());
    expect(result.downloads).toEqual([]);
  });

  it("returns the seeded download for the assistant-attachments thread", async () => {
    seedStore("assistant-attachments");
    const result = await listThreadArtifacts(ASSISTANT_DOWNLOAD_THREAD_ID, mswFetch);
    expect(result.artifacts).toEqual([]);
    expect(result.downloads).toEqual([
      expect.objectContaining({
        id: "att_adl_chart",
        filename: "churn_by_segment.png",
        url: "/api/attachments/att_adl_chart",
      }),
    ]);
  });
});
