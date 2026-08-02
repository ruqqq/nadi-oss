import type { ReactNode } from "react";
import { MapTrifold, Notebook, Sun } from "../../icons";

export type PromptSuggestion = {
  icon: ReactNode;
  /** The button's visible verb phrase. */
  label: string;
  /**
   * Dropped into the composer, cursor at the end. A trailing space marks a
   * running start the user finishes (the trip needs a destination); a complete
   * sentence is ready to send as-is.
   */
  prompt: string;
};

/**
 * Starters for an empty new chat. The trip is a running start (needs a
 * destination); the brief and reflection are complete prompts the user can send
 * straight away.
 */
export const NEW_CHAT_SUGGESTIONS: PromptSuggestion[] = [
  {
    icon: <MapTrifold aria-hidden className="size-4 shrink-0" />,
    label: "Plan a trip itinerary",
    prompt: "Plan an itinerary for a trip to ",
  },
  {
    icon: <Sun aria-hidden className="size-4 shrink-0" />,
    label: "Get a daily morning brief",
    prompt: "Set up a daily morning brief with my calendar, the weather, and the top headlines.",
  },
  {
    icon: <Notebook aria-hidden className="size-4 shrink-0" />,
    label: "Set a recurring reflection",
    prompt:
      "Set up a recurring reflection that asks me what went well today and what I'd change tomorrow.",
  },
];

/**
 * A short list of tappable starters, styled as the rail's destination rows are
 * (RailDestination). Left-aligned and content-width: each button's hit box is
 * only as wide as its label, so the empty space beside a starter isn't a live
 * target, and the buttons' left edge lines up with the composer/project picker.
 */
export function PromptSuggestions({
  suggestions,
  onPick,
  disabled,
}: {
  suggestions: PromptSuggestion[];
  onPick: (prompt: string) => void;
  disabled?: boolean;
}) {
  if (suggestions.length === 0) return null;
  return (
    <ul className="flex flex-col items-start gap-0.5">
      {suggestions.map((suggestion) => (
        <li key={suggestion.label}>
          <button
            type="button"
            onClick={() => onPick(suggestion.prompt)}
            disabled={disabled}
            className="-mx-2 flex w-fit items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-muted-foreground text-sm transition-colors hover:bg-accent/60 hover:text-foreground disabled:opacity-50"
          >
            {suggestion.icon}
            <span className="truncate">{suggestion.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
