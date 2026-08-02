import { describe, expect, it } from "vitest";
import { buildComputeToolDefs } from "../../../src/agent/compute-tools";

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
