// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentSettingsResponse,
  ProviderModelCatalog,
  ProviderSettingsView,
} from "../settings-api";
import { SettingsFooterContext } from "./footer-slot";

// The provider detail's Save/preview are the only side-effecting calls; mock
// them so the section renders without a Worker.
const api = vi.hoisted(() => ({
  saveProviderSecret: vi.fn(),
  saveProviderConfig: vi.fn(),
  previewProviderSecret: vi.fn(),
  // The Models card loads a catalog on mount; this section's tests are about
  // the key/endpoint form, so keep them off the network.
  // Annotated, not inferred: without this the stub's empty array types `models`
  // as never[] and pins `source` to "static", so any test supplying a real
  // catalog fails to typecheck.
  getProviderModelCatalog: vi.fn(
    async (): Promise<ProviderModelCatalog> => ({
      provider: "anthropic",
      models: [],
      source: "static",
      fetchedAt: 0,
      stale: false,
    }),
  ),
  saveProviderModelWhitelist: vi.fn(),
}));

vi.mock("../settings-api", async () => {
  const actual = await vi.importActual<typeof import("../settings-api")>("../settings-api");
  return { ...actual, ...api };
});

import { ProvidersSection } from "./ProvidersSection";

// Mirror the Settings shell: ProviderDetail portals its Save into the shell's
// footer slot, so an isolated render must supply that slot or Save never mounts.
function renderSection(ui: ReactElement) {
  function Harness({ children }: { children: ReactNode }) {
    const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);
    return (
      <>
        <SettingsFooterContext.Provider value={footerEl}>{children}</SettingsFooterContext.Provider>
        <div ref={setFooterEl} />
      </>
    );
  }
  return render(<Harness>{ui}</Harness>);
}

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false) as never;
  Element.prototype.scrollIntoView = vi.fn() as never;
  // Radix's Checkbox measures its hidden bubble input. Without this the
  // add-model form in the Models card throws and takes the whole pane with it.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

beforeEach(() => {
  // Desktop path: master-detail renders both panes at once.
  window.matchMedia = (query: string) =>
    ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ANTHROPIC: ProviderSettingsView = {
  provider: "anthropic",
  displayName: "Anthropic",
  defaultSecretName: "ANTHROPIC_API_KEY",
  configuredSecretName: "ANTHROPIC_API_KEY",
  secretPresent: true,
  secretUpdatedAt: "2026-07-01T09:00:00.000Z",
  previewAvailable: true,
  endpointConfig: { baseUrl: "", proxyUrl: "", auth: "bearer", body: {} },
  usable: true,
};

const OPENAI: ProviderSettingsView = {
  ...ANTHROPIC,
  provider: "openai",
  displayName: "OpenAI",
  defaultSecretName: "OPENAI_API_KEY",
  configuredSecretName: "OPENAI_API_KEY",
  secretPresent: false,
  secretUpdatedAt: null,
  previewAvailable: false,
  usable: false,
};

function settingsWith(providers: ProviderSettingsView[]): AgentSettingsResponse {
  // The section only reads `.providers`; the rest of the response is irrelevant.
  return { providers } as AgentSettingsResponse;
}

describe("ProvidersSection", () => {
  it("shows a configured indicator per provider and selects on click", async () => {
    const user = userEvent.setup();
    const onSelectProvider = vi.fn();

    renderSection(
      <ProvidersSection
        settings={settingsWith([ANTHROPIC, OPENAI])}
        loadError={null}
        onRetry={() => {}}
        onProviderChanged={() => {}}
        selectedId={null}
        onSelectProvider={onSelectProvider}
        onBackToList={() => {}}
      />,
    );

    // Configured vs not is announced on each row's accessible name.
    expect(screen.getByRole("button", { name: /Anthropic, configured/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /OpenAI, not configured/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Anthropic, configured/i }));
    expect(onSelectProvider).toHaveBeenCalledWith("anthropic");
  });

  it("saves a new secret from the detail's footer action", async () => {
    const user = userEvent.setup();
    const onProviderChanged = vi.fn();
    api.saveProviderSecret.mockResolvedValue({ ...OPENAI, secretPresent: true, usable: true });

    renderSection(
      <ProvidersSection
        settings={settingsWith([ANTHROPIC, OPENAI])}
        loadError={null}
        onRetry={() => {}}
        onProviderChanged={onProviderChanged}
        selectedId="openai"
        onSelectProvider={() => {}}
        onBackToList={() => {}}
      />,
    );

    const value = await screen.findByLabelText(/Replacement value/i);
    await user.type(value, "sk-new-key");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(api.saveProviderSecret).toHaveBeenCalled());
    const [providerId, payload] = api.saveProviderSecret.mock.calls[0]!;
    expect(providerId).toBe("openai");
    expect(payload).toEqual(expect.objectContaining({ value: "sk-new-key" }));
    await waitFor(() => expect(onProviderChanged).toHaveBeenCalled());
  });

  it("saves an openai-oauth proxy endpoint URL", async () => {
    const user = userEvent.setup();
    const onProviderChanged = vi.fn();
    const oauth: ProviderSettingsView = {
      provider: "openai-oauth",
      displayName: "OpenAI OAuth",
      defaultSecretName: "provider:openai-oauth",
      configuredSecretName: "provider:openai-oauth",
      secretPresent: true,
      secretUpdatedAt: "2026-07-01T09:00:00.000Z",
      previewAvailable: true,
      endpointConfig: { baseUrl: "", proxyUrl: "", auth: "bearer", body: {} },
      usable: false,
    };
    api.saveProviderConfig.mockResolvedValue({
      ...oauth,
      endpointConfig: {
        baseUrl: "",
        proxyUrl: "https://proxy.example.com/openai-oauth",
        auth: "bearer",
        body: {},
      },
      usable: true,
    });

    renderSection(
      <ProvidersSection
        settings={settingsWith([oauth])}
        loadError={null}
        onRetry={() => {}}
        onProviderChanged={onProviderChanged}
        selectedId="openai-oauth"
        onSelectProvider={() => {}}
        onBackToList={() => {}}
      />,
    );

    const proxyUrl = await screen.findByLabelText(/Proxy URL/i);
    await user.clear(proxyUrl);
    await user.type(proxyUrl, "https://proxy.example.com/openai-oauth");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(api.saveProviderConfig).toHaveBeenCalled());
    expect(api.saveProviderConfig.mock.calls[0]).toEqual([
      "openai-oauth",
      expect.objectContaining({ proxyUrl: "https://proxy.example.com/openai-oauth" }),
    ]);
    await waitFor(() => expect(onProviderChanged).toHaveBeenCalled());
  });

  const ZEN: ProviderSettingsView = {
    provider: "opencode-zen",
    displayName: "OpenCode Zen",
    defaultSecretName: "provider:opencode-zen",
    configuredSecretName: "provider:opencode-zen",
    secretPresent: true,
    secretUpdatedAt: "2026-07-01T09:00:00.000Z",
    previewAvailable: true,
    endpointConfig: {
      baseUrl: "https://opencode.ai/zen/v1",
      proxyUrl: "",
      auth: "bearer",
      body: {},
    },
    usable: true,
  };

  it("saves an opencode-zen proxy route without disturbing its own endpoint", async () => {
    const user = userEvent.setup();
    api.saveProviderConfig.mockResolvedValue(ZEN);

    renderSection(
      <ProvidersSection
        settings={settingsWith([ZEN])}
        loadError={null}
        onRetry={() => {}}
        onProviderChanged={() => {}}
        selectedId="opencode-zen"
        onSelectProvider={() => {}}
        onBackToList={() => {}}
      />,
    );

    await user.type(
      await screen.findByLabelText(/Proxy URL/i),
      "https://proxy.example.com/opencode-zen",
    );
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(api.saveProviderConfig).toHaveBeenCalled());
    // Zen's baseUrl is its real API endpoint, so the proxy must be a separate
    // field — overloading baseUrl would lose the direct address.
    expect(api.saveProviderConfig.mock.calls[0]).toEqual([
      "opencode-zen",
      expect.objectContaining({
        proxyUrl: "https://proxy.example.com/opencode-zen",
        baseUrl: "https://opencode.ai/zen/v1",
      }),
    ]);
  });

  it("links the proxy card to the relay's source, opened safely", async () => {
    renderSection(
      <ProvidersSection
        settings={settingsWith([ZEN])}
        loadError={null}
        onRetry={() => {}}
        onProviderChanged={() => {}}
        selectedId="opencode-zen"
        onSelectProvider={() => {}}
        onBackToList={() => {}}
      />,
    );

    const link = await screen.findByRole("link", { name: /see the proxy script/i });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/ruqqq/nadi-oss/blob/main/infra/egress-proxy/server.mjs",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("offers no proxy route for a provider the proxy does not serve", async () => {
    renderSection(
      <ProvidersSection
        settings={settingsWith([ANTHROPIC])}
        loadError={null}
        onRetry={() => {}}
        onProviderChanged={() => {}}
        selectedId="anthropic"
        onSelectProvider={() => {}}
        onBackToList={() => {}}
      />,
    );

    await screen.findByLabelText(/Replacement value/i);
    expect(screen.queryByLabelText(/Proxy URL/i)).not.toBeInTheDocument();
  });

  it("commits model-list changes through the pane's Save, not on toggle", async () => {
    // Before this, the card wrote on every checkbox and the Save button sat
    // right below it applying nothing — which read as a broken button.
    const user = userEvent.setup();
    const onProviderChanged = vi.fn();
    api.getProviderModelCatalog.mockResolvedValue({
      provider: "anthropic",
      models: [
        { id: "claude-opus-5", name: "Claude Opus 5", inputModalities: ["text"], source: "live" },
        {
          id: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          inputModalities: ["text"],
          source: "live",
        },
      ],
      source: "live",
      fetchedAt: 0,
      stale: false,
    });
    api.saveProviderModelWhitelist.mockResolvedValue({ ...ANTHROPIC, whitelistModels: [] });

    renderSection(
      <ProvidersSection
        settings={settingsWith([ANTHROPIC])}
        loadError={null}
        onRetry={() => {}}
        onProviderChanged={onProviderChanged}
        selectedId="anthropic"
        onSelectProvider={() => {}}
        onBackToList={() => {}}
      />,
    );

    await screen.findByText("Claude Opus 5");
    const save = screen.getByRole("button", { name: "Save" });
    // Nothing dirty yet, so Save is inert.
    expect(save).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Select none" }));

    expect(api.saveProviderModelWhitelist).not.toHaveBeenCalled();
    expect(save).toBeEnabled();

    await user.click(save);
    await waitFor(() => {
      expect(api.saveProviderModelWhitelist).toHaveBeenCalledWith("anthropic", []);
    });
    expect(onProviderChanged).toHaveBeenCalled();
  });
});
