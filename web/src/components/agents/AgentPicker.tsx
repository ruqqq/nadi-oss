import { useMemo, useState } from "react";
import { ArrowSquareOut, CaretDown, Check, Robot } from "../../icons";
import { useMediaQuery } from "../../lib/use-media-query";
import { useVisualViewportInset } from "../../lib/use-visual-viewport-inset";
import type { AgentListItem } from "../../agents-api";
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
 * Choosing an agent chooses its instructions, its default model and its
 * machine, so the picker sits beside the project picker rather than buried in a
 * thread's details.
 *
 * There are TWO exports on purpose, over one shared body:
 *
 * - {@link AgentPicker} — `value: string`. A thread ALWAYS has an agent, so
 *   "no agent" is not a state it can be put into. The picker cannot offer it
 *   and the callback cannot report it.
 * - {@link AgentOverridePicker} — `value: string | null`, where `null` is
 *   "inherit". That is a real state for a new-chat or automaton OVERRIDE, which
 *   sits on top of the project's default rather than replacing it.
 *
 * Making it two components rather than one with a flag is what keeps the
 * impossible state unrepresentable instead of merely unreachable: the switch
 * flow that used to send `{agentId: null}` and get a 400 back cannot be written.
 */
export function AgentPicker(props: {
  value: string;
  agents: AgentListItem[];
  /**
   * Label for the current value when the list doesn't carry it — a disabled
   * picker never opens its list, so its caller can name the selection directly
   * instead of waiting on a fetch that would flash a placeholder first.
   */
  selectedName?: string;
  onValueChange: (agentId: string) => void;
  onManageAgents?: () => void;
  disabled?: boolean;
  /** Shrinks the trigger to the composer's control height (h-8). */
  compact?: boolean;
}) {
  const { value, onValueChange, ...rest } = props;
  return (
    <AgentPickerBase
      {...rest}
      value={value}
      inheritLabel={null}
      onValueChange={(next) => {
        // `inheritLabel === null` means the base never renders the inherit row,
        // so `next` is always an agent id here.
        if (next !== null) onValueChange(next);
      }}
    />
  );
}

export function AgentOverridePicker(props: {
  /** `null` = inherit whatever the project's default agent is. */
  value: string | null;
  agents: AgentListItem[];
  selectedName?: string;
  /** Text for the inherit option and for the trigger when nothing is picked. */
  inheritLabel: string;
  onValueChange: (agentId: string | null) => void;
  onManageAgents?: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return <AgentPickerBase {...props} />;
}

function AgentPickerBase({
  value,
  agents,
  selectedName,
  inheritLabel,
  onValueChange,
  onManageAgents,
  disabled,
  compact,
}: {
  value: string | null;
  agents: AgentListItem[];
  selectedName?: string;
  /** null suppresses the inherit option entirely. */
  inheritLabel: string | null;
  onValueChange: (agentId: string | null) => void;
  onManageAgents?: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const isMobile = useMediaQuery("(max-width: 640px)");
  // Track the on-screen keyboard so the bottom sheet lifts above it instead of
  // hiding behind it (only while the sheet is open).
  const viewport = useVisualViewportInset(open && isMobile);

  const selected = value === null ? null : (agents.find((agent) => agent.id === value) ?? null);
  const fallbackLabel = inheritLabel ?? "Choose an agent";
  const label = selected?.name ?? (value === null ? fallbackLabel : (selectedName ?? fallbackLabel));
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? agents.filter((agent) => agent.name.toLowerCase().includes(needle)) : agents;
  }, [agents, query]);
  const showInherit = inheritLabel !== null && query.trim() === "";

  const reset = () => {
    setOpen(false);
    setQuery("");
  };

  const handleSelect = (next: string | null) => {
    onValueChange(next);
    reset();
  };

  const handleManage = () => {
    reset();
    onManageAgents?.();
  };

  const trigger = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      aria-label={`Agent: ${label}`}
      className={`${compact ? "h-8 min-w-0" : "h-9"} max-w-[12rem] justify-between gap-2 font-normal`}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Robot aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{label}</span>
      </span>
      <CaretDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </Button>
  );

  const renderBody = (listClassName?: string) => (
    <Command shouldFilter={false} className="bg-transparent">
      <CommandInput value={query} onValueChange={setQuery} placeholder="Search agents…" />
      <CommandList className={listClassName}>
        {matches.length === 0 && !showInherit && <CommandEmpty>No matching agents</CommandEmpty>}
        <CommandGroup>
          {showInherit && (
            <CommandItem value="__inherit__" onSelect={() => handleSelect(null)}>
              <Robot aria-hidden />
              <span className="truncate">{inheritLabel}</span>
              {value === null && <Check aria-hidden className="ml-auto size-4 text-foreground" />}
            </CommandItem>
          )}
          {matches.map((agent) => (
            <CommandItem key={agent.id} value={agent.id} onSelect={() => handleSelect(agent.id)}>
              <Robot aria-hidden />
              <span className="truncate">{agent.name}</span>
              {agent.id === value && (
                <Check aria-hidden className="ml-auto size-4 text-foreground" />
              )}
            </CommandItem>
          ))}
        </CommandGroup>
        {onManageAgents && (
          <>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="__manage__"
                onSelect={handleManage}
                className="text-muted-foreground"
              >
                <ArrowSquareOut aria-hidden />
                <span className="truncate">Manage agents</span>
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
            <SheetTitle className="text-base">Agent</SheetTitle>
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
