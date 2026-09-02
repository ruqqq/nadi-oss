// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "../skills-api";

const api = vi.hoisted(() => ({
  listSkills: vi.fn(),
  setSkillEnabled: vi.fn(),
  archiveSkill: vi.fn(),
  restoreSkill: vi.fn(),
}));

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

vi.mock("../skills-api", async () => {
  const actual = await vi.importActual<typeof import("../skills-api")>("../skills-api");
  return { ...actual, ...api };
});

import { SkillsSection } from "./SkillsSection";

function makeSkill(over: Partial<Skill> & { id: string; name: string }): Skill {
  return {
    description: `${over.name} description`,
    body: `# ${over.name}`,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listSkills.mockResolvedValue([]);
  api.setSkillEnabled.mockImplementation(async (id: string) => makeSkill({ id, name: "x" }));
});

afterEach(cleanup);

/**
 * Is the status dot lit on this row? The dot is `aria-hidden` and carries no
 * text, so it is reached by the class that draws it; a missing dot throws
 * rather than reading as "not lit".
 */
function dotIsLit(name: string): boolean {
  const row = screen.getByText(name).closest("li");
  if (!row) throw new Error(`no row for ${name}`);
  const dot = row.querySelector("span.size-2.shrink-0.rounded-full");
  if (!dot) throw new Error(`no status dot on the ${name} row`);
  return dot.classList.contains("bg-approve");
}

describe("SkillsSection status dot", () => {
  /**
   * The count keeps reporting carriers for a switched-off skill, but
   * `listEffective` filters on `enabled`, so it resolves for nobody. The dot has
   * to agree with the runtime, not with the number next to it.
   */
  it("lights the dot only for a library skill the agents actually load", async () => {
    api.listSkills.mockImplementation(async (archived: boolean) =>
      archived
        ? [makeSkill({ id: "z", name: "zulu", archivedAt: 1 })]
        : [
            makeSkill({ id: "a", name: "alpha", liveOnAgentCount: 4 }),
            makeSkill({ id: "b", name: "bravo", enabled: false, liveOnAgentCount: 4 }),
          ],
    );
    render(<SkillsSection />);

    await screen.findByText("alpha");
    expect(dotIsLit("alpha")).toBe(true);
    expect(dotIsLit("bravo")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Archived" }));
    await screen.findByText("zulu");
    // Archiving writes archivedAt only, so the row is still `enabled`; the tab
    // is what says nobody loads it.
    expect(dotIsLit("zulu")).toBe(false);
  });
});

describe("SkillsSection reach line", () => {
  it("counts the agents a live library skill reaches, singular and plural", async () => {
    api.listSkills.mockResolvedValue([
      makeSkill({ id: "a", name: "alpha", liveOnAgentCount: 4 }),
      makeSkill({ id: "b", name: "bravo", liveOnAgentCount: 1 }),
    ]);
    render(<SkillsSection />);

    expect(await screen.findByText("Live on 4 agents")).toBeInTheDocument();
    expect(screen.getByText("Live on 1 agent")).toBeInTheDocument();
  });

  it("says a skill every agent excluded is live on none, not on zero", async () => {
    api.listSkills.mockResolvedValue([makeSkill({ id: "a", name: "alpha", liveOnAgentCount: 0 })]);
    render(<SkillsSection />);

    expect(await screen.findByText("Not live on any agent")).toBeInTheDocument();
    expect(screen.queryByText(/Live on 0/)).not.toBeInTheDocument();
  });

  /**
   * The count deliberately keeps reporting carriers for a DISABLED skill — the
   * off state is reversible and a collapse to zero would hide the blast radius
   * exactly when someone is deciding whether to edit it. But `listEffective`
   * filters on `enabled`, so a disabled skill resolves for nobody: the line has
   * to read as POTENTIAL reach, never as current reach.
   */
  it("never states a disabled skill is live on anyone", async () => {
    api.listSkills.mockResolvedValue([
      makeSkill({ id: "a", name: "alpha", enabled: false, liveOnAgentCount: 4 }),
      makeSkill({ id: "b", name: "bravo", enabled: false, liveOnAgentCount: 1 }),
      makeSkill({ id: "c", name: "charlie", enabled: false, liveOnAgentCount: 0 }),
    ]);
    render(<SkillsSection />);

    expect(await screen.findByText("Switched off — 4 agents would load it")).toBeInTheDocument();
    expect(screen.getByText("Switched off — 1 agent would load it")).toBeInTheDocument();
    expect(screen.getByText("Switched off — no agent would load it")).toBeInTheDocument();
    expect(screen.queryByText(/^Live on/)).not.toBeInTheDocument();
  });

  it("renders no reach line when the server did not send a count", async () => {
    // An older Worker, and the archived tab, send no `liveOnAgentCount`. A
    // confident "Not live on any agent" there would be a fact we do not have.
    api.listSkills.mockResolvedValue([makeSkill({ id: "a", name: "alpha" })]);
    render(<SkillsSection />);

    await screen.findByText("alpha");
    expect(screen.queryByText(/live on/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Switched off/)).not.toBeInTheDocument();
  });

  it("keeps the reach line after toggling, so the number does not vanish mid-decision", async () => {
    api.listSkills.mockResolvedValue([
      makeSkill({ id: "a", name: "alpha", liveOnAgentCount: 3 }),
    ]);
    // The write route returns a plain Skill — no count. Dropping it would blank
    // the line on the very interaction the count exists to inform.
    api.setSkillEnabled.mockResolvedValue(makeSkill({ id: "a", name: "alpha", enabled: false }));
    render(<SkillsSection />);

    await userEvent.click(await screen.findByRole("switch", { name: "Disable alpha" }));

    expect(await screen.findByText("Switched off — 3 agents would load it")).toBeInTheDocument();
  });

  it("shows no reach line on the archived tab", async () => {
    api.listSkills.mockImplementation(async (archived: boolean) =>
      archived
        ? [makeSkill({ id: "z", name: "zulu", archivedAt: 1, liveOnAgentCount: 2 })]
        : [makeSkill({ id: "a", name: "alpha", liveOnAgentCount: 4 })],
    );
    render(<SkillsSection />);

    await screen.findByText("Live on 4 agents");
    await userEvent.click(screen.getByRole("button", { name: "Archived" }));

    await screen.findByText("zulu");
    expect(screen.queryByText(/Live on/)).not.toBeInTheDocument();
  });

  it("writes to the library, naming no agent scope", async () => {
    api.listSkills.mockResolvedValue([makeSkill({ id: "a", name: "alpha", liveOnAgentCount: 1 })]);
    render(<SkillsSection />);

    await userEvent.click(await screen.findByRole("switch", { name: "Disable alpha" }));

    expect(api.setSkillEnabled).toHaveBeenCalledWith("a", false);
    expect(api.listSkills).toHaveBeenCalledWith(false);
  });
});
