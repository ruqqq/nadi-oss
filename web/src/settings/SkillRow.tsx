import { useState, type ReactNode } from "react";
import { CaretDown } from "../icons";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

/**
 * One skill, as a card. Shared by the workspace library (Settings → Skills) and
 * by an agent's page, because the two views differ only in what a row *means* —
 * not in how it looks.
 *
 * The three slots are the whole provenance treatment:
 * - `live` drives the dot, and answers ONE question: is this skill loaded, in
 *   this view's scope, right now. On an agent that folds in exclusion and
 *   shadowing, so the dot never disagrees with what the model actually gets.
 * - `notes` answers *why* — the muted lines under the description.
 * - `trailing` is what the reader controls here, and nothing else.
 */
export function SkillRow({
  skill,
  live,
  dimmed = false,
  notes,
  trailing,
  footer,
}: {
  skill: { id: string; name: string; description: string; body: string };
  live: boolean;
  dimmed?: boolean;
  notes?: ReactNode;
  trailing?: ReactNode;
  /** Secondary actions, shown with the body when the row is expanded. */
  footer?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <li>
      <Card className={cn("overflow-hidden p-0", dimmed && "opacity-70")}>
        <div className="flex items-center gap-3 p-3">
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              live ? "bg-approve" : "bg-muted-foreground/40",
            )}
            aria-hidden="true"
          />
          <button
            className="group/expand -m-1 flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left transition-colors hover:bg-muted/50"
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-controls={`skill-body-${skill.id}`}
            title={expanded ? "Hide skill body" : "Show skill body"}
          >
            <CaretDown
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                expanded && "rotate-180",
              )}
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium text-sm">{skill.name}</span>
              <span className="truncate text-muted-foreground text-xs">{skill.description}</span>
              {notes}
            </span>
          </button>

          {trailing}
        </div>

        {expanded && (
          <>
            <Separator />
            <div id={`skill-body-${skill.id}`} className="space-y-3 bg-muted/30 p-3">
              <pre className="whitespace-pre-wrap break-words font-mono text-muted-foreground text-xs">
                {skill.body}
              </pre>
              {footer && <div className="flex flex-wrap gap-2">{footer}</div>}
            </div>
          </>
        )}
      </Card>
    </li>
  );
}

/**
 * A muted explanation under a skill's description. Wraps rather than truncates,
 * unlike the description above it: a note that ends "Shadowed by this agent's
 * own software_en…" has withheld the only word the reader needed.
 */
export function SkillNote({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground/80 text-xs">{children}</span>;
}
