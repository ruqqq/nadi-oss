import { CaretDown, EffortGauge } from "@/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { EffortOption } from "@/lib/reasoning-effort";
import type { ReasoningEffort } from "@/settings-api";

const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** Speed/cost cue, right-aligned in the menu. Deliberately not a token count:
 *  the budget differs per provider, so a number would be wrong on most of them. */
const EFFORT_HINT: Partial<Record<ReasoningEffort, string>> = {
  off: "fastest",
  high: "slowest",
};

/**
 * Thinking-effort control for the composer footer.
 *
 * Icon-only by design — the level is carried by the gauge, not by text, so the
 * control stays narrow enough to leave the model picker its full width on a
 * phone. The level is still announced: `aria-label` names it, and the menu is a
 * normal listbox of four items.
 *
 * Rendering is the CALLER's decision (see `shouldOfferEffortControl`): this
 * component assumes it is only mounted for a model known to reason on a provider
 * that can express effort.
 */
export function EffortDial({
  effort,
  options,
  onEffortChange,
  disabled,
  triggerId,
}: {
  effort: ReasoningEffort;
  /** The levels THIS model can be set to, with its own words for them. */
  options: EffortOption[];
  onEffortChange: (effort: ReasoningEffort) => void;
  disabled?: boolean;
  triggerId?: string;
}) {
  // Nothing tunable — the caller should not have mounted us, but never render a
  // menu with no choices in it.
  if (options.length === 0) return null;
  // The stored level may not be one this model offers (the user picked a
  // different model). Show the nearest one that is actually on the menu.
  const active = options.some((option) => option.level === effort)
    ? effort
    : (options.find((option) => option.level !== "off")?.level ?? "off");
  const activeLabel = options.find((option) => option.level === active)?.label ?? EFFORT_LABEL[active];
  return (
    <DropdownMenu>
      {/* `disabled` must be on the TRIGGER, not only on the child button: with
          asChild, Radix reads its own prop to decide whether to open, so a
          disabled child still opens the menu. */}
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          id={triggerId}
          disabled={disabled}
          aria-label={`Thinking effort: ${activeLabel}`}
          className="flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none aria-expanded:bg-accent aria-expanded:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <EffortGauge
            level={active}
            className={cn("size-[1.05rem]", active !== "off" && "text-primary")}
          />
          <CaretDown className="size-3 shrink-0 opacity-60" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-muted-foreground text-xs uppercase tracking-wider">
          Thinking
        </DropdownMenuLabel>
        {options.map((option) => (
          <DropdownMenuItem
            key={option.level}
            onSelect={() => onEffortChange(option.level)}
            className={cn(option.level === active && "bg-accent")}
          >
            <EffortGauge
              level={option.level}
              className={cn(
                "size-4",
                option.level === active ? "text-primary" : "text-muted-foreground",
              )}
            />
            <span className="flex-1">{option.label}</span>
            {EFFORT_HINT[option.level] && (
              <span className="text-muted-foreground text-xs">{EFFORT_HINT[option.level]}</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
