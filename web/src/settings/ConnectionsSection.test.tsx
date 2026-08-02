// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionsSection } from "./ConnectionsSection";
import * as api from "../github-api";

afterEach(() => {
  cleanup();
});

describe("ConnectionsSection", () => {
  it("shows connected installations and a Connect button when configured", async () => {
    vi.spyOn(api, "getGithubSettings").mockResolvedValue({
      configured: true,
      installations: [
        {
          id: "ghi_1",
          installationId: 42,
          accountLogin: "acme",
          accountType: "org",
          repositorySelection: "all",
          status: "active",
          connectedByUserId: "u1",
          updatedAt: Date.now(),
        },
      ],
    });
    render(<ConnectionsSection />);
    expect(await screen.findByText("acme")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /connect/i })).toHaveAttribute(
      "href",
      api.GITHUB_CONNECT_PATH,
    );
  });

  it("shows a not-configured state when the App is unset", async () => {
    vi.spyOn(api, "getGithubSettings").mockResolvedValue({ configured: false, installations: [] });
    render(<ConnectionsSection />);
    await waitFor(() => expect(screen.getByText(/not configured/i)).toBeInTheDocument());
  });
});
