import { type ComponentPropsWithoutRef, forwardRef } from "react";
import { CaretRight, Warning } from "@/icons";
import { cn } from "@/lib/utils";
import type { LineSegment, LineTone } from "@/lib/tool-summary";

/** State drives the leading marker: a spinner while running, a warning on error. */
export type ActivityState = "idle" | "active" | "error";

function toneClass(tone: LineTone | undefined): string {
  switch (tone) {
    case "add":
      return "text-approve font-medium";
    case "del":
      return "text-reject font-medium";
    case "faint":
      return "text-faint";
    default:
      return "";
  }
}

/**
 * The recessed, verb-led activity line shared by ToolGroup and CompletionGroup.
 * Success is silent — no glyph, no status dot; the text sits flush with the
 * message prose. A running run shimmers its text in place (no marker, so the
 * line never shifts as it starts/finishes); a failed run gets a leading warning.
 * The whole row is the inspector trigger, so it forwards its ref/props to the
 * button for Radix `asChild`; a faint chevron keeps it legibly tappable on touch.
 */
export const ActivityLine = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & {
    segments: LineSegment[];
    state: ActivityState;
    /** Accessible name (the plain summary text). */
    label: string;
  }
>(function ActivityLine({ segments, state, label, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      className={cn(
        "group not-prose mb-1 flex w-fit max-w-full items-baseline gap-1.5 rounded-md py-0.5 pr-1.5 text-left align-top text-sm transition hover:bg-muted/40",
        state === "error" ? "text-reject" : "text-muted-foreground",
        className,
      )}
      {...props}
    >
      {state === "error" && (
        <Warning weight="fill" aria-hidden className="size-3.5 shrink-0 self-center text-reject" />
      )}
      <span className={cn("min-w-0 truncate", state === "active" && "activity-shimmer")}>
        {segments.map((seg, i) => (
          <span key={i} className={cn(toneClass(seg.tone), seg.mono && "font-mono text-[0.82em]")}>
            {i > 0 ? " " : ""}
            {seg.text}
          </span>
        ))}
      </span>
      <CaretRight
        aria-hidden
        className="size-4 shrink-0 self-center text-faint transition group-hover:text-muted-foreground"
      />
    </button>
  );
});
