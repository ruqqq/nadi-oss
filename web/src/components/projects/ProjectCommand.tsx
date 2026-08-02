import { useMemo, useState } from "react";
import { Check, FolderSimple, Plus } from "../../icons";
import { projectPickerState } from "../../lib/project-picker";
import type { ProjectSummary } from "../../projects-api";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../ui/command";
import { Spinner } from "../ui/spinner";

/**
 * The searchable project list with inline, name-only quick-add — the body of
 * the project surfaces, without a trigger or a container of its own. Shared by
 * the composer's ProjectPicker (Popover/Sheet) and the rail row's move surface,
 * so "search or create a project" behaves the same wherever it is offered.
 *
 * The parent owns the surface and its open state; this owns only the query and
 * the in-flight create. onCreateProject must reject on failure so the typed
 * name survives for a retry.
 */
export function ProjectCommand({
  value,
  projects,
  onSelect,
  onCreateProject,
  listClassName,
}: {
  value: "none" | string;
  projects: ProjectSummary[];
  onSelect: (value: "none" | string) => void;
  onCreateProject: (name: string) => Promise<void>;
  listClassName?: string;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const { matches, createName } = useMemo(
    () => projectPickerState(projects, query),
    [projects, query],
  );
  const showNoProject = query.trim() === "";

  const handleCreate = async () => {
    if (!createName || busy) return;
    setBusy(true);
    try {
      await onCreateProject(createName);
      setQuery("");
    } catch {
      // Parent surfaces the error toast; keep the typed name for retry.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Command shouldFilter={false} className="bg-transparent">
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search or create…"
        disabled={busy}
      />
      <CommandList className={listClassName}>
        {matches.length === 0 && !showNoProject && !createName && (
          <CommandEmpty>No matching projects</CommandEmpty>
        )}
        <CommandGroup>
          {showNoProject && (
            <CommandItem value="__none__" onSelect={() => onSelect("none")}>
              <FolderSimple aria-hidden />
              <span className="truncate">No project</span>
              {value === "none" && <Check aria-hidden className="ml-auto size-4 text-foreground" />}
            </CommandItem>
          )}
          {matches.map((project) => (
            <CommandItem key={project.id} value={project.id} onSelect={() => onSelect(project.id)}>
              <FolderSimple aria-hidden />
              <span className="truncate">{project.name}</span>
              {project.id === value && (
                <Check aria-hidden className="ml-auto size-4 text-foreground" />
              )}
            </CommandItem>
          ))}
        </CommandGroup>
        {createName && (
          <>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="__create__"
                onSelect={() => void handleCreate()}
                disabled={busy}
                className="text-foreground"
              >
                {busy ? <Spinner className="size-4" label="Creating project" /> : <Plus aria-hidden />}
                <span className="truncate">
                  Create “<span className="font-medium">{createName}</span>”
                </span>
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );
}
