// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSkills, LibrarySkillForAgent, Skill } from "../skills-api";

// The section talks to the Worker through `skills-api`; mock that module so what
// is asserted is the component's own contract — which SCOPE each write names.
const api = vi.hoisted(() => ({
  listAgentSkills: vi.fn(),
  listSkills: vi.fn(),
  setLibrarySkillExcluded: vi.fn(),
  setSkillEnabled: vi.fn(),
  archiveSkill: vi.fn(),
  restoreSkill: vi.fn(),
  moveSkillToLibrary: vi.fn(),
  copySkillToAgent: vi.fn(),
}));

// Sonner drops a toast fired with no <Toaster/> mounted, so spy on it rather
// than rendering the whole app shell to read a failure message back.
const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

vi.mock("../skills-api", async () => {
  const actual = await vi.importActual<typeof import("../skills-api")>("../skills-api");
  return { ...actual, ...api };
});

import { AgentSkillsSection } from "./AgentSkillsSection";

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

function makeLibrary(
  over: Partial<LibrarySkillForAgent> & { id: string; name: string },
): LibrarySkillForAgent {
  return { excluded: false, shadowedByOwnSkillId: null, ...makeSkill(over), ...over };
}

const OWN_DEPLOY = makeSkill({ id: "own_deploy", name: "deploy" });
const OWN_NOTES = makeSkill({ id: "own_notes", name: "release_notes" });

const AGENT_SKILLS: AgentSkills = {
  library: [
    makeLibrary({ id: "skl_review", name: "code_review" }),
    makeLibrary({ id: "skl_deploy", name: "deploy", shadowedByOwnSkillId: "own_deploy" }),
    makeLibrary({ id: "skl_draft", name: "drafting", excluded: true }),
    makeLibrary({ id: "skl_legacy", name: "legacy_deploy", enabled: false }),
  ],
  own: [OWN_DEPLOY, OWN_NOTES],
};

// Radix's AlertDialog (behind the archive button) needs these.
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false) as never;
  Element.prototype.setPointerCapture = vi.fn() as never;
  Element.prototype.releasePointerCapture = vi.fn() as never;
  Element.prototype.scrollIntoView = vi.fn() as never;
});

beforeEach(() => {
  vi.clearAllMocks();
  api.listAgentSkills.mockResolvedValue(AGENT_SKILLS);
  api.listSkills.mockResolvedValue([]);
  api.setLibrarySkillExcluded.mockResolvedValue(undefined);
  api.setSkillEnabled.mockImplementation(async (id: string) => makeSkill({ id, name: "x" }));
  api.archiveSkill.mockImplementation(async (id: string) => makeSkill({ id, name: "x" }));
  api.restoreSkill.mockImplementation(async (id: string) => makeSkill({ id, name: "x" }));
  api.moveSkillToLibrary.mockImplementation(async (id: string) => makeSkill({ id, name: "x" }));
  api.copySkillToAgent.mockImplementation(async (id: string) => makeSkill({ id, name: "x" }));
});

afterEach(cleanup);

function ownGroup() {
  return screen.getByRole("region", { name: "This agent’s skills" });
}
function libraryGroup() {
  return screen.getByRole("region", { name: "From the workspace library" });
}
/**
 * Is the status dot lit on this row?
 *
 * The dot is the one element encoding `listEffective`'s rule — whether the model
 * actually loads this skill in this scope — and it is `aria-hidden` with no
 * text, so it is reached by the class that draws it. Throwing when the dot is
 * missing keeps this from reading "not lit" for a row that has no dot at all.
 */
function dotIsLit(scope: HTMLElement, name: string): boolean {
  const row = within(scope).getByText(name).closest("li");
  if (!row) throw new Error(`no row for ${name}`);
  const dot = row.querySelector("span.size-2.shrink-0.rounded-full");
  if (!dot) throw new Error(`no status dot on the ${name} row`);
  return dot.classList.contains("bg-approve");
}

/** Open one row's body, where its secondary actions live. */
async function expand(scope: HTMLElement, name: RegExp) {
  await userEvent.click(within(scope).getByRole("button", { name }));
}

async function renderSection(agentId = "wb_one", otherAgentCount = 3) {
  const view = render(
    <AgentSkillsSection agentId={agentId} otherAgentCount={otherAgentCount} />,
  );
  await screen.findByText("code_review");
  return view;
}

describe("AgentSkillsSection", () => {
  it("shows the agent's own skills and the workspace library as separate groups", async () => {
    await renderSection();

    expect(within(ownGroup()).getByText("release_notes")).toBeInTheDocument();
    expect(within(ownGroup()).queryByText("code_review")).not.toBeInTheDocument();

    expect(within(libraryGroup()).getByText("code_review")).toBeInTheDocument();
    expect(within(libraryGroup()).getByText("legacy_deploy")).toBeInTheDocument();
  });

  it("turning off a library skill excludes it for this agent", async () => {
    // The re-read after the write is what the row ends up showing, so let the
    // fake server actually record the exclusion.
    api.listAgentSkills.mockResolvedValueOnce(AGENT_SKILLS).mockResolvedValue({
      ...AGENT_SKILLS,
      library: AGENT_SKILLS.library.map((s) =>
        s.id === "skl_review" ? { ...s, excluded: true } : s,
      ),
    });
    await renderSection("wb_one");

    const toggle = screen.getByRole("switch", { name: "Exclude code_review from this agent" });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);

    expect(api.setLibrarySkillExcluded).toHaveBeenCalledWith("wb_one", "skl_review", true);
    // The label states the action it now performs, not the state it is in.
    await screen.findByRole("switch", { name: "Use code_review on this agent" });
  });

  it("puts an excluded library skill back when the write fails, and says why", async () => {
    api.setLibrarySkillExcluded.mockRejectedValue(new Error("The workspace is unreachable"));
    await renderSection("wb_one");

    await userEvent.click(
      screen.getByRole("switch", { name: "Exclude code_review from this agent" }),
    );

    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("The workspace is unreachable"),
    );
    expect(
      screen.getByRole("switch", { name: "Exclude code_review from this agent" }),
    ).toBeChecked();
  });

  it("turning an excluded library skill back on includes it again", async () => {
    await renderSection("wb_one");

    await userEvent.click(screen.getByRole("switch", { name: "Use drafting on this agent" }));

    expect(api.setLibrarySkillExcluded).toHaveBeenCalledWith("wb_one", "skl_draft", false);
  });

  it("shows a shadowed library skill as inert, naming the agent skill that wins", async () => {
    await renderSection();

    expect(screen.getByText(/Shadowed by this agent’s own deploy/)).toBeInTheDocument();
    // Anchored: `legacy_deploy` also ends in "deploy" and DOES carry a switch.
    expect(
      screen.queryByRole("switch", { name: /^(Exclude|Use) deploy / }),
    ).not.toBeInTheDocument();
  });

  /**
   * A disabled LIBRARY skill still carries an "included here" switch, which on
   * its own reads as live. The row has to say otherwise, or the UI states a
   * reach `listEffective` does not honour.
   */
  it("says a switched-off library skill reaches nobody", async () => {
    await renderSection();

    expect(
      screen.getByText("Switched off in the library, so no agent loads it"),
    ).toBeInTheDocument();
  });

  /**
   * The dot is the most glanceable thing on the page and the only element that
   * states `listEffective`'s verdict. Lighting it on a row the model does not
   * load would be the UI contradicting the runtime, so every way a library row
   * can fail to reach the model is asserted here.
   */
  it("lights the status dot only where the model actually loads the skill", async () => {
    await renderSection();

    const library = libraryGroup();
    expect(dotIsLit(library, "code_review")).toBe(true); // live
    expect(dotIsLit(library, "deploy")).toBe(false); // shadowed by the agent's own
    expect(dotIsLit(library, "drafting")).toBe(false); // excluded on this agent
    expect(dotIsLit(library, "legacy_deploy")).toBe(false); // switched off in the library

    expect(dotIsLit(ownGroup(), "release_notes")).toBe(true);
  });

  it("dims the dot on a switched-off own skill, and on every archived row", async () => {
    api.listAgentSkills.mockResolvedValue({
      ...AGENT_SKILLS,
      own: [OWN_NOTES, makeSkill({ id: "own_off", name: "paused", enabled: false })],
    });
    // Archived rows come back `enabled`, because archiving writes archivedAt
    // only — the tab, not the flag, is what says nobody loads them.
    api.listSkills.mockResolvedValue([
      makeSkill({ id: "own_old", name: "old_thing", archivedAt: 1 }),
    ]);
    await renderSection();

    expect(dotIsLit(ownGroup(), "release_notes")).toBe(true);
    expect(dotIsLit(ownGroup(), "paused")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Archived" }));
    await screen.findByText("old_thing");
    expect(dotIsLit(ownGroup(), "old_thing")).toBe(false);
  });

  /**
   * A write that SUCCEEDED and a re-read that failed are not the same event. If
   * the failed GET rolls the switch back, the page tells the reader a skill is
   * included that the server has already excluded — the UI stating the opposite
   * of the truth, which is the failure this whole surface exists to prevent.
   */
  it("keeps a successful exclusion when only the re-read fails", async () => {
    api.listAgentSkills
      .mockResolvedValueOnce(AGENT_SKILLS)
      .mockRejectedValue(new Error("The workspace is unreachable"));
    await renderSection("wb_one");

    await userEvent.click(
      screen.getByRole("switch", { name: "Exclude code_review from this agent" }),
    );

    expect(api.setLibrarySkillExcluded).toHaveBeenCalledWith("wb_one", "skl_review", true);
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("Saved, but couldn’t reload this agent’s skills."),
    );
    // Not rolled back, and not reported as a failed write.
    expect(
      screen.getByRole("switch", { name: "Use code_review on this agent" }),
    ).toBeInTheDocument();
    expect(toasts.error).not.toHaveBeenCalledWith("Couldn’t update the skill.");
    expect(toasts.error).not.toHaveBeenCalledWith("The workspace is unreachable");
  });

  it("archiving from an agent page archives the AGENT's skill, not the library's", async () => {
    // The stale-closure regression. The section is re-pointed at a second agent
    // WITHOUT unmounting — what a settings pane does when the reader switches
    // agents — so a callback that captured the first agent id writes to the
    // wrong scope: archiving a library skill from an agent's page.
    api.listAgentSkills.mockImplementation(async (agentId: string) =>
      agentId === "wb_one"
        ? { library: AGENT_SKILLS.library, own: [OWN_NOTES] }
        : { library: AGENT_SKILLS.library, own: [makeSkill({ id: "own_two", name: "two_only" })] },
    );

    const { rerender } = await renderSection("wb_one");
    rerender(<AgentSkillsSection agentId="wb_two" otherAgentCount={3} />);
    await screen.findByText("two_only");

    await userEvent.click(screen.getByRole("button", { name: "Archive skill two_only" }));
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => expect(api.archiveSkill).toHaveBeenCalled());
    expect(api.archiveSkill).toHaveBeenCalledWith("own_two", "wb_two");
  });

  it("re-reads both groups after a write, so archiving un-shadows the library row", async () => {
    api.listAgentSkills.mockResolvedValueOnce(AGENT_SKILLS).mockResolvedValue({
      library: AGENT_SKILLS.library.map((s) => ({ ...s, shadowedByOwnSkillId: null })),
      own: [OWN_NOTES],
    });

    await renderSection();
    expect(screen.getByText(/Shadowed by this agent’s own deploy/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Archive skill deploy" }));
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() =>
      expect(
        screen.queryByText(/Shadowed by this agent’s own deploy/),
      ).not.toBeInTheDocument(),
    );
    // ...and the library row is now one this agent can switch.
    expect(
      screen.getByRole("switch", { name: "Exclude deploy from this agent" }),
    ).toBeInTheDocument();
  });

  it("moves an own skill up to the library, naming the agent it lives on today", async () => {
    await renderSection("wb_one");

    // Secondary actions live with the body, so the row keeps one clear control.
    await expand(ownGroup(), /^release_notes/);
    await userEvent.click(
      screen.getByRole("button", { name: "Move release_notes to the workspace library" }),
    );
    // The move is confirmed, not fired: it hands the skill to every other agent
    // and there is no way back.
    expect(api.moveSkillToLibrary).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Move to library" }));

    expect(api.moveSkillToLibrary).toHaveBeenCalledWith("own_notes", "wb_one");
  });

  /**
   * The confirm has to say what the click DOES, not merely ask twice. Three
   * facts, each one a consequence the button's own label hides: the reach, the
   * egress the row carries with it, and that nothing moves a skill back out of
   * the library.
   */
  it("states the reach, the egress and the irreversibility before moving", async () => {
    await renderSection("wb_one", 3);

    await expand(ownGroup(), /^release_notes/);
    await userEvent.click(
      screen.getByRole("button", { name: "Move release_notes to the workspace library" }),
    );

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/All 3 other agents in this workspace will load it/))
      .toBeInTheDocument();
    expect(within(dialog).getByText(/already has its own skill called .release_notes./))
      .toBeInTheDocument();
    expect(within(dialog).getByText(/sandbox hosts it opens open for those agents too/))
      .toBeInTheDocument();
    expect(within(dialog).getByText(/no move back/)).toBeInTheDocument();

    // Cancelling leaves the skill where it was.
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(api.moveSkillToLibrary).not.toHaveBeenCalled();
  });

  it("counts one other agent in the singular, and says what an empty workspace gains", async () => {
    const { unmount } = await renderSection("wb_one", 1);
    await expand(ownGroup(), /^release_notes/);
    await userEvent.click(
      screen.getByRole("button", { name: "Move release_notes to the workspace library" }),
    );
    expect(
      within(await screen.findByRole("alertdialog")).getByText(/The 1 other agent/),
    ).toBeInTheDocument();
    unmount();

    await renderSection("wb_one", 0);
    await expand(ownGroup(), /^release_notes/);
    await userEvent.click(
      screen.getByRole("button", { name: "Move release_notes to the workspace library" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/no other agents yet/)).toBeInTheDocument();
    // Never "0 other agents will load it" - the library is what every agent
    // added LATER inherits, so a zero here would read as "this does nothing".
    expect(within(dialog).queryByText(/0 other agents/)).not.toBeInTheDocument();
  });

  it("copies a library skill onto this agent, and offers no copy where one already shadows", async () => {
    await renderSection("wb_one");

    await expand(libraryGroup(), /^code_review/);
    await userEvent.click(screen.getByRole("button", { name: "Copy code_review to this agent" }));

    expect(api.copySkillToAgent).toHaveBeenCalledWith("skl_review", "wb_one");

    await expand(libraryGroup(), /^deploy/);
    expect(
      screen.queryByRole("button", { name: "Copy deploy to this agent" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the server's message when a copy collides with an existing name", async () => {
    api.copySkillToAgent.mockRejectedValue(
      new Error("That agent already has a skill with this name"),
    );
    await renderSection("wb_one");

    await expand(libraryGroup(), /^code_review/);
    await userEvent.click(screen.getByRole("button", { name: "Copy code_review to this agent" }));

    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("That agent already has a skill with this name"),
    );
  });

  it("lists this agent's archived skills, and restores one in the agent's scope", async () => {
    api.listSkills.mockResolvedValue([makeSkill({ id: "own_old", name: "old_thing" })]);
    await renderSection("wb_one");

    await userEvent.click(screen.getByRole("button", { name: "Archived" }));
    await screen.findByText("old_thing");
    expect(api.listSkills).toHaveBeenCalledWith(true, "wb_one");

    await userEvent.click(screen.getByRole("button", { name: "Restore old_thing" }));
    expect(api.restoreSkill).toHaveBeenCalledWith("own_old", "wb_one");
  });

  it("explains a failed load and offers a retry", async () => {
    api.listAgentSkills.mockRejectedValueOnce(new Error("The workspace is unreachable"));
    render(<AgentSkillsSection agentId="wb_one" otherAgentCount={3} />);

    await screen.findByRole("alert");
    expect(screen.getByText(/The workspace is unreachable/)).toBeInTheDocument();

    api.listAgentSkills.mockResolvedValue(AGENT_SKILLS);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("code_review");
  });
});
