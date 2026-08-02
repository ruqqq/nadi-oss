import { z } from "zod";
// A pure, dependency-free type from the ledger's classification module — the
// store persists exactly what `classifyWork` consumes, so there is one shape.
import type { CurrentGeneration } from "../agent/work-ledger";
import type { BackendProcessReference, BackendReference, ComputeProviderId } from "./backend";
import {
  DEFAULT_COMPUTE_LIMITS,
  DEFAULT_COMPUTE_RESOURCE_PROFILE,
  parseProviderConfigJson,
  validateComputeResourceProfile,
} from "./config";
import { trimUtf8, type OutputChunkView } from "./output";
import type { ComputeOutputLimits, ComputeResourceProfile, ProviderConfig } from "./types";
import type { WatcherRow } from "./watchers";

const THREAD_COMPUTE_STORE_SCHEMA = "thread_compute_store";
const THREAD_COMPUTE_STORE_SCHEMA_VERSION = 2;

const backendReferenceSchema = z.object({
  provider: z.string().min(1),
  version: z.literal(1),
  payload: z.any(),
});

export type ComputeStateStatus =
  | "acquiring"
  | "active"
  | "releasing"
  | "recoverable"
  | "discarding"
  | "absent"
  | "error";

export interface ComputeState {
  id: string;
  status: ComputeStateStatus;
  provider: ComputeProviderId | null;
  providerConfig: ProviderConfig | null;
  /** Policy supplied when this provider runtime was acquired; undefined means a legacy unknown. */
  acquiredAllowedHosts: string[] | null | undefined;
  runtimeRef: BackendReference | null;
  recoveryRef: BackendReference | null;
  resourceProfile: ComputeResourceProfile;
  createdAt: number;
  lastUsedAt: number;
  releaseAt: number | null;
  recoveredAt: number | null;
  recoveryExpiresAt: number | null;
  errorCode: string | null;
  errorDetail: string | null;
  releaseReason: string | null;
  /**
   * The sandbox generation nonce for the CURRENT container, or null when
   * unknown/not yet provisioned. Persisted here — not on the compute service
   * instance — because it is per-container state: a service is constructed
   * fresh on every `resolveComputeService(...)` call, so an in-memory field
   * would never survive across instances (the reaper always sees null, and a
   * new instance would overwrite a healthy container's nonce on first touch).
   */
  generation: string | null;
  /**
   * When a probe last saw the container ANSWER with its nonce gone — i.e. the
   * filesystem was wiped under a live container. Null when that has not been
   * observed. Distinct from `generation: null`, which only means "unknown":
   * collapsing the two made `sandbox_reset` unreachable in production. Read
   * these two as one value via `ThreadComputeService.getGenerationView()`.
   */
  generationAbsentAt: number | null;
}

export type ComputeProcessStatus = "running" | "exited" | "failed" | "stopped";

export interface ComputeProcessRecord {
  id: string;
  backendProcessRef: BackendProcessReference | null;
  command: string;
  cwd: string | null;
  status: ComputeProcessStatus;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutLines: number;
  stderrLines: number;
  outputTruncated: boolean;
  label: string | null;
}

interface ComputeStateRow extends Record<string, string | number | null> {
  id: string;
  status: string;
  provider: string | null;
  provider_config_json: string | null;
  acquired_allowed_hosts_json: string | null;
  runtime_ref_json: string | null;
  recovery_ref_json: string | null;
  resource_profile: string;
  created_at: number;
  last_used_at: number;
  release_at: number | null;
  recovered_at: number | null;
  recovery_expires_at: number | null;
  error_code: string | null;
  error_detail: string | null;
  release_reason: string | null;
  generation: string | null;
  generation_absent_at: number | null;
}

interface ComputeProcessRow extends Record<string, string | number | null> {
  id: string;
  backend_process_ref_json: string | null;
  command: string;
  cwd: string | null;
  status: string;
  exit_code: number | null;
  started_at: number;
  finished_at: number | null;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_lines: number;
  stderr_lines: number;
  output_truncated: number;
  label: string | null;
}

interface ComputeOutputChunkRow extends Record<string, string | number | null> {
  id: number;
  process_id: string;
  stream: string;
  chunk_index: number;
  byte_start: number;
  byte_end: number;
  line_start: number;
  line_end: number;
  text: string;
  created_at: number;
}

interface ComputeProcessWatcherRow extends Record<string, string | number | null> {
  process_id: string;
  deadline_at: number;
  poll_interval_ms: number;
  next_poll_at: number;
  label: string | null;
  created_at: number;
}

export interface LegacySandboxStateRow extends Record<string, string | number | null> {
  id: string;
  provider: string;
  provider_sandbox_id: string | null;
  status: string;
  created_at: number;
  last_used_at: number;
  evict_at: number | null;
  error: string | null;
  pending_resource_package: string | null;
  active_resource_package: string | null;
  suspended_at: number | null;
  suspend_expires_at: number | null;
  suspend_reason: string | null;
}

export interface LegacySandboxProcessRow extends Record<string, string | number | null> {
  id: string;
  provider_session_id: string | null;
  provider_command_id: string | null;
}

function parseBackendReference(raw: string | null): BackendReference | null {
  if (raw === null) return null;
  try {
    return backendReferenceSchema.parse(JSON.parse(raw)) as BackendReference;
  } catch {
    return null;
  }
}

function serializeBackendReference(reference: BackendReference | null): string | null {
  if (reference === null) return null;
  return JSON.stringify(backendReferenceSchema.parse(reference));
}

function parseProviderConfigSnapshot(raw: string | null): ProviderConfig | null {
  if (raw === null) return null;
  try {
    return parseProviderConfigJson(raw);
  } catch {
    return null;
  }
}

function parseAllowedHostsSnapshot(raw: string | null): string[] | null | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null) return null;
    if (Array.isArray(parsed) && parsed.every((host) => typeof host === "string")) return parsed;
  } catch {
    // Malformed snapshots are unknown and therefore fail closed for explicit Daytona policies.
  }
  return undefined;
}

function serializeProviderConfigSnapshot(providerConfig: ProviderConfig | null): string | null {
  return providerConfig === null ? null : JSON.stringify(providerConfig);
}

function legacyStateStatus(status: string): ComputeStateStatus {
  switch (status) {
    case "creating":
      return "acquiring";
    case "ready":
      return "active";
    case "suspended":
      return "recoverable";
    case "evicted":
    case "deleted":
      return "absent";
    case "error":
      return "error";
    default:
      return "absent";
  }
}

function legacyResourceProfile(row: LegacySandboxStateRow): ComputeResourceProfile {
  const value = row.active_resource_package ?? row.pending_resource_package;
  return value ? validateComputeResourceProfile(value) : DEFAULT_COMPUTE_RESOURCE_PROFILE;
}

// Backfilled references must carry the same kind-tagged, provider-opaque shapes
// the Daytona backend parses (see backends/daytona.ts `daytonaReferenceSchema`).
// Exported for the round-trip regression test that feeds these into the backend.
export function legacyRuntimeReference(row: LegacySandboxStateRow): BackendReference | null {
  if (row.status !== "ready" || row.provider_sandbox_id === null) return null;
  return {
    provider: row.provider,
    version: 1,
    payload: { kind: "runtime", sandboxId: row.provider_sandbox_id },
  };
}

export function legacyRecoveryReference(row: LegacySandboxStateRow): BackendReference | null {
  if (row.status !== "suspended" || row.provider_sandbox_id === null) return null;
  return {
    provider: row.provider,
    version: 1,
    payload: { kind: "recovery", sandboxId: row.provider_sandbox_id },
  };
}

export function legacyProcessReference(
  row: LegacySandboxProcessRow,
  sandboxId: string | null,
): BackendProcessReference | null {
  if (sandboxId === null || row.provider_session_id === null || row.provider_command_id === null) {
    return null;
  }
  return {
    provider: "daytona",
    version: 1,
    payload: {
      kind: "process",
      sandboxId,
      sessionId: row.provider_session_id,
      commandId: row.provider_command_id,
    },
  };
}

function rowToComputeState(row: ComputeStateRow): ComputeState {
  return {
    id: row.id,
    status: row.status as ComputeStateStatus,
    provider: row.provider,
    providerConfig: parseProviderConfigSnapshot(row.provider_config_json),
    acquiredAllowedHosts: parseAllowedHostsSnapshot(row.acquired_allowed_hosts_json),
    runtimeRef: parseBackendReference(row.runtime_ref_json),
    recoveryRef: parseBackendReference(row.recovery_ref_json),
    resourceProfile: validateComputeResourceProfile(row.resource_profile),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    releaseAt: row.release_at,
    recoveredAt: row.recovered_at,
    recoveryExpiresAt: row.recovery_expires_at,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    releaseReason: row.release_reason,
    generation: row.generation,
    generationAbsentAt: row.generation_absent_at,
  };
}

function rowToComputeProcess(row: ComputeProcessRow): ComputeProcessRecord {
  return {
    id: row.id,
    backendProcessRef: parseBackendReference(row.backend_process_ref_json),
    command: row.command,
    cwd: row.cwd,
    status: row.status as ComputeProcessStatus,
    exitCode: row.exit_code,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    stdoutBytes: row.stdout_bytes,
    stderrBytes: row.stderr_bytes,
    stdoutLines: row.stdout_lines,
    stderrLines: row.stderr_lines,
    outputTruncated: row.output_truncated !== 0,
    label: row.label,
  };
}

function rowToOutputChunk(row: ComputeOutputChunkRow): OutputChunkView {
  return {
    stream: row.stream as "stdout" | "stderr",
    lineStart: row.line_start,
    lineEnd: row.line_end,
    byteStart: row.byte_start,
    byteEnd: row.byte_end,
    text: row.text,
  };
}

function rowToWatcher(row: ComputeProcessWatcherRow): WatcherRow {
  return {
    processId: row.process_id,
    deadlineAt: row.deadline_at,
    pollIntervalMs: row.poll_interval_ms,
    nextPollAt: row.next_poll_at,
    label: row.label,
    createdAt: row.created_at,
  };
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function countLines(text: string): number {
  return text.split(/(?<=\n)/g).filter(Boolean).length;
}

export class ThreadComputeStore {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly limits: ComputeOutputLimits = DEFAULT_COMPUTE_LIMITS,
  ) {}

  migrate(): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS compute_store_schema (
          name text primary key,
          version integer not null
        )
      `);
      this.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS compute_state (
          id text primary key,
          status text not null,
          provider text,
          provider_config_json text,
          acquired_allowed_hosts_json text,
          runtime_ref_json text,
          recovery_ref_json text,
          resource_profile text not null,
          created_at integer not null,
          last_used_at integer not null,
          release_at integer,
          recovered_at integer,
          recovery_expires_at integer,
          error_code text,
          error_detail text,
          -- retention_mode: dead column, kept physically rather than dropped.
          -- The "coding work active" flag and retention-mode enum it backed
          -- were removed in favor of the verified sandbox:declared-clean bit
          -- + git probe. Nothing reads this column for any decision; every
          -- write hardcodes 'ephemeral' (see writeState). This is Durable
          -- Object SQLite, not D1 — there is no drizzle-generated migration
          -- path here, only ad hoc ALTER TABLE run per-DO on next migrate().
          -- A DROP COLUMN would need to run once per thread DO with no
          -- existing precedent or rollback story in this file (contrast
          -- ensureGenerationColumn's additive-only ALTER TABLE ADD COLUMN),
          -- so it is left in place rather than forced for tidiness.
          retention_mode text not null,
          release_reason text,
          generation text,
          generation_absent_at integer
        )
      `);

      // Capture BEFORE the create-if-not-exists, or the flag is always true.
      const hasLegacyProcesses = this.hasTable("sandbox_processes");
      this.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sandbox_processes (
          id text primary key,
          provider_session_id text,
          provider_command_id text,
          backend_process_ref_json text,
          command text not null,
          cwd text,
          status text not null,
          exit_code integer,
          started_at integer not null,
          finished_at integer,
          stdout_bytes integer not null default 0,
          stderr_bytes integer not null default 0,
          stdout_lines integer not null default 0,
          stderr_lines integer not null default 0,
          output_truncated integer not null default 0,
          label text
        )
      `);
      this.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sandbox_output_chunks (
          id integer primary key autoincrement,
          process_id text not null,
          stream text not null,
          chunk_index integer not null,
          byte_start integer not null,
          byte_end integer not null,
          line_start integer not null,
          line_end integer not null,
          text text not null,
          created_at integer not null
        )
      `);
      this.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sandbox_process_watchers (
          process_id text primary key,
          deadline_at integer not null,
          poll_interval_ms integer not null,
          next_poll_at integer not null,
          label text,
          created_at integer not null
        )
      `);
      this.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sandbox_auto_watched (
          process_id text primary key,
          at integer not null
        )
      `);

      this.ensureProcessReferenceColumn();
      this.ensureComputeStateAdditiveColumns();

      const version = this.storage.sql
        .exec<{ version: number }>(
          "SELECT version FROM compute_store_schema WHERE name = ?",
          THREAD_COMPUTE_STORE_SCHEMA,
        )
        .toArray()[0]?.version;
      if (version === THREAD_COMPUTE_STORE_SCHEMA_VERSION) return;

      if (this.hasTable("sandbox_state")) this.backfillLegacyState();
      if (hasLegacyProcesses) this.backfillLegacyProcesses();
      this.storage.sql.exec(
        `INSERT INTO compute_store_schema (name, version) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET version = excluded.version`,
        THREAD_COMPUTE_STORE_SCHEMA,
        THREAD_COMPUTE_STORE_SCHEMA_VERSION,
      );
    });
  }

  getComputeState(): ComputeState | null {
    const row = this.storage.sql
      .exec<ComputeStateRow>("SELECT * FROM compute_state ORDER BY created_at DESC LIMIT 1")
      .toArray()[0];
    return row ? rowToComputeState(row) : null;
  }

  getProcess(id: string): ComputeProcessRecord | null {
    if (!this.hasTable("sandbox_processes")) return null;
    const row = this.storage.sql
      .exec<ComputeProcessRow>("SELECT * FROM sandbox_processes WHERE id = ?", id)
      .toArray()[0];
    return row ? rowToComputeProcess(row) : null;
  }

  createProcess(process: ComputeProcessRecord): void {
    this.storage.sql.exec(
      `INSERT INTO sandbox_processes
        (id, provider_session_id, provider_command_id, backend_process_ref_json, command, cwd,
         status, exit_code, started_at, finished_at, stdout_bytes, stderr_bytes, stdout_lines,
         stderr_lines, output_truncated, label)
       VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      process.id,
      serializeBackendReference(process.backendProcessRef),
      process.command,
      process.cwd,
      process.status,
      process.exitCode,
      process.startedAt,
      process.finishedAt,
      process.stdoutBytes,
      process.stderrBytes,
      process.stdoutLines,
      process.stderrLines,
      process.outputTruncated ? 1 : 0,
      process.label,
    );
  }

  updateProcess(id: string, patch: Partial<ComputeProcessRecord>): void {
    const columns: Record<keyof ComputeProcessRecord, string> = {
      id: "id",
      backendProcessRef: "backend_process_ref_json",
      command: "command",
      cwd: "cwd",
      status: "status",
      exitCode: "exit_code",
      startedAt: "started_at",
      finishedAt: "finished_at",
      stdoutBytes: "stdout_bytes",
      stderrBytes: "stderr_bytes",
      stdoutLines: "stdout_lines",
      stderrLines: "stderr_lines",
      outputTruncated: "output_truncated",
      label: "label",
    };
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const key of Object.keys(patch) as Array<keyof ComputeProcessRecord>) {
      if (key === "id") continue;
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${columns[key]} = ?`);
      if (key === "backendProcessRef") {
        values.push(serializeBackendReference(value as BackendProcessReference | null));
      } else if (key === "outputTruncated") {
        values.push(value ? 1 : 0);
      } else {
        values.push(value as string | number | null);
      }
    }
    if (sets.length === 0) return;
    values.push(id);
    this.storage.sql.exec(
      `UPDATE sandbox_processes SET ${sets.join(", ")} WHERE id = ?`,
      ...values,
    );
  }

  listProcesses(limit: number): ComputeProcessRecord[] {
    return this.storage.sql
      .exec<ComputeProcessRow>(
        "SELECT * FROM sandbox_processes ORDER BY started_at DESC LIMIT ?",
        limit,
      )
      .toArray()
      .map(rowToComputeProcess);
  }

  appendOutput(input: {
    processId: string;
    stream: "stdout" | "stderr";
    text: string;
    now: number;
  }): void {
    if (input.text.length === 0) return;
    const remaining = Math.min(
      this.limits.maxProcessOutputBytes - this.processOutputBytes(input.processId),
      this.limits.maxThreadOutputBytes - this.threadOutputBytes(),
    );
    if (remaining <= 0) {
      this.markProcessTruncated(input.processId);
      return;
    }

    let text = input.text;
    let truncated = false;
    if (utf8ByteLength(text) > remaining) {
      text = trimUtf8(text, remaining);
      truncated = true;
    }
    if (text.length === 0) {
      this.markProcessTruncated(input.processId);
      return;
    }

    const last = this.storage.sql
      .exec<ComputeOutputChunkRow>(
        `SELECT * FROM sandbox_output_chunks WHERE process_id = ? AND stream = ?
         ORDER BY chunk_index DESC LIMIT 1`,
        input.processId,
        input.stream,
      )
      .toArray()[0];
    if (last && !last.text.endsWith("\n")) {
      const mergedText = last.text + text;
      this.storage.sql.exec(
        `UPDATE sandbox_output_chunks
         SET text = ?, byte_end = ?, line_end = ?, created_at = ? WHERE id = ?`,
        mergedText,
        last.byte_start + utf8ByteLength(mergedText),
        last.line_start + Math.max(countLines(mergedText), 1) - 1,
        input.now,
        last.id,
      );
      if (truncated) this.markProcessTruncated(input.processId);
      return;
    }

    const chunkIndex = (last?.chunk_index ?? -1) + 1;
    const byteStart = last?.byte_end ?? 0;
    const lineStart = (last?.line_end ?? 0) + 1;
    this.storage.sql.exec(
      `INSERT INTO sandbox_output_chunks
        (process_id, stream, chunk_index, byte_start, byte_end, line_start, line_end, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.processId,
      input.stream,
      chunkIndex,
      byteStart,
      byteStart + utf8ByteLength(text),
      lineStart,
      lineStart + Math.max(countLines(text), 1) - 1,
      text,
      input.now,
    );
    if (truncated) this.markProcessTruncated(input.processId);
  }

  listOutputChunks(processId: string, stream?: "stdout" | "stderr"): OutputChunkView[] {
    const rows = stream
      ? this.storage.sql
          .exec<ComputeOutputChunkRow>(
            `SELECT * FROM sandbox_output_chunks
             WHERE process_id = ? AND stream = ? ORDER BY chunk_index ASC`,
            processId,
            stream,
          )
          .toArray()
      : this.storage.sql
          .exec<ComputeOutputChunkRow>(
            `SELECT * FROM sandbox_output_chunks
             WHERE process_id = ? ORDER BY chunk_index ASC`,
            processId,
          )
          .toArray();
    return rows.map(rowToOutputChunk);
  }

  upsertWatcher(row: WatcherRow): void {
    this.storage.sql.exec(
      `INSERT INTO sandbox_process_watchers
        (process_id, deadline_at, poll_interval_ms, next_poll_at, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(process_id) DO UPDATE SET
        deadline_at = excluded.deadline_at,
        poll_interval_ms = excluded.poll_interval_ms,
        next_poll_at = excluded.next_poll_at,
        label = excluded.label,
        created_at = excluded.created_at`,
      row.processId,
      row.deadlineAt,
      row.pollIntervalMs,
      row.nextPollAt,
      row.label,
      row.createdAt,
    );
  }

  deleteWatcher(processId: string): void {
    this.storage.sql.exec("DELETE FROM sandbox_process_watchers WHERE process_id = ?", processId);
  }

  listWatchers(): WatcherRow[] {
    return this.storage.sql
      .exec<ComputeProcessWatcherRow>("SELECT * FROM sandbox_process_watchers")
      .toArray()
      .map(rowToWatcher);
  }

  countWatchers(): number {
    return (
      this.storage.sql
        .exec<{ total: number }>("SELECT COUNT(*) AS total FROM sandbox_process_watchers")
        .toArray()[0]?.total ?? 0
    );
  }

  markProcessAutoWatched(processId: string, now: number): void {
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO sandbox_auto_watched (process_id, at) VALUES (?, ?)",
      processId,
      now,
    );
  }

  wasProcessAutoWatched(processId: string): boolean {
    return (
      this.storage.sql
        .exec("SELECT 1 FROM sandbox_auto_watched WHERE process_id = ? LIMIT 1", processId)
        .toArray().length > 0
    );
  }

  markAcquiring(input: {
    provider: ComputeProviderId;
    providerConfig?: ProviderConfig | null;
    allowedHosts?: string[] | null;
    resourceProfile: ComputeResourceProfile;
    now: number;
    recoveryRef?: BackendReference | null;
  }): void {
    const current = this.getComputeState();
    this.writeState({
      ...this.baseState(current, input.now),
      status: "acquiring",
      provider: input.provider,
      providerConfig: input.providerConfig ?? current?.providerConfig ?? null,
      acquiredAllowedHosts: input.allowedHosts,
      runtimeRef: null,
      recoveryRef: input.recoveryRef ?? current?.recoveryRef ?? null,
      resourceProfile: input.resourceProfile,
      errorCode: null,
      errorDetail: null,
      // Only called when NOT resuming from a recovery snapshot (see
      // readOrAcquireRuntime's `!recovery` guard) — a genuinely new container
      // is about to be acquired, so any nonce from a previous container must
      // not survive to be inherited by it.
      generation: null,
      generationAbsentAt: null,
    });
  }

  markActive(runtimeRef: BackendReference, now: number): void {
    const current = this.getComputeState();
    this.writeState({
      ...this.baseState(current, now),
      status: "active",
      provider: runtimeRef.provider,
      providerConfig: current?.providerConfig ?? null,
      runtimeRef,
      recoveryRef: null,
      recoveredAt: current?.recoveryRef ? now : (current?.recoveredAt ?? null),
      recoveryExpiresAt: null,
      errorCode: null,
      errorDetail: null,
    });
  }

  markReleasing(now: number): void {
    const current = this.getComputeState();
    if (!current) return;
    this.writeState({
      ...this.baseState(current, now),
      status: "releasing",
      releaseAt: now,
      errorCode: null,
      errorDetail: null,
    });
  }

  markRecoverable(recoveryRef: BackendReference, now: number, recoveryExpiresAt: number): void {
    const current = this.getComputeState();
    this.writeState({
      ...this.baseState(current, now),
      status: "recoverable",
      provider: recoveryRef.provider,
      providerConfig: current?.providerConfig ?? null,
      runtimeRef: null,
      recoveryRef,
      recoveryExpiresAt,
      errorCode: null,
      errorDetail: null,
    });
  }

  markDiscarding(now: number): void {
    const current = this.getComputeState();
    if (!current) return;
    // The container is being torn down; whatever replaces it must not inherit
    // this nonce — nor the absence observation, which describes a container
    // that is about to stop existing. The two columns always move together.
    this.writeState({
      ...this.baseState(current, now),
      status: "discarding",
      releaseAt: now,
      acquiredAllowedHosts: undefined,
      generation: null,
      generationAbsentAt: null,
    });
  }

  markAbsent(now: number): void {
    const current = this.getComputeState();
    this.writeState({
      ...this.baseState(current, now),
      status: "absent",
      provider: null,
      providerConfig: null,
      acquiredAllowedHosts: undefined,
      runtimeRef: null,
      recoveryRef: null,
      recoveryExpiresAt: null,
      errorCode: null,
      errorDetail: null,
      // No container exists in this state; clear BOTH so a future container
      // never adopts a stale nonce it never wrote, nor an absence observed
      // against a container that is already gone. The two columns always move
      // together (see `setGeneration`).
      generation: null,
      generationAbsentAt: null,
    });
  }

  touchLastUsed(now: number): void {
    this.storage.sql.exec("UPDATE compute_state SET last_used_at = ?", now);
  }

  /**
   * Persist the resource profile for the next environment acquisition, creating
   * an absent-state row if none exists yet. Preserves all other state fields, so
   * it is only meaningful before a runtime is live.
   */
  setResourceProfile(resourceProfile: ComputeResourceProfile, now: number): void {
    const current = this.getComputeState();
    this.writeState({ ...this.baseState(current, now), resourceProfile });
  }

  markError(input: { code: string; detail: string }, now: number): void {
    const current = this.getComputeState();
    this.writeState({
      ...this.baseState(current, now),
      status: "error",
      errorCode: input.code,
      errorDetail: input.detail,
    });
  }

  private processOutputBytes(processId: string): number {
    return (
      this.storage.sql
        .exec<{ total: number | null }>(
          `SELECT COALESCE(SUM(byte_end - byte_start), 0) AS total
           FROM sandbox_output_chunks WHERE process_id = ?`,
          processId,
        )
        .toArray()[0]?.total ?? 0
    );
  }

  private threadOutputBytes(): number {
    return (
      this.storage.sql
        .exec<{ total: number | null }>(
          "SELECT COALESCE(SUM(byte_end - byte_start), 0) AS total FROM sandbox_output_chunks",
        )
        .toArray()[0]?.total ?? 0
    );
  }

  private markProcessTruncated(processId: string): void {
    this.storage.sql.exec(
      "UPDATE sandbox_processes SET output_truncated = 1 WHERE id = ?",
      processId,
    );
  }

  private hasTable(name: string): boolean {
    return (
      this.storage.sql
        .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name)
        .toArray().length > 0
    );
  }

  private ensureProcessReferenceColumn(): void {
    const columns = this.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(sandbox_processes)")
      .toArray();
    if (!columns.some((column) => column.name === "backend_process_ref_json")) {
      this.storage.sql.exec(
        "ALTER TABLE sandbox_processes ADD COLUMN backend_process_ref_json text",
      );
    }
  }

  /**
   * Additive columns for existing `compute_state` rows; existing rows survive
   * with `generation = NULL` and `generation_absent_at = NULL`, which reads as
   * "unknown" — never as a reset (see `classifyWork`).
   */
  private ensureComputeStateAdditiveColumns(): void {
    const columns = this.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(compute_state)")
      .toArray();
    if (!columns.some((column) => column.name === "provider_config_json")) {
      this.storage.sql.exec("ALTER TABLE compute_state ADD COLUMN provider_config_json text");
    }
    if (!columns.some((column) => column.name === "acquired_allowed_hosts_json")) {
      this.storage.sql.exec(
        "ALTER TABLE compute_state ADD COLUMN acquired_allowed_hosts_json text",
      );
    }
    if (!columns.some((column) => column.name === "generation")) {
      this.storage.sql.exec("ALTER TABLE compute_state ADD COLUMN generation text");
    }
    if (!columns.some((column) => column.name === "generation_absent_at")) {
      this.storage.sql.exec("ALTER TABLE compute_state ADD COLUMN generation_absent_at integer");
    }
  }

  private backfillLegacyState(): void {
    const rows = this.storage.sql
      .exec<LegacySandboxStateRow>("SELECT * FROM sandbox_state")
      .toArray();
    for (const row of rows) {
      const status = legacyStateStatus(row.status);
      const runtimeRef = status === "active" ? legacyRuntimeReference(row) : null;
      const recoveryRef = status === "recoverable" ? legacyRecoveryReference(row) : null;
      this.writeState({
        id: row.id,
        status,
        provider: row.provider,
        providerConfig: null,
        acquiredAllowedHosts: undefined,
        runtimeRef,
        recoveryRef,
        resourceProfile: legacyResourceProfile(row),
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        releaseAt: row.evict_at,
        recoveredAt: row.suspended_at,
        recoveryExpiresAt: row.suspend_expires_at,
        errorCode: row.error === null ? null : "legacy_error",
        errorDetail: row.error,
        releaseReason: row.suspend_reason,
        // Legacy rows predate the nonce; the reaper treats null as "unknown",
        // never as a reset (see classifyWork).
        generation: null,
        generationAbsentAt: null,
      });
    }
  }

  private backfillLegacyProcesses(): void {
    // Legacy `sandbox_state` holds a single logical row; its provider sandbox id
    // owns every legacy process and is required by the kind-tagged process ref.
    const sandboxId = this.legacySandboxId();
    const rows = this.storage.sql
      .exec<LegacySandboxProcessRow>(
        "SELECT id, provider_session_id, provider_command_id FROM sandbox_processes",
      )
      .toArray();
    for (const row of rows) {
      this.storage.sql.exec(
        "UPDATE sandbox_processes SET backend_process_ref_json = ? WHERE id = ?",
        serializeBackendReference(legacyProcessReference(row, sandboxId)),
        row.id,
      );
    }
  }

  private legacySandboxId(): string | null {
    if (!this.hasTable("sandbox_state")) return null;
    const row = this.storage.sql
      .exec<{ provider_sandbox_id: string | null }>(
        "SELECT provider_sandbox_id FROM sandbox_state ORDER BY created_at DESC LIMIT 1",
      )
      .toArray()[0];
    return row?.provider_sandbox_id ?? null;
  }

  private baseState(current: ComputeState | null, now: number): ComputeState {
    return (
      current ?? {
        id: "thread",
        status: "absent",
        provider: null,
        providerConfig: null,
        acquiredAllowedHosts: undefined,
        runtimeRef: null,
        recoveryRef: null,
        resourceProfile: DEFAULT_COMPUTE_RESOURCE_PROFILE,
        createdAt: now,
        lastUsedAt: now,
        releaseAt: null,
        recoveredAt: null,
        recoveryExpiresAt: null,
        errorCode: null,
        errorDetail: null,
        releaseReason: null,
        generation: null,
        generationAbsentAt: null,
      }
    );
  }

  private writeState(state: ComputeState): void {
    this.storage.sql.exec(
      `INSERT INTO compute_state
        (id, status, provider, provider_config_json, acquired_allowed_hosts_json, runtime_ref_json, recovery_ref_json, resource_profile, created_at, last_used_at,
         release_at, recovered_at, recovery_expires_at, error_code, error_detail, retention_mode, release_reason,
         generation, generation_absent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ephemeral', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        provider = excluded.provider,
        provider_config_json = excluded.provider_config_json,
        acquired_allowed_hosts_json = excluded.acquired_allowed_hosts_json,
        runtime_ref_json = excluded.runtime_ref_json,
        recovery_ref_json = excluded.recovery_ref_json,
        resource_profile = excluded.resource_profile,
        created_at = excluded.created_at,
        last_used_at = excluded.last_used_at,
        release_at = excluded.release_at,
        recovered_at = excluded.recovered_at,
        recovery_expires_at = excluded.recovery_expires_at,
        error_code = excluded.error_code,
        error_detail = excluded.error_detail,
        retention_mode = excluded.retention_mode,
        release_reason = excluded.release_reason,
        generation = excluded.generation,
        generation_absent_at = excluded.generation_absent_at`,
      state.id,
      state.status,
      state.provider,
      serializeProviderConfigSnapshot(state.providerConfig),
      state.acquiredAllowedHosts === undefined ? null : JSON.stringify(state.acquiredAllowedHosts),
      serializeBackendReference(state.runtimeRef),
      serializeBackendReference(state.recoveryRef),
      state.resourceProfile,
      state.createdAt,
      state.lastUsedAt,
      state.releaseAt,
      state.recoveredAt,
      state.recoveryExpiresAt,
      state.errorCode,
      state.errorDetail,
      state.releaseReason,
      state.generation,
      state.generationAbsentAt,
    );
  }

  /**
   * Persist what is known about the CURRENT container's generation. Called once
   * per container by `readOrAcquireRuntime` (the single genuine provision site
   * — fresh acquire and recovery restore alike, always with `known`) and by the
   * watcher poll-failure probe (with whatever it actually observed, including
   * `unknown`). Nothing writes a NONCE lazily: this only records observations
   * into the store, and never touches the container's filesystem.
   *
   * The three arms are stored as two columns and must move together — writing
   * the whole state on every call is what keeps them from drifting.
   *
   * `unknown` PRESERVES an existing absence observation rather than erasing it.
   * That asymmetry is deliberate. An `absent` observation is positive evidence
   * about a moment in time; a later `unreadable` probe is absence of evidence,
   * not evidence that the wipe un-happened. Erasing on `unknown` made detection
   * a race — absent -> (one transient blip) -> unknown dropped the only signal a
   * reset ever leaves before the sweep could act on it.
   *
   * Preserving cannot strand a stale absence, because every authoritative
   * supersede still clears it: a genuine provision writes `known` (below), and
   * `markAcquiring`/`markAbsent`/`markDiscarding` clear both columns. And it
   * cannot over-fault, because `classifyWork` only treats `absent` as a reset
   * for rows that started strictly BEFORE `observedAt`.
   *
   * `absent` is likewise write-ONCE: an absence already on record keeps its
   * original `observedAt`. That bound means "when the wipe was first SEEN", and
   * re-stamping it on every later probe silently redefined it as "just now" —
   * the false-fault seam. Cloudflare returns a WORKING container after a wipe,
   * so nothing re-provisions and nothing rewrites the nonce; a container can
   * stay nonce-less indefinitely, and each re-stamp would fault the healthy
   * work that started after the wipe as though a fresh reset had just eaten it.
   * A second wipe of an already-nonce-less container leaves no new evidence to
   * record anyway, and the rows started during the absence carry
   * `UNKNOWN_GENERATION`, so there is nothing a newer timestamp could honestly
   * say.
   */
  setGeneration(generation: CurrentGeneration, now: number): void {
    const current = this.getComputeState();
    this.writeState({
      ...this.baseState(current, now),
      generation: generation.kind === "known" ? generation.nonce : null,
      generationAbsentAt:
        generation.kind === "absent"
          ? (current?.generationAbsentAt ?? generation.observedAt)
          : generation.kind === "known"
            ? null
            : (current?.generationAbsentAt ?? null),
    });
  }
}
