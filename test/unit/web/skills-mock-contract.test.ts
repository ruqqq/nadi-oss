// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupServer } from "../../../web/node_modules/msw/node";
import { restHandlers } from "../../../web/src/mocks/rest";
import {
  createSkill,
  listAgentSkills,
  listSkills,
  updateSkill,
} from "../../../web/src/skills-api";
import { getStore, resetStore, seedStore } from "../../../web/src/mocks/store";

const server = setupServer(...(restHandlers as unknown as Parameters<typeof setupServer>));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  resetStore();
});
afterAll(() => server.close());

/**
 * The skill handlers are registered with ORIGIN-RELATIVE paths (`/api/skills`),
 * which MSW resolves against `location.origin`. Hence jsdom above, and hence
 * resolving against `location.href` rather than a hardcoded origin: a request
 * to `http://localhost` when jsdom serves `http://localhost:3000` is simply
 * unhandled, and reads as a broken handler rather than a wrong base URL.
 */
const mswFetch: typeof fetch = (input, init) => {
  const url =
    typeof input === "string" ? new URL(input, globalThis.location.href).toString() : input;
  return fetch(url, init);
};

/**
 * The mock is only worth trusting while it matches the real contract, and
 * `liveOnAgentCount` is the field where "absent" and "0" mean opposite things:
 * absent is "we did not compute this", 0 is "no agent loads it". The server
 * sends it on LIBRARY-scope ACTIVE listings only — `listSkills` in
 * `src/http/skill-routes.ts` returns early through `serialize` for an agent
 * scope or the archived tab, because `countAgentsLiveOn` requires
 * `archived_at IS NULL` and would answer zero for every archived row.
 */
describe("mock GET /api/skills — where liveOnAgentCount is sent", () => {
  beforeEach(() => seedStore("default"));

  it("annotates the active library listing", async () => {
    const skills = await listSkills(false, null, mswFetch);

    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) expect(typeof skill.liveOnAgentCount).toBe("number");
  });

  it("sends no count on the archived library listing — absent, not zero", async () => {
    const skills = await listSkills(true, null, mswFetch);

    expect(skills.map((s) => s.id)).toContain("skl_old");
    for (const skill of skills) expect(skill).not.toHaveProperty("liveOnAgentCount");
  });

  it("sends no count on an agent's own skills", async () => {
    const skills = await listSkills(false, "wb_nadi", mswFetch);

    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) expect(skill).not.toHaveProperty("liveOnAgentCount");
  });
});

/**
 * ...and WHAT it is, which the block above never checked.
 *
 * The server's rule is `AgentSkillRepository.countAgentsLiveOn`: unarchived
 * agents in the workspace, MINUS those that excluded the skill, MINUS those
 * whose own unarchived skill of that name shadows it. A disabled AGENT still
 * counts; the skill's own `enabled` is deliberately not applied.
 *
 * That rule is SQL and cannot be imported here the way
 * `thread-read-only-mock-contract.test.ts` imports `serializeThread`. So it is
 * cross-checked two ways instead, neither of which reads `liveOnAgentCount`'s
 * own code: against the per-agent annotations that
 * `GET /api/agents/:id/skills` computes independently, and against the exact
 * numbers the `default` scenario is seeded to produce — one case per clause, so
 * dropping any clause changes at least one of them.
 */
describe("mock GET /api/skills — what liveOnAgentCount is", () => {
  beforeEach(() => seedStore("default"));

  it("agrees with the per-agent annotations the agent listing derives", async () => {
    const store = getStore();
    const library = await listSkills(false, null, mswFetch);
    const agents = store.agents.filter((agent) => !agent.archivedAt);

    // Non-vacuity: the scenario must actually spread the value, or this loop
    // compares two implementations on cases where they cannot disagree.
    expect(agents.length).toBeGreaterThan(1);
    const values = new Set(library.map((skill) => skill.liveOnAgentCount));
    expect(values.size).toBeGreaterThan(1);
    expect(values).toContain(0);

    const carriers = new Map<string, number>(library.map((skill) => [skill.id, 0]));
    for (const agent of agents) {
      const { library: annotated } = await listAgentSkills(agent.id, mswFetch);
      for (const row of annotated) {
        // The other surface's own rule, unchanged: excluded or shadowed means
        // this agent does not carry it. `enabled` is NOT consulted — the count
        // reports carriers, not current loads.
        if (row.excluded || row.shadowedByOwnSkillId !== null) continue;
        carriers.set(row.id, (carriers.get(row.id) ?? 0) + 1);
      }
    }

    expect(new Map(library.map((skill) => [skill.id, skill.liveOnAgentCount]))).toEqual(carriers);
  });

  it("counts the seeded spread exactly, one case per clause of the rule", async () => {
    const byId = new Map(
      (await listSkills(false, null, mswFetch)).map((skill) => [skill.id, skill]),
    );

    // Three unarchived agents. `skl_review` is excluded by nobody and shadowed
    // by nobody, so it is the plain population count — and it is DISABLED, which
    // must not reduce it.
    expect(byId.get("skl_review")).toMatchObject({ enabled: false, liveOnAgentCount: 3 });
    // `skl_notes`: one exclusion (wb_infra).
    expect(byId.get("skl_notes")?.liveOnAgentCount).toBe(2);
    // `skl_swe`: one exclusion (wb_docs) AND one shadow (wb_nadi's own
    // `software_engineering`) — the two clauses cannot be told apart by a total
    // alone, so both of the rows above are needed beside this one.
    expect(byId.get("skl_swe")?.liveOnAgentCount).toBe(1);
    // `skl_triage`: excluded by every agent. Zero is a real answer here.
    expect(byId.get("skl_triage")?.liveOnAgentCount).toBe(0);
  });

  /**
   * The third clause, which nothing in the `default` scenario exercises: a
   * DISABLED agent is still counted, and an ARCHIVED one is not. Both are
   * `countAgentsLiveOn`'s own rule — carriage, not activity: a paused agent
   * loads the skill again the moment it is resumed, so a number that dropped
   * when it was paused would understate the radius at the moment someone is
   * deciding whether to edit.
   *
   * Asserted here rather than in the loop above because the store carries no
   * disabled agent to compare on: without this the clause could be deleted from
   * the mock and every other assertion in this file would still pass.
   */
  it("counts a paused agent and drops a deleted one", async () => {
    const store = getStore();
    const count = async () =>
      (await listSkills(false, null, mswFetch)).find((s) => s.id === "skl_review")
        ?.liveOnAgentCount;

    expect(await count()).toBe(3);

    const paused = store.agents.find((agent) => agent.id === "wb_docs");
    expect(paused).toBeDefined();
    paused!.enabled = false;
    expect(await count()).toBe(3);

    paused!.archivedAt = Date.now();
    expect(await count()).toBe(2);
  });

  it("stops counting an agent that opts out, and starts again when it opts back in", async () => {
    const before = await listSkills(false, null, mswFetch);
    expect(before.find((s) => s.id === "skl_review")?.liveOnAgentCount).toBe(3);

    const exclude = async (excluded: boolean) => {
      const res = await mswFetch("/api/agents/wb_docs/skills/skl_review/exclusion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ excluded }),
      });
      expect(res.status).toBe(204);
    };

    await exclude(true);
    expect(
      (await listSkills(false, null, mswFetch)).find((s) => s.id === "skl_review")
        ?.liveOnAgentCount,
    ).toBe(2);

    // Both directions: a count that only ever went down would pass the first
    // half with a hard-coded subtraction.
    await exclude(false);
    expect(
      (await listSkills(false, null, mswFetch)).find((s) => s.id === "skl_review")
        ?.liveOnAgentCount,
    ).toBe(3);
  });
});

/**
 * Library create and edit. The mock re-implements `normalizeSkillName` and the
 * body validation (the real ones live in a repository that pulls in drizzle),
 * so this pins the shapes the client depends on: 201 with a normalised name, a
 * partial PATCH that leaves untouched fields alone, and the two refusals.
 */
describe("mock library CRUD", () => {
  beforeEach(() => seedStore("default"));

  it("creates into the library with a normalised name, and no count on the write", async () => {
    const created = await createSkill(
      { name: "Release Notes", description: "d", body: "b" },
      null,
      mswFetch,
    );

    expect(created.name).toBe("release-notes");
    expect(created.enabled).toBe(true);
    expect(created.archivedAt).toBeNull();
    // The server's create returns the plain `serialize` — the count arrives on
    // the next listing, which is why the section re-reads.
    expect(created).not.toHaveProperty("liveOnAgentCount");

    const listed = await listSkills(false, null, mswFetch);
    expect(listed.find((s) => s.id === created.id)).toMatchObject({ liveOnAgentCount: 3 });
  });

  it("edits in place and leaves omitted fields alone", async () => {
    const updated = await updateSkill("skl_notes", { body: "# rewritten" }, null, mswFetch);

    expect(updated).toMatchObject({
      id: "skl_notes",
      name: "release_notes",
      description: "Turn a merged milestone into notes someone outside the team can read.",
      body: "# rewritten",
    });
    // The SAME row: one copy, one edit.
    expect(getStore().skills.find((s) => s.id === "skl_notes")?.body).toBe("# rewritten");
  });

  it("refuses a duplicate name and an unusable one, with the server's own sentences", async () => {
    await expect(
      createSkill({ name: "release_notes", description: "d", body: "b" }, null, mswFetch),
    ).rejects.toThrow("A skill with this name is already active");

    await expect(
      createSkill({ name: "deploy!", description: "d", body: "b" }, null, mswFetch),
    ).rejects.toThrow(/lowercase letters, numbers, dashes and underscores/);

    // A rename onto a taken name is the same 409, from the other route.
    await expect(
      updateSkill("skl_notes", { name: "code_review" }, null, mswFetch),
    ).rejects.toThrow("A skill with this name is already active");
    // ...and renaming to what it already is is not a collision with itself.
    await expect(
      updateSkill("skl_notes", { name: "release_notes" }, null, mswFetch),
    ).resolves.toMatchObject({ name: "release_notes" });
  });

  it("scopes a create by ?agentId=, exactly as every other write on this route does", async () => {
    const created = await createSkill(
      { name: "benchmark_suite", description: "d", body: "b" },
      "wb_docs",
      mswFetch,
    );

    expect(getStore().skills.some((s) => s.id === created.id)).toBe(false);
    expect(getStore().agentSkills.wb_docs?.some((s) => s.id === created.id)).toBe(true);
    // Private, so it is live on nobody but its own agent — and the library
    // listing never mentions it.
    expect((await listSkills(false, null, mswFetch)).some((s) => s.id === created.id)).toBe(false);
  });
});
