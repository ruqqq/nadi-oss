// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SandboxSettingsResponse } from "../sandbox-settings-api";
import { SettingsFooterContext } from "./footer-slot";

// Mirror the Settings shell: SandboxSection portals its Save into the shell's
// footer slot, so an isolated render must supply that slot or Save never mounts.
function FooterHarness({ children }: { children: ReactNode }) {
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <SettingsFooterContext.Provider value={footerEl}>{children}</SettingsFooterContext.Provider>
      <div ref={setFooterEl} />
    </>
  );
}

// The api module is imported for its side-effecting calls (fetch wrappers). Mock
// it wholesale so the component renders without a Worker; each test seeds the
// GET response and inspects the save payloads.
const api = vi.hoisted(() => ({
  getSandboxSettings: vi.fn(),
  saveWorkspaceSandboxSettings: vi.fn(),
  saveDaytonaSecret: vi.fn(),
  clearDaytonaOverride: vi.fn(),
  saveSpritesSecret: vi.fn(),
  clearSpritesOverride: vi.fn(),
  testConnection: vi.fn(),
}));

vi.mock("../sandbox-settings-api", () => api);

import { SandboxSection } from "./SandboxSection";

// Radix Select relies on a few DOM APIs jsdom does not implement.
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false) as never;
  Element.prototype.setPointerCapture = vi.fn() as never;
  Element.prototype.releasePointerCapture = vi.fn() as never;
  Element.prototype.scrollIntoView = vi.fn() as never;
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;
  }
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function daytonaWorkspace(
  overrides: Partial<SandboxSettingsResponse["workspace"] & object> = {},
): SandboxSettingsResponse["workspace"] {
  return {
    enabled: true,
    provider: "daytona",
    providerConfig: {
      kind: "daytona",
      apiKeySecretName: "sandbox:daytona",
      apiUrl: null,
      target: null,
      profiles: {
        small: { kind: "snapshot", value: "nadi-small" },
        medium: null,
      },
    },
    idleTimeoutMs: 900_000,
    recoveryTtlMs: 86_400_000,
    maxProcessRuntimeMs: 600_000,
    networkRestrictionEnabled: false,
    networkDomainAllowlist: "",
    envVars: {},
    ...overrides,
  };
}

function cloudflareWorkspace(
  overrides: Partial<SandboxSettingsResponse["workspace"] & object> = {},
): SandboxSettingsResponse["workspace"] {
  return {
    enabled: true,
    provider: "cloudflare",
    providerConfig: { kind: "cloudflare" },
    idleTimeoutMs: 900_000,
    recoveryTtlMs: 86_400_000,
    maxProcessRuntimeMs: 600_000,
    networkRestrictionEnabled: false,
    networkDomainAllowlist: "",
    envVars: {},
    ...overrides,
  };
}

function spritesWorkspace(
  overrides: Partial<SandboxSettingsResponse["workspace"] & object> = {},
): SandboxSettingsResponse["workspace"] {
  return {
    enabled: true,
    provider: "sprites",
    providerConfig: { kind: "sprites", apiKeySecretName: "sandbox:sprites" },
    idleTimeoutMs: 900_000,
    recoveryTtlMs: 86_400_000,
    maxProcessRuntimeMs: 600_000,
    networkRestrictionEnabled: false,
    networkDomainAllowlist: "",
    envVars: {},
    ...overrides,
  };
}

function response(overrides: Partial<SandboxSettingsResponse> = {}): SandboxSettingsResponse {
  return {
    workspace: daytonaWorkspace(),
    agent: null,
    daytonaMode: "byok",
    daytonaAvailable: true,
    daytonaSecretPresent: true,
    spritesMode: "system",
    spritesAvailable: true,
    spritesSecretPresent: false,
    workspaceSecretEnvVars: [],
    agentSecretEnvVars: [],
    readiness: {
      daytona: { provider: "daytona", ready: true, missingConfig: [], unsupported: [] },
      cloudflare: { provider: "cloudflare", ready: true, missingConfig: [], unsupported: [] },
      sprites: { provider: "sprites", ready: true, missingConfig: [], unsupported: [] },
    },
    effective: { enabled: true, value: { resourceProfile: "small", allowedHosts: null } },
    ...overrides,
  };
}

async function renderLoaded(res: SandboxSettingsResponse) {
  api.getSandboxSettings.mockResolvedValue(res);
  api.saveWorkspaceSandboxSettings.mockResolvedValue(res);
  render(
    <FooterHarness>
      <SandboxSection />
    </FooterHarness>,
  );
  // Wait until the loading skeleton is replaced by the provider selector.
  await screen.findByRole("combobox", { name: /compute provider/i });
}

async function selectProvider(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getByRole("combobox", { name: /compute provider/i }));
  const option = await screen.findByRole("option", { name });
  await user.click(option);
}

describe("SandboxSection provider selection", () => {
  it("shows Daytona controls when the workspace is on Daytona", async () => {
    await renderLoaded(response());
    expect(screen.getByLabelText(/daytona api key/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/daytona api url/i)).toBeInTheDocument();
  });

  it("switches to Cloudflare, hiding Daytona-only controls and showing readiness", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderLoaded(response());
    await selectProvider(user, /cloudflare/i);

    // Daytona-only credential/source controls are gone under Cloudflare.
    expect(screen.queryByLabelText(/daytona api key/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/daytona api url/i)).not.toBeInTheDocument();

    // Cloudflare readiness rows appear, with the binding names in mono.
    expect(screen.getByText("NADI_SANDBOX_SMALL")).toBeInTheDocument();
    expect(screen.getByText("BACKUP_BUCKET")).toBeInTheDocument();
  });

  it("submits a Cloudflare payload carrying no Daytona fields", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderLoaded(response());
    await selectProvider(user, /cloudflare/i);
    await user.click(screen.getByRole("button", { name: /save workspace settings/i }));

    await waitFor(() => expect(api.saveWorkspaceSandboxSettings).toHaveBeenCalled());
    const body = api.saveWorkspaceSandboxSettings.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.provider).toBe("cloudflare");
    expect(body.providerConfig).toEqual({ kind: "cloudflare" });
    // No Daytona-shaped configuration may ride along in a Cloudflare save.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("apiUrl");
    expect(serialized).not.toContain("apiKeySecretName");
    expect(serialized).not.toContain("profiles");
    expect(serialized).not.toContain("snapshot");
  });

  it("distinguishes missing configuration from an unsupported capability", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderLoaded(
      response({
        readiness: {
          daytona: { provider: "daytona", ready: true, missingConfig: [], unsupported: [] },
          cloudflare: {
            provider: "cloudflare",
            ready: false,
            missingConfig: ["BACKUP_BUCKET", "R2_ACCESS_KEY_ID"],
            unsupported: [],
          },
          sprites: { provider: "sprites", ready: true, missingConfig: [], unsupported: [] },
        },
      }),
    );
    await selectProvider(user, /cloudflare/i);

    // Missing config is surfaced as "not provisioned", not as "unsupported".
    const backup = screen.getByText("BACKUP_BUCKET").closest("[data-readiness-row]");
    expect(backup).not.toBeNull();
    expect(within(backup as HTMLElement).getByText(/missing/i)).toBeInTheDocument();
    expect(screen.queryByText(/not supported on cloudflare/i)).not.toBeInTheDocument();
  });
});

describe("SandboxSection Daytona configuration mode", () => {
  it("shows only readiness and mode controls for system-managed Daytona", async () => {
    await renderLoaded(response({ daytonaMode: "system", daytonaSecretPresent: false }));

    expect(screen.getByRole("button", { name: /^System managed$/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /^BYOK$/i })).toBeInTheDocument();
    expect(screen.getByText(/system-managed daytona is ready/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/daytona api key/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/daytona api url/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/target \/ region/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/small profile/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/medium profile/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/idle timeout/i)).not.toBeInTheDocument();
  });

  it("reveals the complete form for BYOK and hides idle timeout for Cloudflare", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderLoaded(response());

    expect(screen.getByRole("button", { name: /^BYOK$/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText(/daytona api key/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/daytona api url/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/target \/ region/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^small profile$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^medium profile$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/idle timeout/i)).toBeInTheDocument();

    await selectProvider(user, /cloudflare/i);
    expect(screen.queryByLabelText(/idle timeout/i)).not.toBeInTheDocument();
  });

  it("selects BYOK locally, then saves workspace settings before the key", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const system = response({ daytonaMode: "system", daytonaSecretPresent: false });
    const settingsSaved = response({ daytonaMode: "system", daytonaSecretPresent: false });
    const byokSaved = response({ daytonaMode: "byok", daytonaSecretPresent: true });
    api.saveWorkspaceSandboxSettings.mockResolvedValue(settingsSaved);
    api.saveDaytonaSecret.mockResolvedValue(byokSaved);
    await renderLoaded(system);

    await user.click(screen.getByRole("button", { name: /^BYOK$/i }));
    expect(api.saveWorkspaceSandboxSettings).not.toHaveBeenCalled();
    expect(api.saveDaytonaSecret).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/daytona api key/i), "dt_secret");
    await user.type(screen.getByLabelText(/^medium profile$/i), "nadi-medium");
    await user.click(screen.getByRole("button", { name: /save workspace settings/i }));

    await waitFor(() => expect(api.saveDaytonaSecret).toHaveBeenCalled());
    expect(api.saveWorkspaceSandboxSettings).toHaveBeenCalledTimes(1);
    expect(api.saveDaytonaSecret).toHaveBeenCalledWith({
      value: "dt_secret",
      secretName: "sandbox:daytona",
    });
    expect(api.saveWorkspaceSandboxSettings.mock.invocationCallOrder[0]).toBeLessThan(
      api.saveDaytonaSecret.mock.invocationCallOrder[0]!,
    );
  });

  it("saves a newly entered key when both profiles are already populated", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const populated = response({
      workspace: daytonaWorkspace({
        providerConfig: {
          kind: "daytona",
          apiKeySecretName: "sandbox:daytona",
          apiUrl: null,
          target: null,
          profiles: {
            small: { kind: "snapshot", value: "nadi-small" },
            medium: { kind: "snapshot", value: "nadi-medium" },
          },
        },
      }),
    });
    api.saveDaytonaSecret.mockResolvedValue(populated);
    await renderLoaded(populated);

    await user.type(screen.getByLabelText(/daytona api key/i), "dt_replacement");
    await user.click(screen.getByRole("button", { name: /save workspace settings/i }));

    await waitFor(() =>
      expect(api.saveDaytonaSecret).toHaveBeenCalledWith({
        value: "dt_replacement",
        secretName: "sandbox:daytona",
      }),
    );
  });

  it("resets BYOK to system-managed mode using the returned server view", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const system = response({ daytonaMode: "system", daytonaSecretPresent: false });
    api.clearDaytonaOverride.mockResolvedValue(system);
    await renderLoaded(response());

    await user.click(screen.getByRole("button", { name: /^System managed$/i }));

    await waitFor(() => expect(api.clearDaytonaOverride).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByLabelText(/daytona api key/i)).not.toBeInTheDocument(),
    );
  });

  it("returns to confirmed system mode when the BYOK key save fails", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const system = response({ daytonaMode: "system", daytonaSecretPresent: false });
    api.saveWorkspaceSandboxSettings.mockResolvedValue(system);
    api.saveDaytonaSecret.mockRejectedValue(new Error("service unavailable"));
    await renderLoaded(system);

    await user.click(screen.getByRole("button", { name: /^BYOK$/i }));
    await user.type(screen.getByLabelText(/daytona api key/i), "dt_secret");
    await user.type(screen.getByLabelText(/^medium profile$/i), "nadi-medium");
    await user.click(screen.getByRole("button", { name: /save workspace settings/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn.t save the byok daytona configuration/i,
    );
    expect(screen.getByRole("button", { name: /^System managed$/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByLabelText(/daytona api key/i)).not.toBeInTheDocument();
  });

  it("adopts saved workspace fields but keeps the confirmed mode when the key save fails", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const system = response({ daytonaMode: "system", daytonaSecretPresent: false });
    const workspaceSaved = response({
      daytonaMode: "system",
      daytonaSecretPresent: false,
      workspace: daytonaWorkspace({
        idleTimeoutMs: 2_520_000,
        providerConfig: {
          kind: "daytona",
          apiKeySecretName: "sandbox:daytona",
          apiUrl: "https://saved.example/api",
          target: "eu",
          profiles: {
            small: { kind: "snapshot", value: "saved-small" },
            medium: { kind: "image", value: "saved-medium" },
          },
        },
      }),
    });
    api.saveDaytonaSecret.mockRejectedValue(new Error("service unavailable"));
    await renderLoaded(system);
    api.saveWorkspaceSandboxSettings.mockResolvedValue(workspaceSaved);

    await user.click(screen.getByRole("button", { name: /^BYOK$/i }));
    await user.type(screen.getByLabelText(/daytona api key/i), "dt_secret");
    await user.type(screen.getByLabelText(/daytona api url/i), "https://draft.example/api");
    await user.type(screen.getByLabelText(/target \/ region/i), "us");
    await user.clear(screen.getByLabelText(/^small profile$/i));
    await user.type(screen.getByLabelText(/^small profile$/i), "draft-small");
    await user.type(screen.getByLabelText(/^medium profile$/i), "draft-medium");
    await user.click(screen.getByRole("button", { name: /save workspace settings/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn.t save the byok daytona configuration/i,
    );
    expect(screen.getByRole("button", { name: /^System managed$/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: /^BYOK$/i }));
    expect(screen.getByLabelText(/daytona api url/i)).toHaveValue("https://saved.example/api");
    expect(screen.getByLabelText(/target \/ region/i)).toHaveValue("eu");
    expect(screen.getByLabelText(/^small profile$/i)).toHaveValue("saved-small");
    expect(screen.getByLabelText(/^medium profile$/i)).toHaveValue("saved-medium");
    expect(screen.getByLabelText(/idle timeout/i)).toHaveValue(42);
  });

  it("requires a key and both profile sources before saving BYOK", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderLoaded(response({ daytonaMode: "system", daytonaSecretPresent: false }));

    await user.click(screen.getByRole("button", { name: /^BYOK$/i }));
    await user.click(screen.getByRole("button", { name: /save workspace settings/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(/api key and a source for both/i);
    expect(api.saveWorkspaceSandboxSettings).not.toHaveBeenCalled();
    expect(api.saveDaytonaSecret).not.toHaveBeenCalled();
  });

  it("keeps confirmed BYOK fields visible and explains a failed reset", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    api.clearDaytonaOverride.mockRejectedValue(new Error("service unavailable"));
    await renderLoaded(response());

    await user.click(screen.getByRole("button", { name: /^System managed$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn.t switch to system-managed daytona/i,
    );
    expect(screen.getByRole("button", { name: /^BYOK$/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText(/daytona api key/i)).toBeInTheDocument();
  });
});

describe("SandboxSection network-restrictions gate", () => {
  it("prevents selecting Cloudflare while network restrictions are configured", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderLoaded(
      response({
        workspace: daytonaWorkspace({
          networkRestrictionEnabled: true,
          networkDomainAllowlist: "github.com",
        }),
        readiness: {
          daytona: { provider: "daytona", ready: true, missingConfig: [], unsupported: [] },
          cloudflare: {
            provider: "cloudflare",
            ready: false,
            missingConfig: [],
            unsupported: ["network_restrictions"],
          },
          sprites: { provider: "sprites", ready: true, missingConfig: [], unsupported: [] },
        },
      }),
    );

    // The explanation is shown up front...
    expect(screen.getByText(/not supported on cloudflare/i)).toBeInTheDocument();

    // ...and the Cloudflare option cannot be chosen.
    await user.click(screen.getByRole("combobox", { name: /compute provider/i }));
    const cloudflareOption = await screen.findByRole("option", { name: /cloudflare/i });
    expect(cloudflareOption).toHaveAttribute("aria-disabled", "true");
    await user.click(cloudflareOption);

    // Selection stayed on Daytona; the Daytona controls are still present.
    expect(screen.getByLabelText(/daytona api key/i)).toBeInTheDocument();
  });

  it("does not offer env vars or secrets at workspace or agent level", async () => {
    // Both now live on the agent. The Sandbox page must not present a second,
    // competing place to set them.
    await renderLoaded(
      response({
        workspace: daytonaWorkspace({ envVars: { API_HOST: "example.com" } }),
        workspaceSecretEnvVars: [{ name: "GH_TOKEN", updatedAt: "2026-07-01T09:00:00.000Z" }],
        agentSecretEnvVars: [{ name: "AGENT_KEY", updatedAt: "2026-07-01T09:00:00.000Z" }],
      }),
    );

    for (const heading of [
      /^Environment variables$/i,
      /^Secrets$/i,
      /^Agent environment variables$/i,
      /^Agent secrets$/i,
    ]) {
      expect(screen.queryByText(heading)).not.toBeInTheDocument();
    }
    // Seeded values must not leak through some other surface either.
    expect(screen.queryByText(/API_HOST/)).not.toBeInTheDocument();
    expect(screen.queryByText(/GH_TOKEN/)).not.toBeInTheDocument();
    expect(screen.queryByText(/AGENT_KEY/)).not.toBeInTheDocument();
  });

  it("hides the deployment panel when an operator manages compute", async () => {
    await renderLoaded(
      response({ workspace: cloudflareWorkspace(), operatorManagedCompute: true }),
    );

    expect(screen.queryByText(/Cloudflare deployment/i)).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-readiness-row]")).toHaveLength(0);
    // Only the operator-only panel goes. Everything a tenant can still change
    // must survive, or this hides settings rather than noise.
    expect(screen.getByRole("combobox", { name: /compute provider/i })).toBeInTheDocument();
  });

  it("does not offer network-restriction controls at workspace or agent level", async () => {
    // Network restriction is moving to agent-level config; the Sandbox page
    // hides the controls but the backend keeps the stored values (the PUT
    // merge-preserves them), so nothing here may render or leak them.
    await renderLoaded(
      response({
        workspace: daytonaWorkspace({
          networkRestrictionEnabled: true,
          networkDomainAllowlist: "github.com",
        }),
        agent: {
          enabled: null,
          idleTimeoutMs: null,
          maxProcessRuntimeMs: null,
          networkDomainAllowlist: "api.example.com",
          envVars: null,
        },
      }),
    );

    expect(screen.queryByLabelText(/restrict sandbox network/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Allowed domains$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Additional allowed domains$/i)).not.toBeInTheDocument();
    // The stored allowlists must not surface through any other control.
    expect(screen.queryByText(/github\.com/)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(/api\.example\.com/)).not.toBeInTheDocument();
  });

  it("drops the agent override card and labels the workspace toggle for enabling the sandbox", async () => {
    await renderLoaded(response());

    // The whole per-agent override card is gone — sandbox execution is a
    // workspace-level switch now.
    expect(screen.queryByText(/Agent override/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save agent override/i })).not.toBeInTheDocument();
    // The workspace toggle reads as an enable/disable, not "Workspace default".
    expect(screen.queryByText(/^Workspace default$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/^Enable sandbox$/i)).toBeInTheDocument();
  });

  it("shows the deployment panel when the field is absent (older server / self-hosted)", async () => {
    await renderLoaded(response({ workspace: cloudflareWorkspace() }));

    expect(screen.getByText(/Cloudflare deployment/i)).toBeInTheDocument();
    expect(document.querySelectorAll("[data-readiness-row]").length).toBeGreaterThan(0);
  });

  it("keeps gating the provider selector on readiness even when compute is operator-managed", async () => {
    // `operatorManagedCompute` hides the read-only panel only. The Cloudflare
    // option is still gated on `unsupported`, which stays meaningful on cloud.
    await renderLoaded(
      response({
        operatorManagedCompute: true,
        readiness: {
          daytona: { provider: "daytona", ready: true, missingConfig: [], unsupported: [] },
          cloudflare: {
            provider: "cloudflare",
            ready: false,
            missingConfig: [],
            unsupported: ["network_restrictions"],
          },
          sprites: { provider: "sprites", ready: true, missingConfig: [], unsupported: [] },
        },
      }),
    );

    await userEvent.setup().click(screen.getByRole("combobox", { name: /compute provider/i }));
    const cloudflareOption = await screen.findByRole("option", { name: /cloudflare/i });
    expect(cloudflareOption).toHaveAttribute("aria-disabled", "true");
  });

  it("gives Cloudflare-specific advice when Cloudflare is already selected and restricted", async () => {
    await renderLoaded(
      response({
        workspace: cloudflareWorkspace({
          networkRestrictionEnabled: true,
          networkDomainAllowlist: "github.com",
        }),
        readiness: {
          daytona: { provider: "daytona", ready: true, missingConfig: [], unsupported: [] },
          cloudflare: {
            provider: "cloudflare",
            ready: false,
            missingConfig: [],
            unsupported: ["network_restrictions"],
          },
          sprites: { provider: "sprites", ready: true, missingConfig: [], unsupported: [] },
        },
      }),
    );

    // Telling someone already on Cloudflare to "stay on Daytona" is wrong; the
    // note must instead explain the consequence and how to get back to a
    // working state from where they actually are.
    expect(
      screen.getAllByText(/threads on this workspace will fail to start/i).length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByText(
        /^Network restrictions are not supported on Cloudflare\. Clear them, or stay on Daytona\.$/,
      ),
    ).not.toBeInTheDocument();
  });

  it("names network restrictions as the cause instead of a flat provisioning message", async () => {
    await renderLoaded(
      response({
        workspace: cloudflareWorkspace({
          networkRestrictionEnabled: true,
          networkDomainAllowlist: "github.com",
        }),
        readiness: {
          daytona: { provider: "daytona", ready: true, missingConfig: [], unsupported: [] },
          cloudflare: {
            provider: "cloudflare",
            ready: false,
            missingConfig: [],
            unsupported: ["network_restrictions"],
          },
          sprites: { provider: "sprites", ready: true, missingConfig: [], unsupported: [] },
        },
      }),
    );

    // Every config row reads "Present" while the workspace is still not ready:
    // the not-ready message must name network restrictions as the cause, not
    // claim bindings/secrets are missing.
    expect(
      screen.getByText(/Cloudflare's sandbox has no way to enforce a host allowlist/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/isn.t fully provisioned yet/i)).not.toBeInTheDocument();
    for (const row of screen.getAllByText(/present/i)) {
      expect(row).toBeInTheDocument();
    }
  });

  it("renders both the unsupported-capability and missing-config messages when both apply", async () => {
    await renderLoaded(
      response({
        workspace: cloudflareWorkspace({
          networkRestrictionEnabled: true,
          networkDomainAllowlist: "github.com",
        }),
        readiness: {
          daytona: { provider: "daytona", ready: true, missingConfig: [], unsupported: [] },
          cloudflare: {
            provider: "cloudflare",
            ready: false,
            missingConfig: ["BACKUP_BUCKET"],
            unsupported: ["network_restrictions"],
          },
          sprites: { provider: "sprites", ready: true, missingConfig: [], unsupported: [] },
        },
      }),
    );

    // Neither cause may hide the other.
    expect(
      screen.getByText(/Cloudflare's sandbox has no way to enforce a host allowlist/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/isn.t fully provisioned yet/i)).toBeInTheDocument();
  });
});

describe("SandboxSection Sprites provider", () => {
  it("shows the System/BYOK mode toggle when Sprites is selected", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderLoaded(response({ workspace: spritesWorkspace() }));
    await selectProvider(user, /sprites/i);

    expect(screen.getByRole("button", { name: /^System managed$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^BYOK$/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/daytona api key/i)).not.toBeInTheDocument();
  });

  it("shows the Sprites token field in BYOK mode", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderLoaded(
      response({ workspace: spritesWorkspace(), spritesMode: "byok", spritesSecretPresent: true }),
    );
    await selectProvider(user, /sprites/i);

    expect(screen.getByLabelText(/sprites api token/i)).toBeInTheDocument();
  });

  it("submits a Sprites payload on save", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderLoaded(response({ workspace: spritesWorkspace() }));
    await selectProvider(user, /sprites/i);
    await user.click(screen.getByRole("button", { name: /save workspace settings/i }));

    await waitFor(() => expect(api.saveWorkspaceSandboxSettings).toHaveBeenCalled());
    const body = api.saveWorkspaceSandboxSettings.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.provider).toBe("sprites");
    expect(body.providerConfig).toEqual({ kind: "sprites", apiKeySecretName: "sandbox:sprites" });
  });

  it("entering a token in BYOK mode calls the sprites-secret endpoint on save", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const system = response({
      workspace: spritesWorkspace(),
      spritesMode: "system",
      spritesSecretPresent: false,
    });
    const settingsSaved = response({
      workspace: spritesWorkspace(),
      spritesMode: "system",
      spritesSecretPresent: false,
    });
    const byokSaved = response({
      workspace: spritesWorkspace(),
      spritesMode: "byok",
      spritesSecretPresent: true,
    });
    api.saveWorkspaceSandboxSettings.mockResolvedValue(settingsSaved);
    api.saveSpritesSecret.mockResolvedValue(byokSaved);
    await renderLoaded(system);
    await selectProvider(user, /sprites/i);

    await user.click(screen.getByRole("button", { name: /^BYOK$/i }));
    await user.type(screen.getByLabelText(/sprites api token/i), "sprites_secret");
    await user.click(screen.getByRole("button", { name: /save workspace settings/i }));

    await waitFor(() => expect(api.saveSpritesSecret).toHaveBeenCalled());
    expect(api.saveSpritesSecret).toHaveBeenCalledWith({
      value: "sprites_secret",
      secretName: "sandbox:sprites",
    });
    expect(api.saveWorkspaceSandboxSettings.mock.invocationCallOrder[0]).toBeLessThan(
      api.saveSpritesSecret.mock.invocationCallOrder[0]!,
    );
  });

  it("resets Sprites BYOK to system-managed mode", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const system = response({
      workspace: spritesWorkspace(),
      spritesMode: "system",
      spritesSecretPresent: false,
    });
    api.clearSpritesOverride.mockResolvedValue(system);
    await renderLoaded(
      response({ workspace: spritesWorkspace(), spritesMode: "byok", spritesSecretPresent: true }),
    );
    await selectProvider(user, /sprites/i);

    await user.click(screen.getByRole("button", { name: /^System managed$/i }));

    await waitFor(() => expect(api.clearSpritesOverride).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByLabelText(/sprites api token/i)).not.toBeInTheDocument(),
    );
  });
});
