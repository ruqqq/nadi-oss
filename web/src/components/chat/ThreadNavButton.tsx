import { backLabel } from "../../lib/app-history";
import { List, ArrowLeft } from "../../icons";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

/**
 * The topbar's leading control, phone-only — the rail is pinned in the
 * two-column layout, so neither the toggle nor the back button has anything to
 * do there. It hides on `wide`, the same gate that pins the rail: a phone in
 * landscape is wide enough to clear `md` but still gets the drawer, and hiding
 * the toggle there would leave the rail reachable only by edge-drag.
 *
 * A thread reached from somewhere with a way back (a run in Automata) gets a
 * Back that returns there; every other thread gets the rail toggle, because
 * "back" to a drawer isn't a place. App decides once and passes the element
 * down, so the topbars can't drift apart.
 *
 * The toggle carries a badge when the hidden rail holds something unread. Only
 * the toggle does: Back leads somewhere else entirely, so a dot there would
 * point at the wrong place.
 */
export function ThreadNavButton({
  backTo,
  onBack,
  onToggleThreads,
  badge = null,
}: {
  /** The path Back returns to, or null when the rail toggle is the right control. */
  backTo: string | null;
  onBack: () => void;
  onToggleThreads: () => void;
  /** What the out-of-sight rail is holding, from `railToggleIndicator`. */
  badge?: { kind: "attention" | "unread"; label: string } | null;
}) {
  const showBadge = !backTo && badge !== null;
  const label = backTo ? backLabel(backTo) : "Show chats";
  // The badge is part of what the control means, so it belongs in the name
  // rather than in a decoration a screen reader never reaches.
  const accessibleLabel = showBadge && badge ? `${label}, ${badge.label.toLowerCase()}` : label;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative wide:hidden"
      onClick={backTo ? onBack : onToggleThreads}
      aria-label={accessibleLabel}
      title={accessibleLabel}
    >
      {backTo ? <ArrowLeft aria-hidden /> : <List aria-hidden />}
      {showBadge && badge && (
        // Same vocabulary as the rows it stands for: amber is you, aubergine is
        // information. The ring keeps it legible where it overlaps the glyph.
        <span
          aria-hidden
          className={cn(
            "absolute top-1.5 right-1.5 size-2 rounded-full ring-2 ring-background",
            badge.kind === "attention" ? "bg-steer" : "bg-primary",
          )}
        />
      )}
    </Button>
  );
}
