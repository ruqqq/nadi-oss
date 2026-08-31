// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const getUserPreferences = vi.fn();
const saveUserPreferences = vi.fn();

vi.mock("../user-preferences-api", () => ({ getUserPreferences, saveUserPreferences }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { ReasoningDisplaySection } = await import("./ReasoningDisplaySection");

afterEach(() => cleanup());

describe("ReasoningDisplaySection", () => {
  beforeEach(() => {
    getUserPreferences.mockReset();
    saveUserPreferences.mockReset();
  });

  it("reflects the stored preference", async () => {
    getUserPreferences.mockResolvedValue({ showReasoning: false });
    render(<ReasoningDisplaySection />);
    const toggle = await screen.findByRole("switch", { name: "Show reasoning" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("saves when toggled", async () => {
    getUserPreferences.mockResolvedValue({ showReasoning: false });
    saveUserPreferences.mockResolvedValue({ showReasoning: true });
    render(<ReasoningDisplaySection />);
    const toggle = await screen.findByRole("switch", { name: "Show reasoning" });
    await userEvent.click(toggle);
    await waitFor(() => expect(saveUserPreferences).toHaveBeenCalledWith(true));
  });

  it("surfaces a load failure with a retry", async () => {
    getUserPreferences.mockRejectedValue(new Error("nope"));
    render(<ReasoningDisplaySection />);
    expect(await screen.findByRole("alert")).toHaveTextContent("nope");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
