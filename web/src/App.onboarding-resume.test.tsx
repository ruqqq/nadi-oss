// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MCP_RETURN_PATH_KEY } from "./lib/settings-routes";

const mocks = vi.hoisted(() => ({
  getBootstrap: vi.fn(),
}));

// The revalidation round trip must never resolve in this test: the assertion
// is about what the FIRST render shows, driven entirely by the cached
// bootstrap + the restored URL. A resolved fetch would just recompute the
// same onboarding state a second time and add nothing but flake risk.
vi.mock("./bootstrap-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bootstrap-api")>()),
  getBootstrap: mocks.getBootstrap,
}));

const cachedBootstrap = {
  session: {
    authenticated: true as const,
    user: { id: "user_1", email: "you@example.com" },
  },
  settings: {
    workspace: { id: "workspace_1" },
    agent: {
      provider: "openai-oauth",
      model: "gpt-5.5",
      modelInputModalities: ["text"],
      showReasoning: false,
    },
    // A usable provider AND a thread both independently mean
    // `deriveNeedsOnboarding` says "done" — the only reason the wizard should
    // show is the restored `onboarding=force` forcing it.
    providers: [{ provider: "openai-oauth", usable: true }],
  },
  threads: [{ threadId: "thr_1", workspaceId: "workspace_1" }],
  threadsNextCursor: null,
  projects: [],
  voiceEnabled: false,
  workersAiEnabled: false,
  feedbackAdminEnabled: false,
  backgroundWorkEnabled: false,
  workbenchNetworkAllowlistEnabled: false,
};

vi.mock("./lib/bootstrap-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/bootstrap-cache")>()),
  readCachedBootstrap: () => cachedBootstrap,
  writeCachedBootstrap: vi.fn(),
}));

import App from "./App";

describe("App onboarding resume after an MCP OAuth redirect", () => {
  beforeEach(() => {
    // The OAuth provider redirects to the bare app root — the stashed path
    // (with its query string) lives only in sessionStorage until restored.
    window.history.replaceState(null, "", "/");
    sessionStorage.setItem(MCP_RETURN_PATH_KEY, "/?onboarding=force&step=empower");

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
    // Never resolves: nothing here should depend on the revalidation round trip.
    mocks.getBootstrap.mockReturnValue(new Promise(() => {}));
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("lands back on the wizard's empower step, not chat", async () => {
    render(<App />);

    // Proves the restore ran before `computeOnboarding` read the URL: a user
    // with a usable provider and an existing thread would otherwise resolve
    // straight to "done" and never see the wizard at all.
    expect(await screen.findByText("Empower your agent")).toBeTruthy();

    // The stashed path is consumed and rewritten into the live URL as a bare
    // pathname + query — never left dangling in storage.
    expect(sessionStorage.getItem(MCP_RETURN_PATH_KEY)).toBeNull();
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("?onboarding=force&step=empower");
  });
});
