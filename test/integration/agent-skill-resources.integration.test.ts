import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentSkillRepository } from "../../src/db/repositories/agent-skills";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

const scope = { workspaceId: "workspace-a", agentId: "agent-a" };

function repo() {
  return new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
}

describe("AgentSkillRepository resources + domains", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });
  beforeEach(async () => {
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.delete(schema.agentSkillResources);
    await db.delete(schema.agentSkills);
    await db.delete(schema.threadIndex);
    await seedRegistryThread(env.REGISTRY_DB, { ...scope, threadId: "thread-a" });
  });

  // Guards the archived filter for hasEnabledScriptSkill. It is inherited from
  // listActive (isNull(archivedAt)) and nothing else covered it, so a rewrite of
  // that query could silently start counting archived skills' scripts — which
  // would wrongly hand the model run_skill_script for a deleted skill.
  it("hasEnabledScriptSkill ignores archived skills", async () => {
    const r = repo();
    await r.create({ ...scope, name: "greet", description: "d", body: "b" });
    await r.setScript({ ...scope, name: "greet", path: "scripts/run.py", source: "print(1)" });
    expect(await r.hasEnabledScriptSkill(scope)).toBe(true);

    expect(await r.archive({ ...scope, name: "greet" })).toBe(true);
    expect(await r.hasEnabledScriptSkill(scope)).toBe(false);
  });

  it("stores and replaces a single script resource", async () => {
    const r = repo();
    const skill = await r.create({ ...scope, name: "greet", description: "d", body: "b" });
    await r.setScript({ ...scope, name: "greet", path: "scripts/run.py", source: "print(1)" });
    expect((await r.getResource(skill.id, "scripts/run.py"))?.content).toBe("print(1)");
    // Replacing swaps the single script resource rather than accumulating.
    await r.setScript({ ...scope, name: "greet", path: "scripts/main.sh", source: "echo hi" });
    expect(await r.getResource(skill.id, "scripts/run.py")).toBeNull();
    expect((await r.getResource(skill.id, "scripts/main.sh"))?.content).toBe("echo hi");
    expect(await r.hasEnabledScriptSkill(scope)).toBe(true);
  });

  // The imported superpowers skills were stored with `path: "none"`,
  // `content: "# no script"`. The Agents SDK refuses to run anything outside
  // `scripts/`, so those rows advertised a script that could never execute —
  // and, because a script resource is what opens the run_skill_script gate, the
  // model was offered the tool and could only discover the truth by failing.
  it("refuses a script path the SDK would never run", async () => {
    const r = repo();
    await r.create({ ...scope, name: "greet", description: "d", body: "b" });

    for (const path of ["none", "run.py", "/etc/passwd", "scripts/../escape.py", "scripts/"]) {
      await expect(
        r.setScript({ ...scope, name: "greet", path, source: "# no script" }),
      ).rejects.toThrow(/scripts\//);
    }

    // Nothing was written, so the gate stays shut.
    expect(await r.hasEnabledScriptSkill(scope)).toBe(false);
  });

  it("unions declared domains across enabled skills only", async () => {
    const r = repo();
    await r.create({ ...scope, name: "a", description: "d", body: "b" });
    await r.create({ ...scope, name: "b", description: "d", body: "b" });
    await r.setNetworkDomains({ ...scope, name: "a", domains: ["api.example.com", "x.io"] });
    await r.setNetworkDomains({ ...scope, name: "b", domains: ["x.io", "y.io"] });
    expect((await r.listEnabledSkillDomains(scope)).sort()).toEqual([
      "api.example.com",
      "x.io",
      "y.io",
    ]);
    const b = await r.getActiveByName({ ...scope, name: "b" });
    await r.setEnabled({ ...scope, id: b!.id, enabled: false });
    expect((await r.listEnabledSkillDomains(scope)).sort()).toEqual(["api.example.com", "x.io"]);
  });

  it("hasEnabledScriptSkill is false with no scripts and respects enabled", async () => {
    const r = repo();
    const s = await r.create({ ...scope, name: "a", description: "d", body: "b" });
    expect(await r.hasEnabledScriptSkill(scope)).toBe(false);
    await r.setScript({ ...scope, name: "a", path: "scripts/run.sh", source: "echo hi" });
    expect(await r.hasEnabledScriptSkill(scope)).toBe(true);
    await r.setEnabled({ ...scope, id: s.id, enabled: false });
    expect(await r.hasEnabledScriptSkill(scope)).toBe(false);
  });
});
