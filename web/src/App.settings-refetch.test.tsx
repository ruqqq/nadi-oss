// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, act } from "@testing-library/react";
import type { AgentSettingsResponse } from "./settings-api";

const getDefaultAgentSettings = vi.fn();

vi.mock("./settings-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settings-api")>()),
  getDefaultAgentSettings: (...args: unknown[]) => getDefaultAgentSettings(...args),
}));

vi.mock("./workbenches-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workbenches-api")>()),
  listWorkbenches: () => Promise.resolve([]),
}));

vi.mock("./lib/bootstrap-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/bootstrap-cache")>()),
  readCachedBootstrap: () => null,
}));

import { ChatApp } from "./App";

function settingsWith(anthropicModels: AgentSettingsResponse["providers"][number]["whitelistModels"]) {
  return {
    workspace: { id: "ws_1", name: "Workspace" },
    agent: {
      id: "agent_1",
      name: "Nadi",
      systemPrompt: "",
      provider: "anthropic",
      model: "claude-opus-5",
      modelInputModalities: ["text"],
      showReasoning: false,
    },
    providers: [
      {
        provider: "anthropic",
        displayName: "Anthropic",
        defaultSecretName: "provider:anthropic",
        configuredSecretName: "provider:anthropic",
        secretPresent: true,
        secretUpdatedAt: null,
        previewAvailable: true,
        endpointConfig: { baseUrl: "", auth: "bearer", body: {} },
        usable: true,
        whitelistModels: anthropicModels,
      },
    ],
  } as unknown as AgentSettingsResponse;
}

function navigate(path: string) {
  act(() => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  getDefaultAgentSettings.mockReset();
  // jsdom has no matchMedia; useMediaQuery reads it synchronously on mount.
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
  // Nothing else this test drives should reach the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("agent settings refetch on leaving Settings", () => {
  it("re-reads settings when Settings closes, so a whitelist edit reaches the composer", async () => {
    // Settings is a route, not a page load, so without this the composer keeps
    // offering the pre-edit model list until a hard refresh.
    getDefaultAgentSettings.mockResolvedValue(settingsWith(null));
    render(
      <ChatApp
        consentWorkspaceId={null}
        user={{ id: "u1", email: "you@example.com" } as never}
        initialProjects={[]}
        initialThreads={[]}
        initialThreadsNextCursor={null}
        onActiveWorkspaceChange={() => {}}
        onSignOut={() => {}}
        voiceEnabled={false}
        backgroundWorkEnabled={false}
        feedbackAdminEnabled={false}
      />,
    );

    await waitFor(() => {
      expect(getDefaultAgentSettings).toHaveBeenCalledTimes(1);
    });

    navigate("/settings/providers/anthropic");
    // No refetch while Settings is open — Settings loads its own copy.
    await waitFor(() => {
      expect(getDefaultAgentSettings).toHaveBeenCalledTimes(1);
    });

    navigate("/");
    await waitFor(() => {
      expect(getDefaultAgentSettings).toHaveBeenCalledTimes(2);
    });
  });
});
