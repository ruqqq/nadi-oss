import { useState } from "react";
import { CaretDown, FolderSimple } from "../../icons";
import { useMediaQuery } from "../../lib/use-media-query";
import { useVisualViewportInset } from "../../lib/use-visual-viewport-inset";
import type { ProjectSummary } from "../../projects-api";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "../ui/sheet";
import { ProjectCommand } from "./ProjectCommand";

/**
 * Composer project picker: a searchable combobox with inline, name-only
 * quick-add. Opens as an anchored Popover on desktop and a bottom Sheet on
 * mobile (the shared responsive-surface convention; see AGENTS.md).
 *
 * The parent owns project state; this component reports a selection via
 * onValueChange and a quick-add via onCreateProject (which creates the
 * project, assigns it, and refreshes the list). onCreateProject rejects on
 * failure so the surface stays open with the typed name for retry.
 */
export function ProjectPicker({
  value,
  projects,
  onValueChange,
  onCreateProject,
  disabled,
  compact,
}: {
  value: "none" | string;
  projects: ProjectSummary[];
  onValueChange: (value: "none" | string) => void;
  onCreateProject: (name: string) => Promise<void>;
  disabled?: boolean;
  /** Shrinks the trigger to the composer's control height (h-8) so the picker
   *  lines up with the + / model / mic controls when docked on the composer.
   *  Defaults to the taller form-field height (h-9) used in detail sheets. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isMobile = useMediaQuery("(max-width: 640px)");
  // Track the on-screen keyboard so the bottom sheet lifts above it instead of
  // hiding behind it (only while the sheet is open).
  const viewport = useVisualViewportInset(open && isMobile);

  const selected = value === "none" ? null : (projects.find((p) => p.id === value) ?? null);
  const label = selected ? selected.name : "No project";

  const handleSelect = (next: "none" | string) => {
    onValueChange(next);
    setOpen(false);
  };

  const trigger = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      aria-label={`Project: ${label}`}
      className={`${compact ? "h-8 min-w-0" : "h-9"} max-w-[12rem] justify-between gap-2 font-normal`}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <FolderSimple aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{label}</span>
      </span>
      <CaretDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </Button>
  );

  if (isMobile) {
    // Lift the sheet above the keyboard and cap its height to the visible
    // viewport so the search field and the create row stay on screen.
    const keyboard = viewport?.keyboard ?? 0;
    const sheetStyle =
      keyboard > 0
        ? { bottom: `${keyboard}px`, maxHeight: `${viewport?.height ?? 0}px` }
        : undefined;
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent
          side="bottom"
          style={sheetStyle}
          className="flex max-h-[70vh] flex-col gap-0 p-0 pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHeader className="shrink-0 border-b py-4 pr-12 pl-5 text-left">
            <SheetTitle className="text-base">Project</SheetTitle>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* Remount on close so the next open starts from an empty query. */}
            <ProjectCommand
              key={open ? "open" : "closed"}
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
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <ProjectCommand
          key={open ? "open" : "closed"}
          value={value}
          projects={projects}
          onSelect={handleSelect}
          onCreateProject={onCreateProject}
        />
      </PopoverContent>
    </Popover>
  );
}
