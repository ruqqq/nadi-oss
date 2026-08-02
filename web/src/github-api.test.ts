import { describe, expect, it, vi } from "vitest";
import { disconnectGithubInstallation, getGithubSettings } from "./github-api";

describe("github-api", () => {
  it("GETs settings", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ configured: true, installations: [] }), { status: 200 }),
    );
    expect(await getGithubSettings(fetchImpl as any)).toEqual({ configured: true, installations: [] });
    expect(fetchImpl).toHaveBeenCalledWith("/api/settings/github", { credentials: "include" });
  });

  it("throws a friendly error on failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(getGithubSettings(fetchImpl as any)).rejects.toThrow();
  });

  it("POSTs disconnect", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await disconnectGithubInstallation(42, fetchImpl as any);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/settings/github/disconnect");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ installationId: 42 });
  });
});
