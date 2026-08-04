import { useState } from "react";
import { DotsThreeVertical, Eye, EyeSlash, FolderSimple } from "../../icons";
import { cn } from "../../lib/utils";
import type { ProjectSummary } from "../../projects-api";
import type { ThreadSummary } from "../../threads-api";
import { ProjectCommand } from "../projects/ProjectCommand";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../ui/sheet";

/**
 * Row actions for a rail thread. The surface follows the house rule: an
 * anchored dropdown off the ⋮ for pointer users, a bottom sheet on touch —
 * where the row's long press opens it, since there is no hover to reveal a
 * trigger.
 *
 * `open` is controlled by the row so the long press (which lands on the row,
 * not on this trigger) can raise the same menu the ⋮ does.
 *
 * "Move to…" is a second surface rather than a submenu: the project list is a
 * Command with its own search field, and a menu swallows the keystrokes.
 *
 * Archiving is deliberately NOT here. All chats owns Archive and Delete, which
 * is the right home for them — it is the surface that holds every chat. The
 * rail's answer to "get this out of my way" is Dismiss, which is reversible and
 * loses nothing.
 */
export function ThreadRowMenu({
  thread,
  disabled,
  touchPrimary,
  narrowLayout,
  projects,
  open,
  onOpenChange,
  onMove,
  onCreateProject,
  onMarkRead,
  onDismiss,
}: {
  thread: ThreadSummary;
  disabled: boolean;
  /** Touch-first input — long press opens the menu; no visible ⋮ trigger. */
  touchPrimary: boolean;
  /** Drawer rail vs pinned sidebar — drives move-sheet placement. */
  narrowLayout: boolean;
  projects: ProjectSummary[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMove: (projectId: string | null) => void;
  onCreateProject: (name: string) => Promise<void>;
  onMarkRead: () => void;
  onDismiss: () => void;
}) {
  const [moving, setMoving] = useState(false);
  const value = thread.projectId ?? "none";

  const closeAll = () => {
    setMoving(false);
    onOpenChange(false);
  };

  const handleSelect = (next: "none" | string) => {
    onMove(next === "none" ? null : next);
    closeAll();
  };

  const moveSurface = (
    <Sheet
      open={moving}
      onOpenChange={(next) => {
        setMoving(next);
        // Backing out of the move closes the row's menu with it, rather than
        // dropping the user back onto a stale action list.
        if (!next) onOpenChange(false);
      }}
    >
      <SheetContent
        side={narrowLayout ? "bottom" : "right"}
        className="flex flex-col gap-0 p-0 pb-[env(safe-area-inset-bottom)] sm:max-w-sm"
      >
        <SheetHeader className="shrink-0 border-b py-4 pr-12 pl-5 text-left">
          <SheetTitle className="text-base">Move to project</SheetTitle>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* Remount per open so each visit starts from an empty query. */}
          <ProjectCommand
            key={moving ? "open" : "closed"}
            value={value}
            projects={projects}
            onSelect={handleSelect}
            onCreateProject={onCreateProject}
            listClassName="min-h-0 flex-1 max-h-none"
          />
        </div>
      </SheetContent>
    </Sheet>
  );

  return (
    <>
      <DropdownMenu open={open && !moving} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          {touchPrimary ? (
            // Touch reaches this menu by long press, so the trigger is only an
            // anchor: it must not be tappable (it would sit over the row's own
            // tap target) and must not be announced as an action that a touch
            // user cannot perform.
            <span aria-hidden className="pointer-events-none block size-7" />
          ) : (
            <Button
              variant="ghost"
              size="icon"
              // The trigger rests invisible but keeps its space in the row's
              // gutter, so revealing it never reflows the title. It stays
              // reachable by keyboard, and stays visible while its menu is open.
              // On a narrow pointer layout there is no hover row to discover it
              // from, so it stays visible.
              className={cn(
                "size-7 text-muted-foreground transition-opacity hover:text-foreground focus-visible:opacity-100",
                narrowLayout || open ? "opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
              disabled={disabled}
              aria-label={`Actions for ${thread.title}`}
              title="Actions"
            >
              <DotsThreeVertical aria-hidden />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {/* Conditional: an entry that is a no-op on most rows teaches people
              to stop reading the menu. This is also how a failed automata run
              gets acknowledged — clearing the marker IS the acknowledgement. */}
          {thread.unreadOutcome != null && (
            <DropdownMenuItem onSelect={onMarkRead}>
              <Eye aria-hidden />
              Mark as read
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setMoving(true)}>
            <FolderSimple aria-hidden />
            Move to project
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* Not destructive styling: nothing is lost, and the chat is still in
              All chats a tap later. */}
          <DropdownMenuItem onSelect={onDismiss}>
            <EyeSlash aria-hidden />
            Dismiss
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {moveSurface}
    </>
  );
}
