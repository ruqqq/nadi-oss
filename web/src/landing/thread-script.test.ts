import { describe, expect, it } from "vitest";
import { answerMessage, askMessage, HERO_MODELS, HERO_MOVES } from "./thread-script";

// The hero makes two claims, and both live in this data rather than in the copy,
// so both are worth a test.
describe("landing hero transcript", () => {
  const toolPartsOf = (moveId: string, modelId: string) => {
    const move = HERO_MOVES.find((m) => m.id === moveId);
    const model = HERO_MODELS.find((m) => m.model === modelId);
    if (!move || !model) throw new Error(`no ${moveId}/${modelId}`);
    return answerMessage(move, model).parts.filter((p) => p.type.startsWith("tool-"));
  };

  // Claim one: "the agent isn't the model" — same tools, whoever answers.
  it.each(HERO_MOVES.map((m) => m.id))("%s runs an identical tool strip for every model", (id) => {
    const [first, ...rest] = HERO_MODELS;
    expect(first).toBeDefined();
    if (!first) return;
    const baseline = toolPartsOf(id, first.model);
    expect(baseline.length).toBeGreaterThan(0);
    for (const model of rest) {
      expect(toolPartsOf(id, model.model)).toEqual(baseline);
    }
  });

  it.each(HERO_MOVES.map((m) => m.id))("%s answers as every model", (id) => {
    const move = HERO_MOVES.find((m) => m.id === id);
    if (!move) throw new Error("missing move");
    for (const model of HERO_MODELS) {
      expect(move.answers[model.model], `${id} has no ${model.model}`).toBeTruthy();
    }
    // Distinct voices — otherwise the swap looks broken.
    expect(new Set(Object.values(move.answers)).size).toBe(HERO_MODELS.length);
  });

  // Claim two, the page's thesis: this is ONE thread that crosses what would
  // elsewhere be separate products. Each of these guards a different half of it.
  it("leads with the move a non-engineer can see themselves in", () => {
    expect(HERO_MOVES[0]?.id).toBe("data");
  });

  it("crosses from data work into code running on a real machine", () => {
    const kinds = HERO_MOVES.flatMap((m) =>
      m.tools.map((t) => (t as { type?: string }).type ?? ""),
    );
    expect(kinds).toContain("tool-spawn_subagent"); // agents in parallel
    expect(kinds).toContain("tool-exec_watch"); // a long process, watched
    expect(kinds).toContain("tool-create_automaton"); // work that runs without you
  });

  it("continues in the same thread after the first move", () => {
    // A follow-up with no "since" would read as a fresh conversation, and the
    // seams in this thread are made of time — that is the argument.
    for (const move of HERO_MOVES.slice(1)) {
      expect(move.since, `${move.id} has no time marker`).toBeTruthy();
    }
  });

  it("ends on a move the thread takes without being asked", () => {
    const last = HERO_MOVES.at(-1);
    expect(last?.ask).toBeNull();
    expect(last && askMessage(last)).toBeNull();
    // Exactly one: two unprompted turns would read as a feed, not a conversation.
    expect(HERO_MOVES.filter((m) => m.ask === null)).toHaveLength(1);
  });

  it("names only providers the app actually supports", async () => {
    const { SETTINGS_PROVIDER_OPTIONS } = await import("../settings-ui-config");
    const supported = new Set(SETTINGS_PROVIDER_OPTIONS.map((p) => p.label));
    for (const model of HERO_MODELS) {
      expect(supported).toContain(model.provider);
    }
  });
});
