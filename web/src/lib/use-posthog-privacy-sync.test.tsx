// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AuthSession } from "../auth-api";
import { usePostHogPrivacySync } from "./use-posthog-privacy-sync";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const authenticatedSession: AuthSession = {
  authenticated: true,
  user: { id: "user-1", email: "person@nadi.test" },
};

describe("usePostHogPrivacySync", () => {
  it("revokes consent immediately when switching away from an opted-in workspace", async () => {
    const privacyA = deferred<{ workspaceId: string; telemetryEnabled: boolean }>();
    const privacyB = deferred<{ workspaceId: string; telemetryEnabled: boolean }>();
    const getPrivacySettings = vi.fn(({ workspaceId }: { workspaceId?: string }) => {
      if (workspaceId === "ws-a") return privacyA.promise;
      if (workspaceId === "ws-b") return privacyB.promise;
      throw new Error(`unexpected workspace ${workspaceId}`);
    });
    const setPostHogConsent = vi.fn();
    const identifyUser = vi.fn();

    const { rerender } = renderHook(
      ({ workspaceId }) =>
        usePostHogPrivacySync({
          session: authenticatedSession,
          consentWorkspaceId: workspaceId,
          getPrivacySettings,
          setPostHogConsent,
          identifyUser,
        }),
      { initialProps: { workspaceId: "ws-a" } },
    );

    expect(setPostHogConsent).toHaveBeenLastCalledWith(false);

    privacyA.resolve({ workspaceId: "ws-a", telemetryEnabled: true });

    await waitFor(() => {
      expect(setPostHogConsent).toHaveBeenLastCalledWith(true);
    });

    rerender({ workspaceId: "ws-b" });

    expect(setPostHogConsent).toHaveBeenLastCalledWith(false);

    privacyB.resolve({ workspaceId: "ws-b", telemetryEnabled: false });

    await waitFor(() => {
      expect(getPrivacySettings).toHaveBeenCalledTimes(2);
    });
  });

  it("replays identify after consent is confirmed enabled", async () => {
    const privacy = deferred<{ workspaceId: string; telemetryEnabled: boolean }>();
    const getPrivacySettings = vi.fn(() => privacy.promise);
    const setPostHogConsent = vi.fn();
    const identifyUser = vi.fn();

    renderHook(() =>
      usePostHogPrivacySync({
        session: authenticatedSession,
        consentWorkspaceId: "ws-a",
        getPrivacySettings,
        setPostHogConsent,
        identifyUser,
      }),
    );

    expect(identifyUser).not.toHaveBeenCalled();

    privacy.resolve({ workspaceId: "ws-a", telemetryEnabled: true });

    await waitFor(() => {
      expect(setPostHogConsent).toHaveBeenLastCalledWith(true);
    });
    await waitFor(() => {
      expect(identifyUser).toHaveBeenCalledWith({
        id: "user-1",
        email: "person@nadi.test",
      });
    });
  });
});
