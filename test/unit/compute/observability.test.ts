import { describe, expect, it, vi } from "vitest";
import { recordComputeEvent, type ComputeEvent } from "../../../src/compute/observability";

const EVENTS = [
  "acquire",
  "command_completion",
  "command_timeout",
  "command_stop",
  "release",
  "restore",
  "discard",
  "recovery_expiry",
] as const;

describe("compute observability", () => {
  it("serializes every lifecycle variant with only the approved metadata", () => {
    const emit = vi.fn();
    for (const event of EVENTS) {
      recordComputeEvent(
        {
          event,
          provider: "fake",
          profile: "small",
          durationMs: 12,
          stdoutBytes: 34,
          stderrBytes: 56,
          transition: "active_to_recoverable",
          outcome: "success",
        },
        emit,
      );
    }

    expect(emit).toHaveBeenCalledTimes(EVENTS.length);
    for (const [serialized] of emit.mock.calls) {
      expect(JSON.parse(serialized)).toEqual({
        event: expect.any(String),
        provider: "fake",
        profile: "small",
        durationMs: 12,
        stdoutBytes: 34,
        stderrBytes: 56,
        transition: "active_to_recoverable",
        outcome: "success",
      });
    }
  });

  it("cannot emit commands, environment values, backend payloads, or credentials", () => {
    const emit = vi.fn();
    const hostile = {
      event: "acquire",
      provider: "fake",
      profile: "small",
      outcome: "success",
      command: "cat /secret",
      env: { API_KEY: "credential-value" },
      payload: { runtimeId: "backend-private" },
      credential: "credential-value",
    } as unknown as ComputeEvent;

    recordComputeEvent(hostile, emit);

    const serialized = emit.mock.calls[0]?.[0] as string;
    expect(serialized).not.toContain("cat /secret");
    expect(serialized).not.toContain("API_KEY");
    expect(serialized).not.toContain("backend-private");
    expect(serialized).not.toContain("credential-value");
  });

  it("rejects forbidden metadata at the type boundary", () => {
    const emit = vi.fn();
    const commandEvent: ComputeEvent = {
      event: "acquire",
      provider: "fake",
      profile: "small",
      outcome: "success",
      // @ts-expect-error commands are not valid compute event metadata
      command: "pwd",
    };
    const environmentEvent: ComputeEvent = {
      event: "acquire",
      provider: "fake",
      profile: "small",
      outcome: "success",
      // @ts-expect-error environment values are not valid compute event metadata
      env: { TOKEN: "secret" },
    };
    const payloadEvent: ComputeEvent = {
      event: "acquire",
      provider: "fake",
      profile: "small",
      outcome: "success",
      // @ts-expect-error backend payloads are not valid compute event metadata
      payload: {},
    };
    const credentialEvent: ComputeEvent = {
      event: "acquire",
      provider: "fake",
      profile: "small",
      outcome: "success",
      // @ts-expect-error credentials are not valid compute event metadata
      credential: "secret",
    };
    for (const event of [commandEvent, environmentEvent, payloadEvent, credentialEvent]) {
      recordComputeEvent(event, emit);
    }
    expect(emit).toHaveBeenCalledTimes(4);
  });
});
