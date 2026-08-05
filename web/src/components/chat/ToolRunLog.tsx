import { useState } from "react";
import { CaretRight } from "@/icons";
import { cn } from "@/lib/utils";
import type { DetailBlock, ToolLogEntry } from "@/lib/tool-log";

/**
 * A run of tool calls as one scrollback. Each row is a kind gutter, the object
 * it acted on, and its status; the detail sits under it in blocks shaped by the
 * tool. Nothing collapses — the whole run is legible in one scroll — but long
 * text clamps to a few lines with a control that grows it in place.
 *
 * The gutter is the load-bearing idea: `$` in the accent colour means a real
 * shell and nothing else, a lowercase verb means a built-in, and an MCP call
 * leads with its server's name so it reads as itself rather than as bash.
 */

const CLAMP_LINES = 8;
/** Advance width of JetBrains Mono at the gutter's 11px — used to size the
 *  gutter column to its content without measuring in the DOM. */
const MONO_CHAR_PX = 6.7;
/** `$` alone still needs a lane wide enough to read as a column. */
const MIN_GUTTER_CHARS = 4;
/** Past this a server name truncates rather than eating the row. */
const MAX_GUTTER_CHARS = 12;
/** Mirrors gap-x-2.5 and px-3 on the row, so detail lines up under the object. */
const GUTTER_GAP_PX = 10;
const ROW_PAD_PX = 12;
/** A line budget alone can't bound one very long line — a whole file arrives as
 *  a single `content` string with no newlines in it. */
const CLAMP_CHARS = 600;

/** The visible prefix of `text`, bounded by both lines and characters. */
function clamp(text: string): { shown: string; hidden: number } {
  const lines = text.split("\n");
  const byLine = lines.slice(0, CLAMP_LINES).join("\n");
  const shown = byLine.length > CLAMP_CHARS ? byLine.slice(0, CLAMP_CHARS) : byLine;
  return { shown, hidden: text.length - shown.length };
}

function BlockShell({
  label,
  tone,
  children,
}: {
  label?: string;
  tone?: "error";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border bg-card",
        tone === "error" && "border-reject/40",
      )}
    >
      {label ? (
        <div
          className={cn(
            "border-b bg-muted px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground",
            tone === "error" && "bg-reject/10 text-reject",
          )}
        >
          {label}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** Text that clamps to a few lines, with a control that grows it in place. */
function ClampedText({ text, tone, wrap }: { text: string; tone?: "error"; wrap?: boolean }) {
  const [open, setOpen] = useState(false);
  const { shown, hidden } = clamp(text);
  const overflows = hidden > 0;
  const lines = text.split("\n");
  const hiddenLines = lines.length - CLAMP_LINES;

  return (
    <>
      <pre
        className={cn(
          "px-2.5 py-2 font-mono text-[11.5px] leading-relaxed",
          wrap ? "whitespace-pre-wrap break-words" : "overflow-x-auto whitespace-pre",
          tone === "error" ? "text-reject" : "text-foreground",
        )}
      >
        {open ? text : shown}
      </pre>
      {overflows ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full border-t bg-muted px-2.5 py-1 text-left font-mono text-[11px] text-muted-foreground transition hover:text-foreground"
        >
          {open
            ? "Collapse"
            : hiddenLines > 0
              ? `… ${hiddenLines} more lines`
              : `… ${hidden} more characters`}
        </button>
      ) : null}
    </>
  );
}

/** A `*** Begin Patch` body, coloured by the +/- gutter of each line. */
function Diff({ patch }: { patch: string }) {
  const [open, setOpen] = useState(false);
  const lines = patch.split("\n");
  const overflows = lines.length > CLAMP_LINES;
  const shown = open || !overflows ? lines : lines.slice(0, CLAMP_LINES);

  return (
    <>
      <div className="overflow-x-auto py-1 font-mono text-[11.5px] leading-relaxed">
        {shown.map((line, i) => (
          <div
            key={i}
            className={cn(
              "whitespace-pre px-2.5",
              line.startsWith("+") && "bg-approve/10 text-approve",
              line.startsWith("-") && "bg-reject/10 text-reject",
              (line.startsWith("@@") || line.startsWith("*** ")) && "text-faint",
            )}
          >
            {line || " "}
          </div>
        ))}
      </div>
      {overflows ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full border-t bg-muted px-2.5 py-1 text-left font-mono text-[11px] text-muted-foreground transition hover:text-foreground"
        >
          {open ? "Collapse" : `… ${lines.length - CLAMP_LINES} more lines`}
        </button>
      ) : null}
    </>
  );
}

function Block({ block }: { block: DetailBlock }) {
  switch (block.kind) {
    case "note":
      return (
        <p
          className={cn(
            "font-mono text-[11.5px] leading-relaxed",
            block.tone === "error" ? "text-reject" : "text-muted-foreground",
          )}
        >
          {block.text}
        </p>
      );

    case "text":
      return (
        <BlockShell label={block.label} {...(block.tone === "error" ? { tone: "error" as const } : {})}>
          <ClampedText
            text={block.text}
            {...(block.tone === "error" ? { tone: "error" as const } : {})}
            {...(block.wrap ? { wrap: true } : {})}
          />
        </BlockShell>
      );

    case "diff":
      return (
        <BlockShell label={block.label}>
          <Diff patch={block.patch} />
        </BlockShell>
      );

    case "fields":
      return (
        <BlockShell label={block.label}>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3.5 gap-y-0.5 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed">
            {block.fields.map((field) => (
              <div key={field.key} className="contents">
                <dt className="whitespace-nowrap text-muted-foreground">{field.key}</dt>
                <dd className="min-w-0 break-words text-foreground">{field.value}</dd>
              </div>
            ))}
          </dl>
        </BlockShell>
      );

    case "list":
      return (
        <BlockShell
          label={`${block.label} · ${block.total} item${block.total === 1 ? "" : "s"}`}
        >
          <ol className="flex flex-col gap-1 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed">
            {block.items.map((item, i) => (
              <li key={i} className="min-w-0">
                <span className="text-foreground">{item.primary}</span>
                {item.secondary ? (
                  <span className="block truncate text-muted-foreground">{item.secondary}</span>
                ) : null}
              </li>
            ))}
          </ol>
          {block.total > block.items.length ? (
            <p className="border-t bg-muted px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
              … {block.total - block.items.length} more
            </p>
          ) : null}
        </BlockShell>
      );

    case "json":
      return (
        <BlockShell label={block.label}>
          <ClampedText text={block.json} />
        </BlockShell>
      );
  }
}

const STATE_CHIP: Record<string, string> = {
  error: "border-reject/40 bg-reject/10 text-reject",
  denied: "border-steer/40 bg-steer-bg text-steer",
  backgrounded: "border-border bg-muted text-muted-foreground",
  running: "border-border bg-muted text-muted-foreground",
};

/**
 * One call. The row is always visible — the rows together ARE the overview — and
 * the detail under it starts collapsed, so opening a run reads as a summary of
 * what happened rather than every payload at once. A call with nothing to show
 * (an `activate_skill`, say) renders as a plain row with no toggle.
 */
function Row({
  entry,
  duration,
  gutterWidth,
}: {
  entry: ToolLogEntry;
  duration?: string | undefined;
  gutterWidth: number;
}) {
  const [open, setOpen] = useState(false);
  const expandable = entry.blocks.length > 0;

  const row = (
    <div
      className="grid w-full items-baseline gap-x-2.5 px-3 py-2 text-left sm:px-3.5"
      style={{ gridTemplateColumns: `${gutterWidth}px minmax(0,1fr) auto` }}
    >
      <span
        className={cn(
          "truncate text-right font-mono text-[11px]",
          entry.gutterKind === "exec" && "font-bold text-primary",
          entry.gutterKind === "mcp" && "font-bold text-gate",
          (entry.gutterKind === "verb" || entry.gutterKind === "raw") && "text-faint",
          entry.state === "error" && "text-reject",
        )}
      >
        {entry.gutter}
      </span>

      <span className="min-w-0">
        <span
          className={cn(
            "line-clamp-2 break-words font-mono text-[12.5px] font-semibold",
            !entry.objectMono && "font-sans",
            entry.state === "error" && "text-reject",
            entry.state === "running" && "activity-shimmer",
          )}
        >
          {entry.object}
        </span>
        {entry.subtitle ? (
          <span className="block truncate font-mono text-[11.5px] font-normal text-muted-foreground">
            {entry.subtitle}
          </span>
        ) : null}
      </span>

      <span className="flex items-center gap-2">
        {entry.statusLabel ? (
          <span
            className={cn(
              "inline-flex whitespace-nowrap rounded-full border px-2 py-px text-[11px] font-semibold",
              STATE_CHIP[entry.state] ?? "border-border bg-card text-muted-foreground",
            )}
          >
            {entry.statusLabel}
          </span>
        ) : null}
        {duration ? (
          <span className="font-mono text-[11px] tabular-nums text-faint">{duration}</span>
        ) : null}
        {expandable ? (
          <CaretRight
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-faint transition-transform",
              open && "rotate-90",
            )}
          />
        ) : null}
      </span>
    </div>
  );

  return (
    <div className="pb-1">
      {expandable ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="w-full rounded-md transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
        >
          {row}
        </button>
      ) : (
        row
      )}

      {expandable && open ? (
        <div
          className="flex flex-col gap-1.5 pb-1 pr-3 sm:pr-3.5"
          style={{ paddingLeft: gutterWidth + GUTTER_GAP_PX + ROW_PAD_PX }}
        >
          {entry.blocks.map((block, i) => (
            <Block key={i} block={block} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ToolRunLog({
  entries,
}: {
  entries: { key: string; entry: ToolLogEntry; duration?: string | undefined }[];
}) {
  // Sized to the longest gutter in THIS run, not to a number picked for the
  // worst case: a run of built-ins gets a narrow column instead of pushing
  // "read" and "$" to the right of dead space, while a run containing an MCP
  // server still fits its name. Every row shares the width, so they align.
  const longest = entries.reduce((max, e) => Math.max(max, e.entry.gutter.length), 0);
  const gutterWidth = Math.round(
    Math.min(Math.max(longest, MIN_GUTTER_CHARS), MAX_GUTTER_CHARS) * MONO_CHAR_PX,
  );

  return (
    <div className="flex min-h-0 flex-auto flex-col overflow-y-auto py-1">
      {entries.map(({ key, entry, duration }) => (
        <Row key={key} entry={entry} duration={duration} gutterWidth={gutterWidth} />
      ))}
    </div>
  );
}
