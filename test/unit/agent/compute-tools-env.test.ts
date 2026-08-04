import { describe, expect, it } from "vitest";
import { buildComputeToolDefs, isQuotaGatedProvider } from "../../../src/agent/compute-tools";

describe("buildComputeToolDefs env hint", () => {
  it("lists preset env var names (editable + secret) in exec description", () => {
    const tools = buildComputeToolDefs(
      async () => ({}) as any,
      async () => ({}) as any,
      { secretEnvVarNames: ["GH_TOKEN"], envVarNames: ["NODE_ENV"] },
    );
    const desc = (tools.exec as any).description as string;
    expect(desc).toContain("GH_TOKEN");
    expect(desc).toContain("NODE_ENV");
    expect(desc).toMatch(/preset environment variables/i);
  });

  it("omits the env note when no vars are configured", () => {
    const tools = buildComputeToolDefs(
      async () => ({}) as any,
      async () => ({}) as any,
    );
    expect((tools.exec as any).description).not.toMatch(/preset environment variables/i);
  });
});

describe("isQuotaGatedProvider", () => {
  it("gates cloudflare unconditionally", () => {
    expect(isQuotaGatedProvider("cloudflare", null, null)).toBe(true);
    expect(isQuotaGatedProvider("cloudflare", "byok", "byok")).toBe(true);
  });

  it("gates daytona only when system-managed", () => {
    expect(isQuotaGatedProvider("daytona", "system", null)).toBe(true);
    expect(isQuotaGatedProvider("daytona", "byok", null)).toBe(false);
    expect(isQuotaGatedProvider("daytona", null, null)).toBe(false);
  });

  it("gates sprites only when system-managed", () => {
    expect(isQuotaGatedProvider("sprites", null, "system")).toBe(true);
    expect(isQuotaGatedProvider("sprites", null, "byok")).toBe(false);
    expect(isQuotaGatedProvider("sprites", null, null)).toBe(false);
  });

  it("never gates mock", () => {
    expect(isQuotaGatedProvider("mock", "system", "system")).toBe(false);
  });
});
