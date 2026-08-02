import type { ComputeProviderId, ComputeResourceProfile } from "./backend";

export type ComputeEventName =
  | "acquire"
  | "command_completion"
  | "command_timeout"
  | "command_stop"
  | "release"
  | "restore"
  | "discard"
  | "recovery_expiry"
  | "file_mutation";

export type ComputeEventOutcome = "success" | "failure";

export interface ComputeEvent {
  event: ComputeEventName;
  provider: ComputeProviderId;
  profile: ComputeResourceProfile;
  durationMs?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  /** file_mutation only: bytes written across the operation. */
  byteCount?: number;
  /** file_mutation only: number of file operations in the mutation. */
  operationCount?: number;
  transition?: string;
  outcome: ComputeEventOutcome;
}

export type ComputeEventEmitter = (serialized: string) => void;

const defaultEmitter: ComputeEventEmitter = (serialized) => {
  console.info(serialized);
};

/** Emits only the explicitly approved, provider-neutral compute metadata. */
export function recordComputeEvent(
  event: ComputeEvent,
  emit: ComputeEventEmitter = defaultEmitter,
): string {
  const serialized = JSON.stringify({
    event: event.event,
    provider: event.provider,
    profile: event.profile,
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...(event.stdoutBytes === undefined ? {} : { stdoutBytes: event.stdoutBytes }),
    ...(event.stderrBytes === undefined ? {} : { stderrBytes: event.stderrBytes }),
    ...(event.byteCount === undefined ? {} : { byteCount: event.byteCount }),
    ...(event.operationCount === undefined ? {} : { operationCount: event.operationCount }),
    ...(event.transition === undefined ? {} : { transition: event.transition }),
    outcome: event.outcome,
  });
  emit(serialized);
  return serialized;
}
