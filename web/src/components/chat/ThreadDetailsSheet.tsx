import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Archive, Copy, Trash } from "../../icons";
import { formatContextGauge } from "../../lib/context-gauge";
import { cn } from "../../lib/utils";
import { useMediaQuery } from "../../lib/use-media-query";
import { useVisualViewportInset } from "../../lib/use-visual-viewport-inset";
import { formatCreatedAt, formatRelativeTime } from "../../lib/thread-time";
import { WorkbenchPicker } from "../workbenches/WorkbenchPicker";
import type { ProjectSummary } from "../../projects-api";
import type { ThreadSummary } from "../../threads-api";
import type { WorkbenchSummary } from "../../workbenches-api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ScrollArea } from "../ui/scroll-area";
import { Separator } from "../ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../ui/sheet";
import { ProjectPicker } from "../projects/ProjectPicker";

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right text-foreground">{children}</span>
    </div>
  );
}

export function ThreadDetailsSheet({
  open,
  onOpenChange,
  thread,
  projects,
  workbenches = [],
  onRename,
  onMoveThread,
  onCreateProjectForThread,
  onArchiveThread,
  onDeleteThread,
  onSwitchWorkbench,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  thread: ThreadSummary;
  projects: ProjectSummary[];
  workbenches?: WorkbenchSummary[];
  onRename?: (threadId: string, title: string) => void;
  onMoveThread?: (threadId: string, projectId: string | null) => void;
  onCreateProjectForThread?: (threadId: string, name: string) => Promise<void>;
  onArchiveThread?: (threadId: string) => void;
  onDeleteThread?: (threadId: string) => void;
  onSwitchWorkbench?: (threadId: string, workbenchId: string | null) => Promise<void> | void;
}) {
  const isMobile = useMediaQuery("(max-width: 640px)");
  const viewport = useVisualViewportInset(open && isMobile);
  const [draftTitle, setDraftTitle] = useState(thread.title);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingWorkbenchId, setPendingWorkbenchId] = useState<"none" | string | null>(null);

  // Reseed the rename draft when the thread or its title changes.
  useEffect(() => {
    setDraftTitle(thread.title);
  }, [thread.threadId, thread.title]);

  const now = Date.now();
  const isArchived = thread.status === "archived";
  const gauge = formatContextGauge(
    thread.lastContextTokens,
    thread.lastContextWindow,
    thread.lastCompactAfterTokens,
  );

  const commitRename = () => {
    const next = draftTitle.trim();
    if (!onRename || next === "" || next === thread.title) {
      setDraftTitle(thread.title);
      return;
    }
    onRename(thread.threadId, next);
  };

  const pendingWorkbenchName =
    pendingWorkbenchId == null
      ? null
      : pendingWorkbenchId === "none"
        ? "No workbench"
        : (workbenches.find((workbench) => workbench.id === pendingWorkbenchId)?.name ??
          pendingWorkbenchId);

  const confirmSwitchWorkbench = () => {
    if (pendingWorkbenchId === null) return;
    const nextWorkbenchId = pendingWorkbenchId === "none" ? null : pendingWorkbenchId;
    void onSwitchWorkbench?.(thread.threadId, nextWorkbenchId);
    setPendingWorkbenchId(null);
  };

  const copyId = () => {
    void navigator.clipboard
      ?.writeText(thread.threadId)
      .then(() => toast.success("Chat ID copied"))
      .catch(() => toast.error("Couldn't copy"));
  };

  const body = (
    <ScrollArea className="min-h-0 flex-auto">
      <div className="flex flex-col gap-5 px-5 py-4">
        <section className="space-y-2">
          <Label htmlFor="thread-title">Title</Label>
          {onRename ? (
            <Input
              id="thread-title"
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  setDraftTitle(thread.title);
                  event.currentTarget.blur();
                }
              }}
              placeholder="Untitled thread"
            />
          ) : (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-foreground text-sm">
              {thread.title || "Untitled thread"}
            </div>
          )}
        </section>

        <section className="space-y-2">
          <Label>Project</Label>
          {onMoveThread ? (
            <>
              <ProjectPicker
                value={thread.projectId ?? "none"}
                projects={projects}
                onValueChange={(next) =>
                  onMoveThread(thread.threadId, next === "none" ? null : next)
                }
                onCreateProject={(name) =>
                  onCreateProjectForThread?.(thread.threadId, name) ?? Promise.resolve()
                }
              />
              {thread.projectId && thread.repositorySnapshotCount > 0 && (
                <p className="text-muted-foreground text-xs">
                  {thread.repositorySnapshotCount}{" "}
                  {thread.repositorySnapshotCount === 1 ? "repository" : "repositories"}
                </p>
              )}
            </>
          ) : (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-foreground text-sm">
              {thread.projectName ?? "No project"}
            </div>
          )}
        </section>

        <section className="space-y-2">
          <Label>Workbench</Label>
          {onSwitchWorkbench && !thread.readOnly ? (
            <WorkbenchPicker
              value={thread.workbenchId ?? "none"}
              workbenches={workbenches}
              selectedName={thread.workbenchName ?? undefined}
              onValueChange={(next) => setPendingWorkbenchId(next)}
            />
          ) : (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-foreground text-sm">
              {thread.workbenchName ?? "No workbench"}
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            Sandbox size: <span className="font-mono">{thread.resourceProfile}</span>
          </p>
        </section>

        <Separator />

        <section className="-my-2">
          <DetailRow label="Model">
            <span className="break-words">
              {thread.provider ? `${thread.provider} · ${thread.model}` : thread.model || "—"}
            </span>
          </DetailRow>
          <DetailRow label="Context">
            {gauge ? (
              <span className="inline-flex flex-col items-end gap-1">
                <span className="font-mono text-xs whitespace-nowrap">{gauge.label}</span>
                <span
                  className="h-1 w-24 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-label="Context used"
                  aria-valuenow={gauge.percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span
                    className={cn(
                      "block h-full rounded-full transition-[width]",
                      // `--steer` (amber), not the spec's `--gate`: amber is the
                      // repo's warning colour and the aubergine `--gate` reads as
                      // a normal accent here. Deliberate deviation, recorded.
                      gauge.tone === "warning" ? "bg-steer" : "bg-primary",
                    )}
                    style={{ width: `${gauge.percent}%` }}
                  />
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">Not tracked</span>
            )}
          </DetailRow>
          <DetailRow label="Created">{formatCreatedAt(thread.createdAt, now)}</DetailRow>
          <DetailRow label="Last updated">{formatRelativeTime(thread.updatedAt, now)}</DetailRow>
          {thread.source === "automaton" && <DetailRow label="Source">Automaton</DetailRow>}
          <DetailRow label="Status">{isArchived ? "Archived" : "Active"}</DetailRow>
          <DetailRow label="Thread ID">
            <button
              type="button"
              onClick={copyId}
              className="inline-flex max-w-full items-center gap-1.5 rounded font-mono text-muted-foreground text-xs hover:text-foreground"
              title="Copy chat ID"
            >
              <span className="truncate">{thread.threadId}</span>
              <Copy aria-hidden className="size-3.5 shrink-0" />
            </button>
          </DetailRow>
        </section>

        {(onArchiveThread || onDeleteThread) && (
          <>
            <Separator />
            <section className="space-y-2">
              <Label className="text-muted-foreground">Danger zone</Label>
              <div className="flex flex-wrap gap-2">
                {onArchiveThread && (
                  <Button
                    variant="outline"
                    onClick={() => setConfirmArchive(true)}
                    className="gap-2"
                  >
                    <Archive aria-hidden />
                    Archive
                  </Button>
                )}
                {onDeleteThread && (
                  <Button
                    variant="outline"
                    onClick={() => setConfirmDelete(true)}
                    className="gap-2 border-reject/40 text-reject hover:bg-reject/10 hover:text-reject"
                  >
                    <Trash aria-hidden />
                    Delete
                  </Button>
                )}
              </div>
              {onArchiveThread && (
                <p className="text-muted-foreground text-xs">
                  Archiving keeps a read-only copy. Deleting is permanent.
                </p>
              )}
            </section>
          </>
        )}
      </div>
    </ScrollArea>
  );

  const sheetStyle =
    isMobile && viewport && viewport.keyboard > 0
      ? { bottom: `${viewport.keyboard}px`, maxHeight: `${viewport.height}px` }
      : undefined;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side={isMobile ? "bottom" : "right"}
          style={sheetStyle}
          // Don't pull focus into (and select) the title input when the sheet
          // opens — it should open calmly, with rename an explicit action.
          onOpenAutoFocus={(event) => event.preventDefault()}
          className={
            isMobile
              ? "flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 pb-[env(safe-area-inset-bottom)]"
              : "flex w-full flex-col gap-0 p-0 sm:max-w-md"
          }
        >
          <SheetHeader className="shrink-0 border-b py-4 pr-12 pl-5 text-left">
            <SheetTitle className="text-base">Thread details</SheetTitle>
          </SheetHeader>
          {body}
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive chat?</AlertDialogTitle>
            <AlertDialogDescription>
              This keeps a read-only copy you can still view. You can’t send new messages in an
              archived thread.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onArchiveThread?.(thread.threadId);
                onOpenChange(false);
              }}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingWorkbenchId !== null}
        onOpenChange={(next) => {
          if (!next) setPendingWorkbenchId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch to {pendingWorkbenchName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This discards the current sandbox. Any uncommitted files will be discarded. The
              agent will be asked to save its work first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmSwitchWorkbench}>
              Switch workbench
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete chat?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes “{thread.title || "Untitled thread"}” and its messages. This
              can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-reject text-reject-foreground hover:bg-reject/90"
              onClick={() => {
                onDeleteThread?.(thread.threadId);
                onOpenChange(false);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
