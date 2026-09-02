// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupServer } from "../../../web/node_modules/msw/node";
import { restHandlers } from "../../../web/src/mocks/rest";
import { listSkills } from "../../../web/src/skills-api";
import { resetStore, seedStore } from "../../../web/src/mocks/store";

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
