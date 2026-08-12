import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CaretDown, Robot, Stop, Terminal, X } from "@/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { SubagentRunView } from "@/lib/subagent-runs";
import { useVisualViewportInset } from "@/lib/use-visual-viewport-inset";
import { cn } from "@/lib/utils";
import type {
  BackgroundWorkCancelReason,
  BackgroundWorkOutcome,
  BackgroundWorkOutput,
  BackgroundWorkOutputStream,
  BackgroundWorkRow,
} from "@/lib/use-background-work";

/** Collapse the finished section by default once it's long enough that an
 * always-open list becomes a scroll — mirrors the Claude Code mobile app's
 * background-tasks sheet. */
const FINISHED_COLLAPSE_THRESHOLD = 5;
const TICK_MS = 1000;

type Tone = "running" | "clean" | "failed" | "unknown";

function isRunning(row: BackgroundWorkRow): boolean {
  return row.terminal === null;
}

/** Same three-way split `readBackgroundWorkOutput`'s doc and the dock row
 * both use, plus the fourth "unknown" bucket the sheet has room to show:
 * `exitCode === null` is a degraded status read, not a confirmed clean exit,
 * and it must render as neither. */
function toneFor(row: BackgroundWorkRow): Tone {
  if (!row.terminal) return "running";
  if (row.terminal.outcome !== "exited") return "failed"; // stopped | timeout | fault
  if (row.terminal.exitCode === null) return "unknown";
  return row.terminal.exitCode === 0 ? "clean" : "failed";
}

const GLYPH_TONE: Record<Tone, string> = {
  running: "text-steer",
  clean: "text-approve",
  failed: "text-reject",
  unknown: "text-muted-foreground",
};

const OUTCOME_LABEL: Record<BackgroundWorkOutcome, string> = {
  exited: "Exited",
  stopped: "Stopped",
  timeout: "Timed out",
  fault: "Faulted",
};

function exitText(row: BackgroundWorkRow): { text: string; className: string } | null {
  if (!row.terminal) return null;
  if (row.terminal.outcome !== "exited") {
    return { text: OUTCOME_LABEL[row.terminal.outcome], className: "text-reject" };
  }
  if (row.terminal.exitCode === null) {
    return { text: "Exit unknown", className: "text-muted-foreground" };
  }
  return {
    text: `Exit ${row.terminal.exitCode}`,
    className: row.terminal.exitCode === 0 ? "text-approve" : "text-reject",
  };
}

/** "45s" / "1m 12s" / "2h 3m" — the mock's format, not a clock face. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

const CANCEL_REASON_MESSAGE: Record<BackgroundWorkCancelReason, string> = {
  background_work_disabled: "Background work is off for this workspace.",
  unknown_id: "This task is no longer tracked.",
  already_terminal: "This task already finished.",
  sandbox_disabled: "The sandbox isn't available to cancel this.",
  cancel_failed: "Couldn't cancel this task.",
};

function KindGlyph({ row, tone }: { row: BackgroundWorkRow; tone: Tone }) {
  const Icon = row.kind === "subagent" ? Robot : Terminal;
  return (
    <Icon
      aria-hidden
      data-testid="bg-kind-glyph"
      data-tone={tone}
      weight={tone === "running" ? "regular" : "fill"}
      className={cn("size-4 shrink-0", GLYPH_TONE[tone])}
    />
  );
}

function StopButton({
  row,
  onCancel,
}: {
  row: BackgroundWorkRow;
  onCancel: (id: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      type="button"
      aria-label="Cancel task"
      title="Cancel"
      variant="ghost"
      size="icon-sm"
      disabled={pending}
      onClick={async (event) => {
        event.stopPropagation();
        setPending(true);
        try {
          await onCancel(row.id);
        } finally {
          setPending(false);
        }
      }}
    >
      <Stop aria-hidden className="size-4 text-reject" />
    </Button>
  );
}

/** Output panel for a `process` row — the sheet's only per-kind action for
 * that kind. A `subagent` row has no equivalent: `readBackgroundWorkOutput`
 * returns `null` for anything but a watched process, and Task 1 carries no
 * separate thread/transcript id a subagent row could link to (subagent runs
 * happen inside THIS thread, not a thread of their own), so there is nothing
 * to link to yet — left as a follow-up rather than invented. */
function ProcessOutput({
  row,
  readOutput,
}: {
  row: BackgroundWorkRow;
  readOutput: (
    id: string,
    stream?: BackgroundWorkOutputStream,
  ) => Promise<BackgroundWorkOutput | null>;
}) {
  const tone = toneFor(row);
  const defaultStream: BackgroundWorkOutputStream = tone === "failed" ? "stderr" : "stdout";
  const [expanded, setExpanded] = useState(false);
  // Snapshotting `defaultStream` into state at mount is only correct because
  // a row's tone (and therefore its default stream) cannot change without
  // the row moving from the Running section to the Finished section, which
  // remounts this component under a different `Section` — a row's tone
  // changing in place, under an unchanged mount, would go stale here. If the
  // two sections are ever merged into one flat list, this needs to become a
  // derived value (or reset on tone change) instead of initial state.
  const [stream, setStream] = useState<BackgroundWorkOutputStream>(defaultStream);
  const [status, setStatus] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [output, setOutput] = useState<BackgroundWorkOutput | null>(null);

  const load = async (nextStream: BackgroundWorkOutputStream) => {
    setStatus("loading");
    try {
      const result = await readOutput(row.id, nextStream);
      setOutput(result);
      setStatus("loaded");
    } catch {
      setStatus("error");
    }
  };

  return (
    <Collapsible
      open={expanded}
      onOpenChange={(next) => {
        setExpanded(next);
        // Fetch on first expand only — output is a provider round-trip, not
        // something to pay for every row on render.
        if (next && status === "idle") void load(stream);
      }}
    >
      <CollapsibleTrigger className="group flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground">
        <CaretDown aria-hidden className="size-3 transition-transform group-data-[state=open]:rotate-180" />
        Output
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-2">
        {status === "loading" && <p className="text-muted-foreground text-xs">Loading output…</p>}
        {status === "error" && (
          <p className="text-reject text-xs">Couldn't load output.</p>
        )}
        {/* `null` is a distinct answer from "loaded, but empty": it means
            `readBackgroundWorkOutput` couldn't get output at all (background
            work disabled, the row is no longer a tracked process, the
            sandbox couldn't be resolved, or a server-side throw) — never
            fold this into the empty-stream case below, or a genuine failure
            to fetch reads as "this command printed nothing". */}
        {status === "loaded" && output === null && (
          <p className="text-muted-foreground text-xs">Output isn't available for this task.</p>
        )}
        {status === "loaded" && output && (
          <>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-xs">Showing {output.stream}</span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => {
                  const next = stream === "stdout" ? "stderr" : "stdout";
                  setStream(next);
                  void load(next);
                }}
              >
                View {stream === "stdout" ? "stderr" : "stdout"}
              </Button>
            </div>
            {output.head.length === 0 && output.tail.length === 0 ? (
              <p className="text-muted-foreground text-xs">No output yet</p>
            ) : (
              <div className="overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-xs">
                {/* `truncated` is a DIFFERENT elision than `hiddenLines`: it
                    means retention discarded earlier output before it was
                    ever stored, not that we chose not to show a middle
                    section we still have. Silently dropping this has bitten
                    this codebase before, so it gets its own line rather than
                    being folded into `hiddenLines`. */}
                {output.truncated && (
                  <div className="text-muted-foreground italic">
                    … earlier output is no longer retained …
                  </div>
                )}
                {output.head.map((line, index) => (
                  <div key={`head-${index}`}>{line}</div>
                ))}
                {output.hiddenLines > 0 && (
                  <div className="text-muted-foreground">
                    … {output.hiddenLines} lines hidden …
                  </div>
                )}
                {output.tail.map((line, index) => (
                  <div key={`tail-${index}`}>{line}</div>
                ))}
              </div>
            )}
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** What the sheet needs from the SDK's live run stream. Deliberately the
 *  narrowest slice of `SubagentRunView`: presence of the run tells us the
 *  stream knows about it, and `progress` is the only field rendered. */
export type SubagentLiveRun = Pick<SubagentRunView, "progress">;

/**
 * Liveness for an in-flight `subagent` row.
 *
 * This is PROGRESS, not output, and the label says so. There is no path to a
 * subagent's transcript: `readBackgroundWorkOutput` answers only for watched
 * processes, and a subagent has no thread of its own to read. What does exist
 * is `reportProgress` — the child stamps `working (step N)` each step
 * (`src/agent/subagent.ts`) — which reaches us through `useAgentToolEvents`.
 * Calling that "Output" would be worse than showing nothing: a reader seeing
 * "Output — working (step 7)" would reasonably conclude that is all the
 * subagent produced.
 *
 * The three states are distinguished by whether the stream knows the run at
 * all, which is real information rather than a guess: `liveRun === undefined`
 * means this page's socket never saw the run start, i.e. it began before the
 * page loaded (a reload, or a thread opened later). A known run with no
 * message yet simply hasn't reported its first step. Neither renders an empty
 * container — a blank panel here was the bug this replaces.
 */
function SubagentProgress({
  running,
  liveRun,
}: {
  running: boolean;
  liveRun: SubagentLiveRun | undefined;
}) {
  // A finished subagent's outcome is already carried by the duration and exit
  // line above, and its result renders inline in the transcript. Showing the
  // last progress stamp here would be stale by definition.
  if (!running) return null;

  const message = liveRun?.progress?.message ?? liveRun?.progress?.phase;
  if (message) {
    return (
      <p className="text-muted-foreground text-xs">
        <span className="text-faint">Progress · </span>
        {message}
      </p>
    );
  }
  if (liveRun) {
    return <p className="text-muted-foreground text-xs">Waiting for the first update…</p>;
  }
  return (
    <p className="text-muted-foreground text-xs">
      Live progress isn't available for a run started before this page loaded.
    </p>
  );
}

/** A finished row's duration is `terminal.at - startedAt` — both server
 * timestamps, never wall-clock-now. The ledger stamps `at` the moment it
 * terminalizes the row (`WorkTerminal.at`), so this is authoritative and
 * stable across a reload; deriving it instead from "the moment this client
 * first saw the row as terminal" would make a finished row's duration
 * silently change (shrink toward zero) every time the page reloads, which is
 * worse than a merely stale number — it's a visibly wrong one. */
function durationFor(row: BackgroundWorkRow, now: number): number {
  const endedAt = row.terminal ? row.terminal.at : now;
  return Math.max(0, endedAt - row.startedAt);
}

function TaskRow({
  row,
  now,
  readOutput,
  onCancel,
  liveRunFor,
}: {
  row: BackgroundWorkRow;
  now: number;
  readOutput: (
    id: string,
    stream?: BackgroundWorkOutputStream,
  ) => Promise<BackgroundWorkOutput | null>;
  onCancel: (id: string) => Promise<void>;
  liveRunFor: (id: string) => SubagentLiveRun | undefined;
}) {
  const tone = toneFor(row);
  const running = isRunning(row);
  const duration = formatDuration(durationFor(row, now));
  const exit = exitText(row);
  const title = row.kind === "process" ? (row.label ?? row.id) : (row.label ?? "Subagent run");

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/20 px-3 py-2">
      <div className="flex items-start gap-2">
        <KindGlyph row={row} tone={tone} />
        <span
          className={cn(
            "min-w-0 flex-1 line-clamp-2 text-sm",
            row.kind === "process" ? "font-mono" : "font-sans",
          )}
        >
          {title}
        </span>
        {running && <StopButton row={row} onCancel={onCancel} />}
      </div>
      <div className="flex items-center gap-2 pl-6 text-xs">
        <span className="font-mono tabular-nums text-muted-foreground">{duration}</span>
        {exit && <span className={cn("font-mono tabular-nums", exit.className)}>{exit.text}</span>}
      </div>
      {row.kind === "process" ? (
        <div className="pl-6">
          <ProcessOutput row={row} readOutput={readOutput} />
        </div>
      ) : (
        // Still no navigation for a subagent row: it has no transcript of its
        // own to open (a detached agent-tool run inside THIS thread, whose
        // result already renders inline via CompletionGroup). What it does get
        // is live PROGRESS — see `SubagentProgress`. The id stays because it
        // also appears on that inline completion card, so it's the way to
        // correlate the two rather than new information.
        <div className="flex flex-col gap-1 pl-6">
          <SubagentProgress running={running} liveRun={liveRunFor(row.id)} />
          <p className="font-mono text-[11px] text-muted-foreground">{row.id}</p>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 py-1.5 text-left font-medium text-sm">
        <CaretDown
          aria-hidden
          className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
        />
        {title}
        <Badge variant="secondary">{count}</Badge>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 pb-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The background-tasks sheet — opened from `BackgroundTasksRow`. Follows
 * `ThreadDetailsSheet`'s bottom-sheet + `useVisualViewportInset` pattern so
 * an on-screen keyboard (unlikely here, but the pattern is cheap and the
 * alternative is a footer stuck under it on iOS) never traps the footer.
 *
 * Sections split `Running` (always open) from `Finished` (collapsed once it
 * gets long) rather than one flat list — adopted from the Claude Code mobile
 * app's background-tasks sheet, which the task brief calls out as better
 * than the original mock for exactly this reason.
 */
export function BackgroundTasksSheet({
  open,
  onOpenChange,
  rows,
  readOutput,
  cancel,
  clearFinished,
  onChanged,
  liveRunFor,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: BackgroundWorkRow[];
  readOutput: (
    id: string,
    stream?: BackgroundWorkOutputStream,
  ) => Promise<BackgroundWorkOutput | null>;
  cancel: (id: string) => Promise<{ ok: boolean; reason?: BackgroundWorkCancelReason }>;
  clearFinished: () => Promise<{ cleared: number }>;
  onChanged: () => void;
  /** Looks up the SDK's live run state for a subagent id. `undefined` means
   *  this page's socket never saw the run start, which is how a run that began
   *  before the page loaded is told apart from one that simply hasn't reported
   *  its first step yet. */
  liveRunFor: (id: string) => SubagentLiveRun | undefined;
}) {
  const viewport = useVisualViewportInset(open);
  const sheetStyle =
    viewport && viewport.keyboard > 0
      ? { bottom: `${viewport.keyboard}px`, maxHeight: `${viewport.height}px` }
      : undefined;

  // One tick for the whole sheet — not one interval per row — and only while
  // the sheet is open, so a closed sheet isn't a standing 1s wakeup.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [open]);

  const runningRows = rows.filter(isRunning);
  const finishedRows = rows.filter((row) => !isRunning(row));

  const [runningOpen, setRunningOpen] = useState(true);
  const [finishedOpen, setFinishedOpen] = useState(finishedRows.length <= FINISHED_COLLAPSE_THRESHOLD);
  // Only auto-collapse once, the first time the list crosses the threshold —
  // an explicit user toggle afterward should stick, not get overridden by
  // the next poll. Seeded from the INITIAL count, not `false`: a sheet that
  // mounts already past the threshold has already applied the one-time
  // collapse via `finishedOpen`'s own initializer above, so the ref must
  // start `true` too — otherwise the effect below still fires on the next
  // count change (e.g. the next poll) and force-collapses a section the
  // user has since reopened.
  const collapsedOnceRef = useRef(finishedRows.length > FINISHED_COLLAPSE_THRESHOLD);
  useEffect(() => {
    if (collapsedOnceRef.current) return;
    if (finishedRows.length > FINISHED_COLLAPSE_THRESHOLD) {
      setFinishedOpen(false);
      collapsedOnceRef.current = true;
    }
  }, [finishedRows.length]);

  const handleCancel = async (id: string) => {
    const result = await cancel(id);
    if (!result.ok) {
      toast.error(result.reason ? CANCEL_REASON_MESSAGE[result.reason] : "Couldn't cancel this task.");
    }
    onChanged();
  };

  const handleClearFinished = async () => {
    await clearFinished();
    onChanged();
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        style={sheetStyle}
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 pb-[env(safe-area-inset-bottom)]"
      >
        {/* Grab handle — a thumb-reachable affordance the shadcn `Sheet`
            doesn't give us on its own. */}
        <div className="flex shrink-0 justify-center pt-2">
          <div aria-hidden className="h-1.5 w-10 rounded-full bg-muted-foreground/25" />
        </div>
        <SheetHeader className="shrink-0 flex-row items-center justify-between border-b py-3 pr-3 pl-5 text-left">
          <SheetTitle className="text-base">Background tasks</SheetTitle>
          {/* Large circular close target, in place of the sheet's default
              small corner X — thumb-reachable on a bottom sheet. */}
          <Button
            type="button"
            aria-label="Close"
            variant="outline"
            size="icon-lg"
            className="rounded-full"
            onClick={() => onOpenChange(false)}
          >
            <X aria-hidden className="size-4" />
          </Button>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-auto">
          <div className="flex flex-col gap-1 px-4 py-2">
            {runningRows.length > 0 && (
              <Section title="Running" count={runningRows.length} open={runningOpen} onOpenChange={setRunningOpen}>
                {runningRows.map((row) => (
                  <TaskRow
                    key={row.id}
                    row={row}
                    now={now}
                    readOutput={readOutput}
                    onCancel={handleCancel}
                    liveRunFor={liveRunFor}
                  />
                ))}
              </Section>
            )}
            {finishedRows.length > 0 && (
              <Section title="Finished" count={finishedRows.length} open={finishedOpen} onOpenChange={setFinishedOpen}>
                {finishedRows.map((row) => (
                  <TaskRow
                    key={row.id}
                    row={row}
                    now={now}
                    readOutput={readOutput}
                    onCancel={handleCancel}
                    liveRunFor={liveRunFor}
                  />
                ))}
              </Section>
            )}
            {rows.length === 0 && (
              <p className="py-6 text-center text-muted-foreground text-sm">No background tasks.</p>
            )}
          </div>
        </ScrollArea>
        <SheetFooter className="shrink-0 flex-row justify-end border-t py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={finishedRows.length === 0}
            onClick={() => void handleClearFinished()}
          >
            Clear finished
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
