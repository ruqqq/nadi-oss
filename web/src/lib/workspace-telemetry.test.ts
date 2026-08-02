import { describe, expect, it } from "vitest";
import { canUseWorkspaceTelemetry, deriveInitialConsentWorkspaceId } from "./workspace-telemetry";

describe("canUseWorkspaceTelemetry", () => {
  it("allows telemetry only for the confirmed consent workspace", () => {
    expect(
      canUseWorkspaceTelemetry({
        consentWorkspaceId: "ws-enabled",
        workspaceId: "ws-enabled",
      }),
    ).toBe(true);

    expect(
      canUseWorkspaceTelemetry({
        consentWorkspaceId: "ws-enabled",
        workspaceId: "ws-disabled",
      }),
    ).toBe(false);

    expect(
      canUseWorkspaceTelemetry({
        consentWorkspaceId: null,
        workspaceId: "ws-enabled",
      }),
    ).toBe(false);
  });
});

describe("deriveInitialConsentWorkspaceId", () => {
  it("uses the default workspace when no thread route is active", () => {
    expect(
      deriveInitialConsentWorkspaceId({
        defaultWorkspaceId: "default-ws",
        pathThreadId: null,
        threads: [{ threadId: "thread-1", workspaceId: "thread-ws" }],
      }),
    ).toBe("default-ws");
  });

  it("uses the routed thread workspace when bootstrap includes the thread", () => {
    expect(
      deriveInitialConsentWorkspaceId({
        defaultWorkspaceId: "default-ws",
        pathThreadId: "thread-1",
        threads: [{ threadId: "thread-1", workspaceId: "thread-ws" }],
      }),
    ).toBe("thread-ws");
  });

  it("fails closed until a routed thread workspace is resolved", () => {
    expect(
      deriveInitialConsentWorkspaceId({
        defaultWorkspaceId: "default-ws",
        pathThreadId: "thread-2",
        threads: [{ threadId: "thread-1", workspaceId: "thread-ws" }],
      }),
    ).toBeNull();
  });
});
