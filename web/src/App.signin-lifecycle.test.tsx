// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getBootstrap: vi.fn(),
  getSession: vi.fn(),
  requestEmailOtp: vi.fn(),
  signInWithEmailOtp: vi.fn(),
}));

vi.mock("./bootstrap-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bootstrap-api")>()),
  getBootstrap: mocks.getBootstrap,
}));

vi.mock("./auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-api")>()),
  getSession: mocks.getSession,
  requestEmailOtp: mocks.requestEmailOtp,
  signInWithEmailOtp: mocks.signInWithEmailOtp,
}));

vi.mock("./lib/bootstrap-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/bootstrap-cache")>()),
  readCachedBootstrap: () => null,
  writeCachedBootstrap: vi.fn(),
}));

vi.mock("./Settings", () => ({
  Settings: ({ workbenchNetworkAllowlistEnabled }: { workbenchNetworkAllowlistEnabled: boolean }) => (
    <div data-testid="allowlist-capability">
      {workbenchNetworkAllowlistEnabled ? "enabled" : "disabled"}
    </div>
  ),
}));

import App from "./App";

const authenticatedSession = {
  authenticated: true as const,
  user: { id: "user_1", email: "you@example.com" },
};

const authenticatedBootstrap = {
  session: authenticatedSession,
  settings: {
    workspace: { id: "workspace_1" },
    agent: {
      provider: "openai-oauth",
      model: "gpt-5.5",
      modelInputModalities: ["text"],
      showReasoning: false,
    },
    providers: [{ provider: "openai-oauth", usable: true }],
  },
  threads: [],
  threadsNextCursor: null,
  projects: [],
  voiceEnabled: false,
  workersAiEnabled: false,
  feedbackAdminEnabled: false,
  backgroundWorkEnabled: false,
  workbenchNetworkAllowlistEnabled: true,
};

describe("App sign-in lifecycle", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/signin");
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    mocks.getBootstrap
      .mockResolvedValueOnce({
        ...authenticatedBootstrap,
        session: { authenticated: false },
        settings: null,
        threads: [],
        workbenchNetworkAllowlistEnabled: false,
      })
      .mockResolvedValueOnce(authenticatedBootstrap);
    mocks.requestEmailOtp.mockResolvedValue(undefined);
    mocks.signInWithEmailOtp.mockResolvedValue(undefined);
    mocks.getSession.mockResolvedValue(authenticatedSession);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("refreshes workspace capabilities after signing in", async () => {
    render(<App />);

    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "you@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(mocks.getBootstrap).toHaveBeenCalledTimes(2));

    window.history.pushState(null, "", "/settings/workbenches");
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect((await screen.findByTestId("allowlist-capability")).textContent).toBe("enabled");
  });
});
