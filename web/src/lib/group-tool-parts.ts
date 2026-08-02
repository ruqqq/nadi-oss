/**
 * Coalesce a message's ordered parts into a render timeline that groups
 * consecutive tool calls. An uninterrupted run of 2+ tool calls becomes one
 * `group`; a lone tool stays a `tool`; any non-tool part (text, reasoning)
 * ends the run; a tool still awaiting approval is never grouped — it surfaces
 * inline as `approval` and breaks the run, so pending actions stay visible.
 *
 * Pure and predicate-injected: MessageRow passes the real AI SDK /
 * @cloudflare/ai-chat classifiers, keeping this free of runtime deps.
 */

export interface TimelineOpts<P> {
  isTool: (part: P) => boolean;
  isWaitingApproval: (part: P) => boolean;
  /**
   * Parts that carry no visible content and must not break a tool run — chiefly
   * the AI SDK's `step-start` boundary, which the SDK inserts between steps.
   * They are dropped from the timeline entirely. Optional; defaults to none.
   */
  isTransparent?: (part: P) => boolean;
  /**
   * Tool parts that must never merge into a group — they always emerge as their
   * own `tool` node so a dedicated card can attach (e.g. `spawn_subagent`).
   * Breaks any in-progress run. Optional; defaults to none.
   */
  isStandalone?: (part: P) => boolean;
}

interface KeyedPart<P> {
  key: string;
  part: P;
}

export type TimelineNode<P> =
  | { kind: "part"; key: string; part: P }
  | { kind: "approval"; key: string; part: P }
  | { kind: "tool"; key: string; part: P }
  | { kind: "group"; key: string; items: KeyedPart<P>[] };

export function buildToolTimeline<P>(parts: P[], opts: TimelineOpts<P>): TimelineNode<P>[] {
  const out: TimelineNode<P>[] = [];
  let run: KeyedPart<P>[] = [];

  const flushRun = () => {
    const first = run[0];
    if (!first) return;
    if (run.length === 1) {
      out.push({ kind: "tool", key: first.key, part: first.part });
    } else {
      out.push({ kind: "group", key: first.key, items: run });
    }
    run = [];
  };

  parts.forEach((part, i) => {
    const key = String(i);
    if (opts.isTransparent?.(part)) {
      // Invisible boundary (e.g. step-start): skip without breaking the run.
      return;
    }
    if (opts.isTool(part)) {
      if (opts.isWaitingApproval(part)) {
        flushRun();
        out.push({ kind: "approval", key, part });
      } else if (opts.isStandalone?.(part)) {
        flushRun();
        out.push({ kind: "tool", key, part });
      } else {
        run.push({ key, part });
      }
    } else {
      flushRun();
      out.push({ kind: "part", key, part });
    }
  });
  flushRun();

  return out;
}
