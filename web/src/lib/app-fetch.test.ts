// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { appFetch } from "./app-fetch";
import { OfflineError } from "./offline-state";

function setOnline(online: boolean) {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(online);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("appFetch", () => {
  test("passes GETs through while offline (reads are allowed)", async () => {
    setOnline(false);
    const inner = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", inner);

    await expect(appFetch("/api/threads")).resolves.toBeInstanceOf(Response);
    expect(inner).toHaveBeenCalledOnce();
  });

  test("throws OfflineError for a POST while offline", async () => {
    setOnline(false);
    const inner = vi.fn();
    vi.stubGlobal("fetch", inner);

    await expect(appFetch("/api/threads", { method: "POST" })).rejects.toBeInstanceOf(OfflineError);
    expect(inner).not.toHaveBeenCalled();
  });

  test("throws OfflineError for DELETE while offline", async () => {
    setOnline(false);
    vi.stubGlobal("fetch", vi.fn());
    await expect(appFetch("/api/threads/t1", { method: "delete" })).rejects.toBeInstanceOf(
      OfflineError,
    );
  });

  test("passes mutations through while online", async () => {
    setOnline(true);
    const inner = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", inner);

    await expect(appFetch("/api/threads", { method: "POST" })).resolves.toBeInstanceOf(Response);
    expect(inner).toHaveBeenCalledOnce();
  });

  test("honours the method on a Request object", async () => {
    setOnline(false);
    vi.stubGlobal("fetch", vi.fn());
    const req = new Request("https://example.test/api/threads", { method: "POST" });
    await expect(appFetch(req)).rejects.toBeInstanceOf(OfflineError);
  });
});
