// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NEW_CHAT_SUGGESTIONS, PromptSuggestions } from "./PromptSuggestions";

afterEach(cleanup);

const SAMPLE = [
  { icon: null, label: "Plan a trip", prompt: "Plan an itinerary for a trip to " },
  { icon: null, label: "Morning brief", prompt: "Set up a daily morning brief covering " },
];

describe("PromptSuggestions", () => {
  it("renders one button per suggestion", () => {
    render(<PromptSuggestions suggestions={SAMPLE} onPick={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Plan a trip" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Morning brief" })).toBeTruthy();
  });

  it("hands the picked suggestion's prompt to onPick — the label is not the prompt", async () => {
    const onPick = vi.fn();
    render(<PromptSuggestions suggestions={SAMPLE} onPick={onPick} />);
    await userEvent.click(screen.getByRole("button", { name: "Plan a trip" }));
    expect(onPick).toHaveBeenCalledWith("Plan an itinerary for a trip to ");
  });

  it("renders nothing for an empty list, rather than an empty container", () => {
    const { container } = render(<PromptSuggestions suggestions={[]} onPick={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("does not fire onPick while disabled", async () => {
    const onPick = vi.fn();
    render(<PromptSuggestions suggestions={SAMPLE} onPick={onPick} disabled />);
    await userEvent.click(screen.getByRole("button", { name: "Plan a trip" }));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("labels never double as prompts", () => {
    for (const s of NEW_CHAT_SUGGESTIONS) expect(s.label).not.toBe(s.prompt);
  });

  it("keeps the trip a running start but ships the rest complete and sendable", () => {
    // The trip needs a destination, so its prompt lands mid-sentence.
    expect(NEW_CHAT_SUGGESTIONS[0]?.prompt.endsWith(" ")).toBe(true);
    // The others are complete sentences the user can send as-is.
    for (const s of NEW_CHAT_SUGGESTIONS.slice(1)) {
      expect(s.prompt.endsWith(" ")).toBe(false);
      expect(s.prompt.trim().endsWith(".")).toBe(true);
    }
  });
});
