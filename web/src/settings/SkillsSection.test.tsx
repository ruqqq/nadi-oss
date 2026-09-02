// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "../skills-api";

const api = vi.hoisted(() => ({
  listSkills: vi.fn(),
  setSkillEnabled: vi.fn(),
  archiveSkill: vi.fn(),
  restoreSkill: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
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

// Radix's Dialog needs these in jsdom.
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false) as never;
  Element.prototype.setPointerCapture = vi.fn() as never;
  Element.prototype.releasePointerCapture = vi.fn() as never;
  Element.prototype.scrollIntoView = vi.fn() as never;
});

beforeEach(() => {
  vi.clearAllMocks();
  api.listSkills.mockResolvedValue([]);
  api.setSkillEnabled.mockImplementation(async (id: string) => makeSkill({ id, name: "x" }));
  api.createSkill.mockImplementation(async () => makeSkill({ id: "new", name: "new" }));
  api.updateSkill.mockImplementation(async (id: string) => makeSkill({ id, name: "x" }));
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

  it("names the library tab as shared, and never sends the reader to chat for one", async () => {
    render(<SkillsSection />);

    const heading = await screen.findByRole("region", { name: "Skills" });
    expect(heading).toHaveTextContent(/every agent in this workspace loads these/i);
    // The old hint said skills are "created and edited by the agent in chat".
    // Following it produces an AGENT-PRIVATE skill that never appears here, so
    // the absence of that sentence is the fix — its replacement is only an
    // addition beside it without this.
    expect(heading).not.toHaveTextContent(/created and edited by the agent in chat/i);
    expect(screen.queryByText(/Ask the agent to create one in chat/)).not.toBeInTheDocument();
  });

  it("points an empty library at the control that fills it", async () => {
    render(<SkillsSection />);

    expect(await screen.findByText("No skills yet")).toBeInTheDocument();
    expect(screen.getByText(/Write one with New skill above/)).toBeInTheDocument();
    expect(screen.queryByText(/Ask the agent to create one in chat/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New skill/ })).toBeInTheDocument();
  });

  it("writes to the library, naming no agent scope", async () => {
    api.listSkills.mockResolvedValue([makeSkill({ id: "a", name: "alpha", liveOnAgentCount: 1 })]);
    render(<SkillsSection />);

    await userEvent.click(await screen.findByRole("switch", { name: "Disable alpha" }));

    expect(api.setSkillEnabled).toHaveBeenCalledWith("a", false);
    expect(api.listSkills).toHaveBeenCalledWith(false);
  });
});

/**
 * The library editor. Before it, a skill at `agent_id IS NULL` was editable by
 * NOTHING — the chat tools scope every write to the calling thread's agent, and
 * this route had no create and no edit — while `AgentSkillsSection` told the
 * reader to "edit it in Settings → Skills, where the edit reaches everyone".
 */
describe("SkillsSection editor", () => {
  async function openEditor(name: string) {
    await userEvent.click(await screen.findByRole("button", { name }));
    return screen.findByRole("dialog");
  }

  it("creates a library skill from the tab that manages the library", async () => {
    render(<SkillsSection />);

    const dialog = await openEditor("New skill");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Release Notes");
    await userEvent.type(within(dialog).getByLabelText("Description"), "Write the notes");
    await userEvent.type(within(dialog).getByLabelText("Body"), "# Notes");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(api.createSkill).toHaveBeenCalled());
    // No agent scope: this tab IS the library.
    expect(api.createSkill).toHaveBeenCalledWith({
      name: "Release Notes",
      description: "Write the notes",
      body: "# Notes",
    });
    // Re-read, so a rename lands in the server's name order and the reach count
    // the write does not return comes back.
    await waitFor(() => expect(api.listSkills).toHaveBeenCalledTimes(2));
  });

  it("edits the row's own skill, and pre-fills what is being changed", async () => {
    api.listSkills.mockResolvedValue([
      makeSkill({ id: "a", name: "alpha", liveOnAgentCount: 4 }),
      makeSkill({ id: "b", name: "bravo", liveOnAgentCount: 1 }),
    ]);
    render(<SkillsSection />);

    const dialog = await openEditor("Edit bravo");
    expect(within(dialog).getByLabelText("Name")).toHaveValue("bravo");
    expect(within(dialog).getByLabelText("Body")).toHaveValue("# bravo");

    await userEvent.clear(within(dialog).getByLabelText("Body"));
    await userEvent.type(within(dialog).getByLabelText("Body"), "# rewritten");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.updateSkill).toHaveBeenCalled());
    expect(api.updateSkill).toHaveBeenCalledWith("b", {
      name: "bravo",
      description: "bravo description",
      body: "# rewritten",
    });
  });

  /**
   * The blast radius, at the moment of editing rather than only on the row
   * behind the dialog — which is the entire justification for computing the
   * count (spec: "each skill states how many agents it is live on BEFORE you
   * edit it"). Both moods, because a disabled skill reaches nobody today.
   */
  it("states the reach inside the editor, in the mood the skill's own switch earns", async () => {
    api.listSkills.mockResolvedValue([
      makeSkill({ id: "a", name: "alpha", liveOnAgentCount: 4 }),
      makeSkill({ id: "b", name: "bravo", liveOnAgentCount: 1 }),
      makeSkill({ id: "c", name: "charlie", liveOnAgentCount: 0 }),
      makeSkill({ id: "d", name: "delta", enabled: false, liveOnAgentCount: 4 }),
      makeSkill({ id: "e", name: "echo" }),
    ]);
    render(<SkillsSection />);

    expect(
      within(await openEditor("Edit alpha")).getByText("This edit reaches all 4 agents that load it."),
    ).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    expect(within(await openEditor("Edit bravo")).getByText("This edit reaches 1 agent.")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    expect(
      within(await openEditor("Edit charlie")).getByText(/reaches nobody yet/),
    ).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    // Disabled: potential reach, never current — the same rule the row's own
    // reach line follows.
    const disabled = await openEditor("Edit delta");
    expect(within(disabled).getByText(/Switched off — 4 agents would load this edit/)).toBeInTheDocument();
    expect(within(disabled).queryByText(/^This edit reaches/)).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    // No count from the server: the rule, never an invented number.
    const unknown = await openEditor("Edit echo");
    expect(within(unknown).getByText(/One shared copy/)).toBeInTheDocument();
    expect(within(unknown).queryByText(/\d+ agent/)).not.toBeInTheDocument();
  });

  it("says a new library skill is shared before it exists, with no count to quote", async () => {
    render(<SkillsSection />);

    const dialog = await openEditor("New skill");
    expect(within(dialog).getByText(/Shared with every agent in this workspace/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/\d+ agent/)).not.toBeInTheDocument();
  });

  it("keeps the draft and shows the server's own message when the write is refused", async () => {
    api.createSkill.mockRejectedValue(new Error("A skill with this name is already active"));
    render(<SkillsSection />);

    const dialog = await openEditor("New skill");
    await userEvent.type(within(dialog).getByLabelText("Name"), "alpha");
    await userEvent.type(within(dialog).getByLabelText("Description"), "d");
    await userEvent.type(within(dialog).getByLabelText("Body"), "b");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "A skill with this name is already active",
    );
    // Still open, still holding what was typed: a rejected name is corrected,
    // not retyped.
    expect(within(dialog).getByLabelText("Name")).toHaveValue("alpha");
  });

  it("offers no editor on the archived tab, where nothing is editable", async () => {
    api.listSkills.mockImplementation(async (archived: boolean) =>
      archived
        ? [makeSkill({ id: "z", name: "zulu", archivedAt: 1 })]
        : [makeSkill({ id: "a", name: "alpha", liveOnAgentCount: 1 })],
    );
    render(<SkillsSection />);

    expect(await screen.findByRole("button", { name: "Edit alpha" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Archived" }));

    await screen.findByText("zulu");
    expect(screen.queryByRole("button", { name: "Edit zulu" })).not.toBeInTheDocument();
    // ...and no "New skill" either: a new skill is never archived, so the
    // button would create a row this tab cannot show.
    expect(screen.queryByRole("button", { name: /New skill/ })).not.toBeInTheDocument();
  });
});
