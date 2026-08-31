import { useMemo, useState } from "react";
import { ArrowSquareOut, CaretDown, Check, Toolbox } from "../../icons";
import { useMediaQuery } from "../../lib/use-media-query";
import { useVisualViewportInset } from "../../lib/use-visual-viewport-inset";
import type { AgentSummary } from "../../agents-api";
import { Button } from "../ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "../ui/sheet";

/**
 * Composer / thread-header workbench picker: a searchable combobox mirroring
 * ProjectPicker's surface (anchored Popover on desktop, bottom Sheet on
 * mobile). Unlike ProjectPicker there is no inline quick-add — workbenches
 * are configured in Settings, so the list ends with a "Manage workbenches"
 * link instead.
 */
export function WorkbenchPicker({
  value,
  workbenches,
  selectedName,
  emptyLabel = "No workbench",
  onValueChange,
  onManageWorkbenches,
  disabled,
  compact,
}: {
  value: "none" | string;
  workbenches: AgentSummary[];
  /**
   * Label for the current value when the list doesn't carry it — a disabled
   * picker never opens its list, so its caller can name the selection directly
   * instead of waiting on a fetch that would flash the empty label first.
   */
  selectedName?: string;
  /**
   * Text for the empty ("none") option and the trigger when nothing is picked —
   * e.g. "Inherit from project" in the composer. Defaults to "No workbench".
   */
  emptyLabel?: string;
  onValueChange: (value: "none" | string) => void;
  onManageWorkbenches?: () => void;
  disabled?: boolean;
  /** Shrinks the trigger to the composer's control height (h-8). */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const isMobile = useMediaQuery("(max-width: 640px)");
  // Track the on-screen keyboard so the bottom sheet lifts above it instead of
  // hiding behind it (only while the sheet is open).
  const viewport = useVisualViewportInset(open && isMobile);

  const selected = value === "none" ? null : (workbenches.find((w) => w.id === value) ?? null);
  const label = selected?.name ?? (value === "none" ? emptyLabel : (selectedName ?? emptyLabel));
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? workbenches.filter((workbench) => workbench.name.toLowerCase().includes(needle)) : workbenches;
  }, [workbenches, query]);
  const showNoWorkbench = query.trim() === "";

  const reset = () => {
    setOpen(false);
    setQuery("");
  };

  const handleSelect = (next: "none" | string) => {
    onValueChange(next);
    reset();
  };

  const handleManage = () => {
    reset();
    onManageWorkbenches?.();
  };

  const trigger = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      aria-label={`Workbench: ${label}`}
      className={`${compact ? "h-8 min-w-0" : "h-9"} max-w-[12rem] justify-between gap-2 font-normal`}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Toolbox aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{label}</span>
      </span>
      <CaretDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </Button>
  );

  const renderBody = (listClassName?: string) => (
    <Command shouldFilter={false} className="bg-transparent">
      <CommandInput value={query} onValueChange={setQuery} placeholder="Search workbenches…" />
      <CommandList className={listClassName}>
        {matches.length === 0 && !showNoWorkbench && (
          <CommandEmpty>No matching workbenches</CommandEmpty>
        )}
        <CommandGroup>
          {showNoWorkbench && (
            <CommandItem value="__none__" onSelect={() => handleSelect("none")}>
              <Toolbox aria-hidden />
              <span className="truncate">{emptyLabel}</span>
              {value === "none" && <Check aria-hidden className="ml-auto size-4 text-foreground" />}
            </CommandItem>
          )}
          {matches.map((workbench) => (
            <CommandItem
              key={workbench.id}
              value={workbench.id}
              onSelect={() => handleSelect(workbench.id)}
            >
              <Toolbox aria-hidden />
              <span className="truncate">{workbench.name}</span>
              {workbench.id === value && (
                <Check aria-hidden className="ml-auto size-4 text-foreground" />
              )}
            </CommandItem>
          ))}
        </CommandGroup>
        {onManageWorkbenches && (
          <>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="__manage__"
                onSelect={handleManage}
                className="text-muted-foreground"
              >
                <ArrowSquareOut aria-hidden />
                <span className="truncate">Manage workbenches</span>
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );

  if (isMobile) {
    // Lift the sheet above the keyboard and cap its height to the visible
    // viewport so the search field and the manage row stay on screen.
    const keyboard = viewport?.keyboard ?? 0;
    const sheetStyle =
      keyboard > 0
        ? { bottom: `${keyboard}px`, maxHeight: `${viewport?.height ?? 0}px` }
        : undefined;
    return (
      <Sheet
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent
          side="bottom"
          style={sheetStyle}
          className="flex max-h-[70vh] flex-col gap-0 p-0 pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHeader className="shrink-0 border-b py-4 pr-12 pl-5 text-left">
            <SheetTitle className="text-base">Workbench</SheetTitle>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {renderBody("min-h-0 flex-1 max-h-none")}
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        {renderBody()}
      </PopoverContent>
    </Popover>
  );
}
