import { useCallback, useEffect, useState } from "react";
import { useMotionValueEvent, useScroll } from "motion/react";
import { MessageRow } from "@/components/chat/MessageRow";
import { ThreadModelBadge } from "@/components/model/ThreadModelBadge";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/lib/use-media-query";
import { answerMessage, askMessage, FEATURED_PROVIDER, HERO_MODELS, HERO_MOVES } from "./thread-script";

// A cascade, not a drip. The card stands at full height from the first paint, so
// a slow reveal would just leave a tall empty box on screen; the moves land in
// under a second and the thread is there to read.
const REVEAL_MS = 260;

/**
 * The page's argument, dramatized rather than asserted: one thread that starts
 * as data work, becomes code on a real machine, becomes work on a schedule, and
 * finally speaks without being asked. No tabs — a tab bar here would rebuild the
 * very seams the page says Nadi doesn't have.
 *
 * The moves are divided by *time*, never by capability: the dividers borrow the
 * one device every messaging app already has for "time passed, same
 * conversation", which is exactly the claim. The last one carries the accent
 * because nobody asked for that move — the thread came back on its own.
 *
 * The model swap is the second, quieter claim: pick another model and only the
 * closing paragraphs change — the tools underneath stay exactly where they are.
 *
 * Every move is in the DOM from the first paint and the reveal is opacity only,
 * so the card stands at its full height before anything animates. Growing it
 * move by move would shove the rest of the page down four times while someone is
 * trying to read it. The empty room below the first move is the point: it is a
 * conversation with space left in it.
 */
export function HeroThread() {
  const [index, setIndex] = useState(0);
  const [taken, setTaken] = useState(false);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const { scrollY } = useScroll();
  const [revealed, setRevealed] = useState(reducedMotion ? HERO_MOVES.length : 1);
  const done = revealed >= HERO_MOVES.length;

  // The moves land one after another, so the thread reads as something that
  // happened rather than a screenshot. It runs once and stops: an endlessly
  // replaying hero is a distraction, not an argument.
  useEffect(() => {
    if (reducedMotion) {
      setRevealed(HERO_MOVES.length);
      return;
    }
    if (done) return;
    const timer = window.setTimeout(() => setRevealed((n) => n + 1), REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [reducedMotion, done]);

  // Scrolling means they are reading ahead of the stagger, and a row fading in
  // behind their eye line is just noise. Once they move, show the whole thread.
  // Driven off Motion's scroll value rather than a `scroll` listener of our own:
  // Motion already tracks it once for the page and batches the reads.
  useMotionValueEvent(scrollY, "change", (y) => {
    if (!done && y > 0) setRevealed(HERO_MOVES.length);
  });

  const pick = useCallback((next: number) => {
    setTaken(true);
    setIndex(next);
    // Picking a model is a request to read the answers — don't make them wait.
    setRevealed(HERO_MOVES.length);
  }, []);

  const model = HERO_MODELS[index] ?? HERO_MODELS[0];
  if (!model) return null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex items-center justify-between gap-2 border-border border-b px-4 py-2.5">
          <span className="truncate font-mono text-muted-foreground text-xs">Q3 numbers</span>
          {/* The real thread badge, driven by the real model ids. */}
          <ThreadModelBadge model={model.model} />
        </div>

        <div className="flex min-w-0 flex-col px-4 py-4">
          {HERO_MOVES.map((move, i) => {
            const ask = askMessage(move);
            // The move nobody asked for is the one the page is about, so its
            // divider is the only one that carries the accent.
            const unprompted = move.ask === null;
            const shown = i < revealed;
            return (
              <div
                key={move.id}
                // Hidden moves keep their space — that is what holds the card
                // still. Only their opacity moves.
                aria-hidden={!shown}
                className={cn(
                  "flex min-w-0 flex-col gap-1 motion-safe:transition-opacity motion-safe:duration-700",
                  shown ? "opacity-100" : "opacity-0",
                )}
              >
                {move.since && (
                  // The divider every messaging app already uses to say "time
                  // passed, same conversation" — which is the whole argument.
                  <div className="flex items-center gap-3 py-5" aria-hidden={false}>
                    <span className="h-px flex-1 bg-border" aria-hidden />
                    <span
                      className={cn(
                        "flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest",
                        unprompted ? "text-primary" : "text-muted-foreground",
                      )}
                    >
                      {unprompted && (
                        <span aria-hidden className="size-1.5 rounded-full bg-primary" />
                      )}
                      {move.since}
                    </span>
                    <span className="h-px flex-1 bg-border" aria-hidden />
                  </div>
                )}

                {ask ? (
                  <MessageRow
                    message={ask}
                    servers={[]}
                    addToolApprovalResponse={() => undefined}
                    busy={false}
                    readOnly
                  />
                ) : null}

                {/* Keyed on the model so the answer re-mounts (and re-animates)
                    while the tool strip above it stays put — the swap you can see. */}
                <MessageRow
                  key={`${move.id}-${model.model}`}
                  message={answerMessage(move, model)}
                  servers={[]}
                  addToolApprovalResponse={() => undefined}
                  busy={false}
                  readOnly
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div
          // On a phone the chips are one horizontal run that bleeds to both
          // screen edges, so it reads as scrollable rather than as a row that
          // happens to be cut off. From sm up there is room to wrap.
          className={cn(
            "-mx-6 flex gap-1.5 overflow-x-auto px-6 pb-1",
            "sm:mx-0 sm:flex-wrap sm:overflow-x-visible sm:px-0 sm:pb-0",
          )}
          role="group"
          aria-label="Answer with a different model"
        >
          {HERO_MODELS.map((m, i) => {
            const active = i === index;
            const featured = m.provider === FEATURED_PROVIDER;
            return (
              <button
                key={m.model}
                type="button"
                onClick={() => pick(i)}
                aria-pressed={active}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-xs transition-colors",
                  "focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground",
                  !active && featured && "border-primary/40 text-foreground",
                )}
              >
                {featured && (
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 rounded-full",
                      active ? "bg-primary-foreground" : "bg-primary",
                    )}
                  />
                )}
                {m.provider}
              </button>
            );
          })}
        </div>
        <p className="text-muted-foreground text-xs">
          {taken ? (
            <>
              Same thread, same tools, same agents. Billed to{" "}
              <span className="text-foreground">{model.note}</span>.
            </>
          ) : (
            "One thread, start to finish. Pick a model. The answers change, the work underneath doesn’t."
          )}
        </p>
      </div>
    </div>
  );
}
