// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivacySection } from "./PrivacySection";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
});

describe("PrivacySection", () => {
  it("loads and saves telemetry preference", async () => {
    const getPrivacySettings = vi.fn().mockResolvedValue({
      workspaceId: "ws1",
      telemetryEnabled: false,
    });
    const savePrivacySettings = vi.fn().mockResolvedValue({
      workspaceId: "ws1",
      telemetryEnabled: true,
    });
    const setPostHogConsent = vi.fn();
    const track = vi.fn();

    render(
      <PrivacySection
        consentWorkspaceId="ws1"
        getPrivacySettings={getPrivacySettings}
        savePrivacySettings={savePrivacySettings}
        setPostHogConsent={setPostHogConsent}
        track={track}
      />,
    );

    const toggle = await screen.findByRole("switch", { name: /share usage data/i });
    expect(toggle).not.toBeChecked();

    await userEvent.click(toggle);

    await waitFor(() => {
      expect(savePrivacySettings).toHaveBeenCalledWith({ telemetryEnabled: true });
    });
    expect(setPostHogConsent).toHaveBeenCalledWith(true);
    expect(track).toHaveBeenCalledWith("settings_saved", {
      section: "privacy",
      telemetryEnabled: true,
      workspace_id: "ws1",
    });
  });

  it("does not track when disabling telemetry", async () => {
    const getPrivacySettings = vi.fn().mockResolvedValue({
      workspaceId: "ws1",
      telemetryEnabled: true,
    });
    const savePrivacySettings = vi.fn().mockResolvedValue({
      workspaceId: "ws1",
      telemetryEnabled: false,
    });
    const setPostHogConsent = vi.fn();
    const track = vi.fn();

    render(
      <PrivacySection
        consentWorkspaceId="ws1"
        getPrivacySettings={getPrivacySettings}
        savePrivacySettings={savePrivacySettings}
        setPostHogConsent={setPostHogConsent}
        track={track}
      />,
    );

    const toggle = await screen.findByRole("switch", { name: /share usage data/i });
    expect(toggle).toBeChecked();

    await userEvent.click(toggle);

    await waitFor(() => {
      expect(savePrivacySettings).toHaveBeenCalledWith({ telemetryEnabled: false });
    });
    expect(setPostHogConsent).toHaveBeenCalledWith(false);
    expect(track).not.toHaveBeenCalled();
  });

  it("does not enable consent for a different active workspace", async () => {
    const getPrivacySettings = vi.fn().mockResolvedValue({
      workspaceId: "owner-ws",
      telemetryEnabled: false,
    });
    const savePrivacySettings = vi.fn().mockResolvedValue({
      workspaceId: "owner-ws",
      telemetryEnabled: true,
    });
    const setPostHogConsent = vi.fn();
    const track = vi.fn();

    render(
      <PrivacySection
        consentWorkspaceId="active-member-ws"
        getPrivacySettings={getPrivacySettings}
        savePrivacySettings={savePrivacySettings}
        setPostHogConsent={setPostHogConsent}
        track={track}
      />,
    );

    const toggle = await screen.findByRole("switch", { name: /share usage data/i });
    expect(toggle).not.toBeChecked();

    await userEvent.click(toggle);

    await waitFor(() => {
      expect(savePrivacySettings).toHaveBeenCalledWith({ telemetryEnabled: true });
    });
    expect(setPostHogConsent).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it("revokes active workspace consent before saving an off toggle", async () => {
    const save = deferred<{ workspaceId: string; telemetryEnabled: boolean }>();
    const getPrivacySettings = vi.fn().mockResolvedValue({
      workspaceId: "ws1",
      telemetryEnabled: true,
    });
    const savePrivacySettings = vi.fn(() => save.promise);
    const setPostHogConsent = vi.fn();
    const track = vi.fn();

    render(
      <PrivacySection
        consentWorkspaceId="ws1"
        getPrivacySettings={getPrivacySettings}
        savePrivacySettings={savePrivacySettings}
        setPostHogConsent={setPostHogConsent}
        track={track}
      />,
    );

    const toggle = await screen.findByRole("switch", { name: /share usage data/i });
    setPostHogConsent.mockClear();

    await userEvent.click(toggle);

    expect(savePrivacySettings).toHaveBeenCalledWith({ telemetryEnabled: false });
    expect(setPostHogConsent).toHaveBeenCalledWith(false);

    save.resolve({ workspaceId: "ws1", telemetryEnabled: false });
    await waitFor(() => {
      expect(toggle).not.toBeChecked();
    });
  });
});
