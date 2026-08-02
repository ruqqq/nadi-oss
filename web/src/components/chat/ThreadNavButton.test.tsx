// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadNavButton } from "./ThreadNavButton";

// This project doesn't enable testing-library's auto-cleanup, so an earlier
// render would otherwise still be mounted and answer the next test's queries.
afterEach(cleanup);

describe("ThreadNavButton", () => {
  it("offers the rail toggle for a thread opened from the rail", async () => {
    const onToggleThreads = vi.fn();
    const onBack = vi.fn();
    render(<ThreadNavButton backTo={null} onBack={onBack} onToggleThreads={onToggleThreads} />);

    const button = screen.getByRole("button", { name: "Show chats" });
    await userEvent.click(button);
    expect(onToggleThreads).toHaveBeenCalledOnce();
    expect(onBack).not.toHaveBeenCalled();
  });

  it("offers a back button naming where it returns, for a run thread", async () => {
    const onToggleThreads = vi.fn();
    const onBack = vi.fn();
    render(
      <ThreadNavButton
        backTo="/automata/auto_x"
        onBack={onBack}
        onToggleThreads={onToggleThreads}
      />,
    );

    // The rail toggle must be gone, not merely hidden behind the back button.
    expect(screen.queryByRole("button", { name: "Show chats" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Back to automaton" }));
    expect(onBack).toHaveBeenCalledOnce();
    expect(onToggleThreads).not.toHaveBeenCalled();
  });

  // Hiding this on `md` rather than `wide` stranded a phone in landscape (932px
  // wide, so past md) with no pinned rail AND no toggle — reachable only by
  // edge-drag. It must hide on exactly the gate that pins the rail.
  it("hides on the same gate that pins the rail, not on md", () => {
    const { rerender } = render(
      <ThreadNavButton backTo={null} onBack={vi.fn()} onToggleThreads={vi.fn()} />,
    );
    expect(screen.getByRole("button").className).toContain("wide:hidden");
    expect(screen.getByRole("button").className).not.toContain("md:hidden");

    rerender(
      <ThreadNavButton backTo="/automata/auto_x" onBack={vi.fn()} onToggleThreads={vi.fn()} />,
    );
    expect(screen.getByRole("button").className).toContain("wide:hidden");
    expect(screen.getByRole("button").className).not.toContain("md:hidden");
  });
});

describe("ThreadNavButton unread badge", () => {
  const noop = () => {};

  it("names the badge instead of leaving it as decoration", () => {
    render(
      <ThreadNavButton
        backTo={null}
        onBack={noop}
        onToggleThreads={noop}
        badge={{ kind: "unread", label: "Unread chats" }}
      />,
    );

    // The dot is aria-hidden, so the state has to reach the accessible name or
    // it does not exist for a screen reader.
    expect(screen.getByRole("button", { name: "Show chats, unread chats" })).toBeTruthy();
  });

  it("says who is waiting when a thread needs the user", () => {
    render(
      <ThreadNavButton
        backTo={null}
        onBack={noop}
        onToggleThreads={noop}
        badge={{ kind: "attention", label: "Waiting for you" }}
      />,
    );

    expect(screen.getByRole("button", { name: "Show chats, waiting for you" })).toBeTruthy();
  });

  it("leaves the plain label alone with nothing waiting", () => {
    render(<ThreadNavButton backTo={null} onBack={noop} onToggleThreads={noop} badge={null} />);

    expect(screen.getByRole("button", { name: "Show chats" })).toBeTruthy();
  });

  it("never badges the Back button — it leads somewhere else entirely", () => {
    render(
      <ThreadNavButton
        backTo="/automata/auto_x"
        onBack={noop}
        onToggleThreads={noop}
        badge={{ kind: "attention", label: "Waiting for you" }}
      />,
    );

    const button = screen.getByRole("button", { name: "Back to automaton" });
    expect(button.querySelector("span[aria-hidden]")).toBeNull();
  });
});
