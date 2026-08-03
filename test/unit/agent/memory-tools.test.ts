import { describe, expect, it } from "vitest";
import { createMemoryTools } from "../../../src/agent/memory-tools";
import type { Env } from "../../../src/env";

describe("createMemoryTools descriptions", () => {
  // Descriptions are set at construction; execute is what needs a real Env.
  const tools = createMemoryTools({ env: {} as Env, threadId: "thread-desc" });

  // Bundled multi-topic memories blunt the index hooks and block surgical
  // update/forget. The write tool must prefer one discrete point per call.
  it("tells remember to prefer granular records", () => {
    const description = (tools.remember as { description: string }).description;
    expect(description).toContain("Prefer granular records");
    expect(description).toContain(
      "one discrete fact, preference, constraint, or workflow per call",
    );
    expect(description).toContain("once per point rather than bundling them");
  });
});
