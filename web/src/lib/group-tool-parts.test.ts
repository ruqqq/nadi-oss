import { describe, expect, it } from "vitest";
import { buildToolTimeline } from "./group-tool-parts";

// Minimal stand-ins for message parts. The real predicates come from the AI SDK
// / @cloudflare/ai-chat in MessageRow; here we inject simple ones so the grouping
// logic stays pure and free of React/runtime deps.
type P = { type: string; approval?: boolean; text?: string };
const text = (t = "hi"): P => ({ type: "text", text: t });
const emptyText = (): P => ({ type: "text", text: "" });
const toolCall = (): P => ({ type: "tool" });
const pending = (): P => ({ type: "tool", approval: true });
const stepStart = (): P => ({ type: "step-start" });

// Mirrors the predicate MessageRow injects: step-start boundaries AND the empty
// text parts the think runtime emits between tool steps are both transparent.
const opts = {
  isTool: (p: P) => p.type === "tool",
  isWaitingApproval: (p: P) => p.approval === true,
  isTransparent: (p: P) =>
    p.type === "step-start" || (p.type === "text" && (p.text ?? "").trim() === ""),
};

const kinds = (parts: P[]) => buildToolTimeline(parts, opts).map((n) => n.kind);

describe("buildToolTimeline", () => {
  it("returns nothing for no parts", () => {
    expect(buildToolTimeline([], opts)).toEqual([]);
  });

  it("renders a lone tool call as a single tool, not a group", () => {
    const nodes = buildToolTimeline([toolCall()], opts);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.kind).toBe("tool");
  });

  it("collapses two or more consecutive tool calls into one group", () => {
    const nodes = buildToolTimeline([toolCall(), toolCall(), toolCall()], opts);
    expect(nodes).toHaveLength(1);
    const first = nodes[0];
    expect(first?.kind).toBe("group");
    if (first?.kind === "group") expect(first.items).toHaveLength(3);
  });

  it("breaks a run when assistant text interrupts it", () => {
    expect(kinds([toolCall(), text(), toolCall()])).toEqual(["tool", "part", "tool"]);
  });

  it("never groups a pending-approval tool — it renders inline and breaks the run", () => {
    expect(kinds([toolCall(), toolCall(), pending(), toolCall(), toolCall()])).toEqual([
      "group",
      "approval",
      "group",
    ]);
  });

  it("treats step-start boundaries as transparent so tools across steps still group", () => {
    // The AI SDK pushes a {type:'step-start'} part at the start of each step, so
    // a multi-tool turn is [step-start, tool, step-start, tool, ...]. These must
    // not break the run, or every tool renders alone and nothing groups.
    const nodes = buildToolTimeline(
      [stepStart(), toolCall(), stepStart(), toolCall(), stepStart(), toolCall()],
      opts,
    );
    expect(nodes).toHaveLength(1);
    const first = nodes[0];
    expect(first?.kind).toBe("group");
    if (first?.kind === "group") expect(first.items).toHaveLength(3);
  });

  it("does not emit a node for transparent parts", () => {
    expect(buildToolTimeline([stepStart()], opts)).toEqual([]);
  });

  it("treats empty text between tools as transparent so a think-runtime turn groups", () => {
    // The think runtime emits an empty {type:'text', text:''} part after nearly
    // every tool step, producing [tool, tool, '', tool, '', tool, ...]. Without
    // treating empty text as transparent this fragmented into one group-of-2 plus
    // lone cards; the whole run must collapse into a single group.
    const nodes = buildToolTimeline(
      [
        stepStart(),
        toolCall(),
        stepStart(),
        toolCall(),
        emptyText(),
        stepStart(),
        toolCall(),
        emptyText(),
        stepStart(),
        toolCall(),
      ],
      opts,
    );
    expect(nodes).toHaveLength(1);
    const first = nodes[0];
    expect(first?.kind).toBe("group");
    if (first?.kind === "group") expect(first.items).toHaveLength(4);
  });

  it("still breaks a run on real (non-empty) narration between tools", () => {
    expect(kinds([toolCall(), toolCall(), text("Got it"), toolCall()])).toEqual([
      "group",
      "part",
      "tool",
    ]);
  });

  it("keeps a stable key from the original part index", () => {
    // text, then a group starting at index 1
    const nodes = buildToolTimeline([text(), toolCall(), toolCall()], opts);
    expect(nodes[0]?.key).toBe("0");
    expect(nodes[1]?.key).toBe("1");
  });
});

describe("buildToolTimeline isStandalone", () => {
  // Minimal string-part model: "T" = tool, "S" = standalone tool, "x" = text.
  const opts = {
    isTool: (p: string) => p === "T" || p === "S",
    isWaitingApproval: () => false,
    isStandalone: (p: string) => p === "S",
  };

  it("splits a standalone tool out of an otherwise-grouped run", () => {
    const nodes = buildToolTimeline(["T", "T", "S", "T", "T"], opts);
    expect(nodes.map((n) => n.kind)).toEqual(["group", "tool", "group"]);
    // The standalone node carries its own part, keyed by its index.
    const standalone = nodes[1];
    expect(standalone).toMatchObject({ kind: "tool", key: "2", part: "S" });
  });

  it("still renders a lone standalone tool as its own tool node", () => {
    const nodes = buildToolTimeline(["S"], opts);
    expect(nodes.map((n) => n.kind)).toEqual(["tool"]);
  });
});
