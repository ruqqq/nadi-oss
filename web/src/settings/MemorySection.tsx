import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { archiveMemory, listMemories, restoreMemory, type Memory } from "../memory-api";
import { MEMORY_SETTINGS_HINT } from "../settings-ui-config";
import { ArchiveButton } from "../components/ArchiveButton";
import { ArrowCounterClockwise, CaretDown } from "../icons";
import { cn } from "../lib/utils";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Card } from "../components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Separator } from "../components/ui/separator";
import { Skeleton } from "../components/ui/skeleton";
import { SectionHeading } from "./section-ui";

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function MemorySection() {
  const [memories, setMemories] = useState<Memory[] | null>(null); // null = loading
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(() => {
    setMemories(null);
    setLoadError(null);
    void listMemories(showArchived)
      .then(setMemories)
      .catch((err: unknown) => {
        setMemories([]);
        setLoadError(err instanceof Error ? err : new Error(String(err)));
      });
  }, [showArchived]);

  useEffect(() => {
    load();
  }, [load]);

  const onArchive = useCallback(async (memory: Memory) => {
    try {
      await archiveMemory(memory.id);
      setMemories((cur) => cur?.filter((m) => m.id !== memory.id) ?? null);
      toast.success("Memory archived");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not archive memory");
    }
  }, []);

  const onRestore = useCallback(async (memory: Memory) => {
    try {
      await restoreMemory(memory.id);
      setMemories((cur) => cur?.filter((m) => m.id !== memory.id) ?? null);
      toast.success("Memory restored");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not restore memory");
    }
  }, []);

  return (
    <section aria-label="Memory" className="space-y-4">
      <SectionHeading title="Memory" description={MEMORY_SETTINGS_HINT} />

      <ButtonGroup aria-label="Filter memories">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-pressed={!showArchived}
          className={cn(!showArchived && "bg-accent text-accent-foreground")}
          onClick={() => setShowArchived(false)}
        >
          Active
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-pressed={showArchived}
          className={cn(showArchived && "bg-accent text-accent-foreground")}
          onClick={() => setShowArchived(true)}
        >
          Archived
        </Button>
      </ButtonGroup>

      {loadError ? (
        <div className="space-y-3" role="alert">
          <Alert variant="destructive">
            <AlertDescription>Couldn’t load memories. {loadError.message}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={load}>
            Retry
          </Button>
        </div>
      ) : memories === null ? (
        <Skeleton className="h-24 w-full" />
      ) : memories.length === 0 ? (
        <div className="rounded-lg border border-border border-dashed py-10 text-center">
          <p className="text-muted-foreground text-sm">
            {showArchived ? "No archived memories" : "Nothing remembered yet"}
          </p>
          {!showArchived ? (
            <p className="mt-1 text-muted-foreground text-xs">
              As you chat, the agent saves what's worth keeping here.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2">
          {memories.map((memory) => (
            <MemoryRow
              key={memory.id}
              memory={memory}
              archivedView={showArchived}
              onArchive={onArchive}
              onRestore={onRestore}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function MemoryRow({
  memory,
  archivedView,
  onArchive,
  onRestore,
}: {
  memory: Memory;
  archivedView: boolean;
  onArchive: (m: Memory) => void;
  onRestore: (m: Memory) => void;
}) {
  const [open, setOpen] = useState(false);
  const heading = memory.title ?? memory.content;
  return (
    <Card className="p-3">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-start justify-between gap-3">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-start gap-2 text-left">
            <CaretDown
              aria-hidden
              className={cn("mt-0.5 shrink-0 transition-transform", open && "rotate-180")}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Badge variant="outline">{memory.kind}</Badge>
                <span className="truncate font-medium">{heading}</span>
              </div>
              <p className="text-muted-foreground text-xs">
                Updated {formatWhen(memory.updatedAt)}
              </p>
            </div>
          </CollapsibleTrigger>
          <div className="flex shrink-0 items-center gap-2">
            {archivedView ? (
              <Button variant="secondary" size="sm" onClick={() => onRestore(memory)}>
                <ArrowCounterClockwise aria-hidden /> Restore
              </Button>
            ) : (
              <ArchiveButton itemName={heading} kind="memory" onConfirm={() => onArchive(memory)} />
            )}
          </div>
        </div>
        <CollapsibleContent>
          <Separator className="my-3" />
          <p className="whitespace-pre-wrap break-words text-muted-foreground text-sm">
            {memory.content}
          </p>
          <p className="mt-2 text-muted-foreground text-xs">
            Created {formatWhen(memory.createdAt)}
            {memory.sourceThreadId ? " · from a conversation" : ""}
          </p>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
