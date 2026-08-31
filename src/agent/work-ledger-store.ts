import type { WorkKind, WorkProgress, WorkRow, WorkStopActor, WorkTerminal } from "./work-ledger";

const WORK_LEDGER_SCHEMA = "agent_work_ledger";
const WORK_LEDGER_SCHEMA_VERSION = 5;

/**
 * The surface the compute layer is handed (see `WorkLedgerSink` in
 * thread-service.ts).
 *
 * ASYNC by contract even though {@link WorkLedgerStore} answers every one of
 * these synchronously from DO SQLite. The compute service no longer runs in the
 * DO that owns the ledger: `AgentSandbox` owns the machine while the ledger
 * stays on the thread DO (subagent rows live there and the reaper reads them),
 * so the sink the sandbox is handed is an RPC back-call. A synchronous sink
 * cannot cross that boundary, and a sink the sandbox simply does not get is
 * worse than either — every register/terminalize/markDelivered would silently
 * no-op. In production the sink is ALWAYS that back-call — no in-process store
 * is ever handed to compute any more; {@link localWorkLedgerSink} survives only
 * for tests that construct the service directly.
 *
 * Mostly writes — liveness, terminal, delivery — plus one
 * read (`isDelivered`), needed so a terminal writer can ask whether someone
 * else already told the model before it speaks. Deliberately narrow either
 * way: compute reports and reads liveness about processes and never learns
 * that subagents share the ledger.
 */
export interface WorkLedgerSink {
  register(row: WorkRow): Promise<void>;
  stampAlive(id: string, at: number): Promise<void>;
  /**
   * Close a row at the moment the work actually settles. The compute layer is
   * the only thing that ever observes a real process exit/stop, so without
   * this the reaper is the sole closer and would re-report every cleanly
   * exited process as a `no_liveness` fault one `PROCESS_STALE_AFTER_MS`
   * later. Returns the
   * exactly-once gate (see {@link WorkLedgerStore.terminalize}).
   */
  terminalize(id: string, terminal: WorkTerminal): Promise<boolean>;
  /**
   * Discharge this row's notification obligation — see
   * {@link WorkLedgerStore.markDelivered}. On the sink because the compute layer
   * is a terminal WRITER, and every writer owes the model exactly one
   * notification: `pollWatcher` delivers a reminder and stamps on success,
   * `execStop` delivers nothing by design and stamps at terminalize time. Without
   * it here, compute could close a row but never declare who owed its delivery,
   * and the sweep had to GUESS from the terminal's reason — which is what let it
   * inject a second copy of a reminder `pollWatcher` had already sent.
   *
   * Still subagent-agnostic: this is "the model has been told about this row",
   * a statement compute can make about its own processes.
   */
  markDelivered(id: string, at: number): Promise<boolean>;
  /**
   * Whether the model has ALREADY been told about this row — see
   * {@link WorkLedgerStore.isDelivered}. On the sink because `markDelivered` is
   * claim-AFTER-success (a delivery that throws must stay owed and retryable),
   * which makes it a receipt, not a mutual-exclusion gate: two writers can each
   * believe they owe the same row. This is the read that lets the second one
   * find out before it speaks, and it is why a `refreshProcessOutput` throw on
   * the watcher poll path can no longer cost the model a duplicate card.
   */
  isDelivered(id: string): Promise<boolean>;
  /**
   * Drop a row without a terminal. For work the model deliberately walked away
   * from (`exec_unwatch`), where no terminal is truthful: the process did not
   * exit, was not stopped, and did not fault. Leaving the row open instead
   * would fault it as `no_liveness` once nothing stamps it, telling the model a
   * still-running process was "torn down".
   */
  deleteRow(id: string): Promise<void>;
}

interface WorkLedgerRow extends Record<string, string | number | null> {
  id: string;
  kind: string;
  started_at: number;
  last_alive_at: number;
  stale_after_ms: number;
  deadline_at: number;
  generation: string;
  terminal_outcome: string | null;
  terminal_reason: string | null;
  terminal_at: number | null;
  terminal_detail: string | null;
  terminal_exit_code: number | null;
  terminal_actor: string | null;
  delivered_at: number | null;
  cleared_at: number | null;
  progress_message: string | null;
  progress_phase: string | null;
  progress_at: number | null;
}

function toWorkRow(row: WorkLedgerRow): WorkRow {
  return {
    id: row.id,
    kind: row.kind as WorkKind,
    startedAt: row.started_at,
    lastAliveAt: row.last_alive_at,
    staleAfterMs: row.stale_after_ms,
    deadlineAt: row.deadline_at,
    generation: row.generation,
    terminal:
      row.terminal_outcome === null
        ? null
        : ({
            outcome: row.terminal_outcome,
            reason: row.terminal_reason,
            at: row.terminal_at,
            detail: row.terminal_detail ?? "",
            // Omitted (not `null`) when the column is null: keeps every row
            // built before this column existed passing a straight `toEqual`
            // against a `WorkTerminal` literal with no `exitCode` key at all.
            ...(row.terminal_exit_code === null ? {} : { exitCode: row.terminal_exit_code }),
            // Same omission convention, and the same reason as `exitCode`: an
            // abort nobody claimed (every row written before this column, plus
            // the SDK's own budget aborts) must keep comparing equal to a
            // terminal literal with no `actor` key.
            ...(row.terminal_actor === null ? {} : { actor: row.terminal_actor as WorkStopActor }),
          } as WorkTerminal),
    // Rows written before schema v2 have no column at all; the migration
    // backfills them, so a NULL here always means a genuinely owed delivery.
    deliveredAt: row.delivered_at ?? null,
    // Same omission convention as `exitCode` above, for the same reason: a
    // row that was never cleared must round-trip identically to how it did
    // before this column existed.
    ...(row.cleared_at === null ? {} : { clearedAt: row.cleared_at }),
    // `progress_at` is the presence test, not the message: a child may report a
    // `phase` with no `message` (or the reverse), so keying on either text
    // column would drop a real signal. Omitted rather than null for the same
    // round-trip reason as `clearedAt` above.
    ...(row.progress_at === null
      ? {}
      : {
          progress: {
            message: row.progress_message,
            phase: row.progress_phase,
            at: row.progress_at,
          },
        }),
  };
}

/**
 * Durable storage for the background work ledger. Owns its own schema name and
 * version — it is NOT part of `thread_compute_store`, because the ledger spans
 * subagent runs and the compute layer must stay subagent-agnostic.
 */
export class WorkLedgerStore implements SyncWorkLedgerSink {
  constructor(private readonly storage: DurableObjectStorage) {}

  migrate(): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS work_ledger_schema (
          name text primary key,
          version integer not null
        )
      `);
      this.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS background_work (
          id text primary key,
          kind text not null,
          started_at integer not null,
          last_alive_at integer not null,
          stale_after_ms integer not null,
          deadline_at integer not null,
          generation text not null,
          terminal_outcome text,
          terminal_reason text,
          terminal_at integer,
          terminal_detail text,
          delivered_at integer
        )
      `);
      // v1 -> v2, additive: split the delivery gate from the terminal write. A
      // deployed Worker reads rows written by v1, so probe rather than assume.
      const columns = this.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(background_work)")
        .toArray();
      if (!columns.some((column) => column.name === "delivered_at")) {
        this.storage.sql.exec("ALTER TABLE background_work ADD COLUMN delivered_at integer");
        // DEPLOY HAZARD, and the reason this sits INSIDE the ALTER branch: every
        // pre-existing terminal row would otherwise read as "owed a delivery"
        // and the sweep would replay a stale completion into every live thread.
        // The old code already delivered them, so stamp them delivered.
        //
        // `migrate()` runs on every DO start, so this must fire exactly once —
        // on the migration itself. Outside this branch it would re-run forever
        // and swallow a real pending delivery the sweep was about to retry.
        this.storage.sql.exec(
          `UPDATE background_work SET delivered_at = terminal_at
           WHERE terminal_outcome IS NOT NULL AND delivered_at IS NULL`,
        );
      }
      // v2 -> v3, additive: a structured exit code (`exitCode`, the
      // green-check-on-exit-7 fix) and a non-destructive "clear finished" flag.
      // Both are pure NULL-defaulted additions — no backfill needed, since NULL
      // is exactly the correct value for every row written before this column
      // existed (no exit code known / never cleared).
      if (!columns.some((column) => column.name === "terminal_exit_code")) {
        this.storage.sql.exec("ALTER TABLE background_work ADD COLUMN terminal_exit_code integer");
      }
      if (!columns.some((column) => column.name === "cleared_at")) {
        this.storage.sql.exec("ALTER TABLE background_work ADD COLUMN cleared_at integer");
      }
      // v4 -> v5, additive: WHO asked for a stop. NULL-defaulted with no
      // backfill — a pre-existing `stopped` row genuinely has no attribution
      // (the cancel path did not record one), and NULL is how the model is told
      // "stopped automatically" rather than being fed a guess.
      if (!columns.some((column) => column.name === "terminal_actor")) {
        this.storage.sql.exec("ALTER TABLE background_work ADD COLUMN terminal_actor text");
      }
      // v3 -> v4, additive: the last progress signal a subagent's child pushed
      // (see `WorkRow.progress` for why the parent stores it instead of asking
      // the SDK). NULL-defaulted with no backfill — NULL is correct for every
      // row written before this existed, since none of them ever reported one.
      if (!columns.some((column) => column.name === "progress_at")) {
        this.storage.sql.exec("ALTER TABLE background_work ADD COLUMN progress_message text");
        this.storage.sql.exec("ALTER TABLE background_work ADD COLUMN progress_phase text");
        this.storage.sql.exec("ALTER TABLE background_work ADD COLUMN progress_at integer");
      }
      this.storage.sql.exec(
        `INSERT INTO work_ledger_schema (name, version) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET version = excluded.version`,
        WORK_LEDGER_SCHEMA,
        WORK_LEDGER_SCHEMA_VERSION,
      );
    });
  }

  /**
   * Register work, or refresh an existing row. Re-registering never rewinds
   * `started_at` (the original start is the one that matters for the deadline)
   * and never resurrects a terminal row.
   */
  register(row: WorkRow): void {
    this.storage.sql.exec(
      `INSERT INTO background_work
         (id, kind, started_at, last_alive_at, stale_after_ms, deadline_at, generation,
          terminal_outcome, terminal_reason, terminal_at, terminal_detail, terminal_exit_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_alive_at = max(background_work.last_alive_at, excluded.last_alive_at),
         stale_after_ms = excluded.stale_after_ms,
         deadline_at = excluded.deadline_at,
         generation = excluded.generation`,
      row.id,
      row.kind,
      row.startedAt,
      row.lastAliveAt,
      row.staleAfterMs,
      row.deadlineAt,
      row.generation,
      row.terminal?.outcome ?? null,
      row.terminal?.reason ?? null,
      row.terminal?.at ?? null,
      row.terminal?.detail ?? null,
      row.terminal?.exitCode ?? null,
    );
  }

  /**
   * Record real infrastructure activity. A no-op for unknown or terminal rows,
   * and never moves time backwards — a late stamp must not un-stale a row.
   */
  stampAlive(id: string, at: number): void {
    this.storage.sql.exec(
      `UPDATE background_work
         SET last_alive_at = max(last_alive_at, ?)
       WHERE id = ? AND terminal_outcome IS NULL`,
      at,
      id,
    );
  }

  /**
   * Record a subagent's latest progress signal. Same guards as
   * {@link stampAlive}, for the same reasons: a no-op on an unknown or already
   * terminal row (a late push must not decorate a closed run), and time only
   * moves forward, so a stamp that arrives out of order cannot replace a newer
   * signal with an older one.
   *
   * All three columns move together under that one guard — a newer signal with
   * no `message` must not leave the previous signal's message stranded beside
   * a fresher `at`.
   */
  stampProgress(id: string, progress: WorkProgress): void {
    this.storage.sql.exec(
      `UPDATE background_work
         SET progress_message = ?, progress_phase = ?, progress_at = ?
       WHERE id = ? AND terminal_outcome IS NULL
         AND (progress_at IS NULL OR progress_at <= ?)`,
      progress.message,
      progress.phase,
      progress.at,
      id,
      progress.at,
    );
  }

  get(id: string): WorkRow | null {
    const row = this.storage.sql
      .exec<WorkLedgerRow>("SELECT * FROM background_work WHERE id = ?", id)
      .toArray()[0];
    return row ? toWorkRow(row) : null;
  }

  listOpen(): WorkRow[] {
    return this.storage.sql
      .exec<WorkLedgerRow>("SELECT * FROM background_work WHERE terminal_outcome IS NULL")
      .toArray()
      .map(toWorkRow);
  }

  listAll(): WorkRow[] {
    return this.storage.sql
      .exec<WorkLedgerRow>("SELECT * FROM background_work")
      .toArray()
      .map(toWorkRow);
  }

  /**
   * Open rows plus recently-terminal ones, newest first — the dock's read
   * path. Deliberately NOT `listOpen()`: the dock's whole gain over the two
   * views it replaces is showing a TERMINAL outcome, and `listOpen()` excludes
   * exactly those rows by definition.
   *
   * "Recent" is keyed on `delivered_at`, not `terminal_at`: a row's delivery
   * is the moment the model (and so the thread) actually learned the outcome,
   * which is what the dock should stay in sync with. `within` bounds how far
   * back a delivered terminal still counts as recent (the dock is a live
   * status surface, not history — `listAll` covers audit).
   *
   * A THIRD branch, `delivered_at IS NULL` on a terminal row, is not an edge
   * case — it is `listUndelivered()`'s exact set: "delivery owed and
   * retryable" (see that method's doc, and `WORK_DELIVERY_RETRY_MS`). Without
   * it, the moment a delivery throws is exactly the moment a row disappears
   * from the dock until the sweep retries — the moment a status surface is
   * most useful. An owed row has no age to bound: it stays visible until
   * delivered (then it ages out on the `within` window like any other).
   */
  listRecent(now = Date.now(), within = 10 * 60_000): WorkRow[] {
    return this.storage.sql
      .exec<WorkLedgerRow>(
        `SELECT * FROM background_work
         WHERE cleared_at IS NULL
           AND (terminal_outcome IS NULL
                OR delivered_at IS NULL
                OR delivered_at >= ?)
         ORDER BY started_at DESC`,
        now - within,
      )
      .toArray()
      .map(toWorkRow);
  }

  /**
   * "Clear finished" for the dock: mark every delivered terminal row so
   * `listRecent` stops returning it, WITHOUT deleting it. Deletion is exactly
   * the wrong tool here — see `WORK_ROW_RETENTION_MS`'s doc: a pruned id that
   * is later re-registered comes back as a fresh OPEN row and gets falsely
   * faulted `no_liveness` a stale window later, and that hazard does not care
   * whether the row was pruned by age or by this call.
   *
   * Scoped to `delivered_at IS NOT NULL` on purpose: an owed row (terminal but
   * undelivered) must stay visible and retryable — clearing it would hide the
   * one thing the sweep's retry list depends on being able to find, and the
   * model would never learn the outcome. Returns how many rows were newly
   * cleared, so a repeat call reports 0 rather than reasserting a stale count.
   */
  clearFinished(now: number): number {
    this.storage.sql.exec(
      `UPDATE background_work
         SET cleared_at = ?
       WHERE terminal_outcome IS NOT NULL AND delivered_at IS NOT NULL AND cleared_at IS NULL`,
      now,
    );
    return (
      this.storage.sql.exec<{ changes: number }>("SELECT changes() AS changes").toArray()[0]
        ?.changes ?? 0
    );
  }

  /**
   * Write the terminal. Returns true only for the transition that actually
   * terminalized the row — this is the exactly-once gate the caller uses to
   * decide whether to deliver a notification, so a repeat must return false.
   */
  terminalize(id: string, terminal: WorkTerminal): boolean {
    this.storage.sql.exec(
      `UPDATE background_work
         SET terminal_outcome = ?, terminal_reason = ?, terminal_at = ?, terminal_detail = ?,
             terminal_exit_code = ?, terminal_actor = ?
       WHERE id = ? AND terminal_outcome IS NULL`,
      terminal.outcome,
      terminal.reason,
      terminal.at,
      terminal.detail,
      terminal.exitCode ?? null,
      terminal.actor ?? null,
      id,
    );
    return (
      this.storage.sql.exec<{ changes: number }>("SELECT changes() AS changes").toArray()[0]
        ?.changes === 1
    );
  }

  /**
   * Close the DELIVERY gate: `delivered_at` means "the model's notification
   * obligation for this row is DISCHARGED". Returns true only for the
   * transition that actually claimed it — the caller's exactly-once permit.
   *
   * Every terminal writer discharges it, one of two ways: it delivers and then
   * stamps on success, or it intends NO delivery and stamps at terminalize
   * time (`execStop` — a user-initiated stop needs no card). Ownership is
   * DECLARED by stamping, never inferred: the sweep once guessed from the
   * terminal's `reason`, and `watch_timeout` has two writers (the reaper AND
   * `pollWatcher`), so a reminder `pollWatcher` had already delivered read as
   * owed and was sent a second time.
   *
   * Deliberately NOT the same gate as {@link terminalize}. That boolean used to
   * mean both "I closed this row" and "I own delivery for it", so a throw on the
   * way to the model left the row closed (invisible to `listOpen`, so the reaper
   * could never revisit it) and the model never told. Splitting them lets the
   * terminal stand — which is what advances the alarm horizon — while the
   * delivery stays owed and retryable.
   *
   * An OPEN row cannot be delivered: there is no terminal to tell the model
   * about, and marking one would strand its real terminal undelivered forever.
   */
  markDelivered(id: string, at: number): boolean {
    this.storage.sql.exec(
      `UPDATE background_work SET delivered_at = ?
       WHERE id = ? AND terminal_outcome IS NOT NULL AND delivered_at IS NULL`,
      at,
      id,
    );
    return (
      this.storage.sql.exec<{ changes: number }>("SELECT changes() AS changes").toArray()[0]
        ?.changes === 1
    );
  }

  /**
   * Rows that reached a terminal the model was never told about. The sweep's
   * retry list — read from the STORED terminal, so a retry costs no backend
   * call and cannot wedge the alarm on a dead sandbox.
   *
   * Means exactly "the model was never told, and someone still owes it", and
   * needs NO caller-side filter: every writer discharges the gate (see
   * {@link markDelivered}), so anything left here is genuinely owed. It used to
   * need one — every clean `process_exit`/`process_stopped` row sat here
   * permanently — and that filter keyed on the terminal's reason, which is not
   * a proxy for who owns delivery.
   */
  listUndelivered(): WorkRow[] {
    return this.storage.sql
      .exec<WorkLedgerRow>(
        "SELECT * FROM background_work WHERE terminal_outcome IS NOT NULL AND delivered_at IS NULL",
      )
      .toArray()
      .map(toWorkRow);
  }

  /**
   * How many rows are terminal-but-owed, without materializing any. The alarm
   * horizon needs only the EXISTENCE of an owed row (see `WORK_DELIVERY_RETRY_MS`),
   * and it is computed on every arm — `getWorkHorizon` runs inside the compute
   * service's `armAlarm`, i.e. on every tick — so this must not be
   * `listUndelivered().length`: that is an unindexed scan that also builds a
   * `WorkRow` per row for an answer that is one integer.
   */
  countUndelivered(): number {
    return (
      this.storage.sql
        .exec<{ total: number }>(
          `SELECT COUNT(*) AS total FROM background_work
           WHERE terminal_outcome IS NOT NULL AND delivered_at IS NULL`,
        )
        .toArray()[0]?.total ?? 0
    );
  }

  /**
   * Whether this row's notification obligation is already discharged. A terminal
   * WRITER asks before delivering, so it cannot add a second copy on top of a
   * delivery someone else already made (see `pollWatcher`). Unknown rows read
   * false — nothing was ever told about a row that does not exist.
   */
  isDelivered(id: string): boolean {
    return (
      (this.storage.sql
        .exec<{ total: number }>(
          "SELECT COUNT(*) AS total FROM background_work WHERE id = ? AND delivered_at IS NOT NULL",
          id,
        )
        .toArray()[0]?.total ?? 0) > 0
    );
  }

  deleteRow(id: string): void {
    this.storage.sql.exec("DELETE FROM background_work WHERE id = ?", id);
  }

  /**
   * Drop terminal rows past the retention window (`WORK_ROW_RETENTION_MS`) so
   * the table does not grow unbounded per thread. `delivered_at IS NOT NULL`
   * is read directly as "no delivery is owed" — every terminal writer
   * discharges it, either by delivering then stamping, or by stamping at
   * terminalize time when it intends no delivery (see `markDelivered`). A row
   * still `NULL` is genuinely owed and must survive regardless of age, or
   * pruning it would drop the sweep's only retry path. Deliberately NOT
   * filtered by `terminal_reason` — reason is not a proxy for delivery
   * ownership (see `REAPER_WORK_REASONS`'s doc for why that conflation was a
   * Critical-level bug twice on this branch).
   */
  prune(before: number): void {
    this.storage.sql.exec(
      `DELETE FROM background_work
       WHERE terminal_outcome IS NOT NULL AND delivered_at IS NOT NULL AND terminal_at < ?`,
      before,
    );
  }
}

/**
 * The synchronous shape {@link WorkLedgerStore} answers in: the six sink
 * operations straight off DO SQLite. Declared so the class still `implements`
 * something — the sink contract itself is now async and cannot guard it — and
 * so a test double can be adapted the same way the real store is.
 */
export interface SyncWorkLedgerSink {
  register(row: WorkRow): void;
  stampAlive(id: string, at: number): void;
  terminalize(id: string, terminal: WorkTerminal): boolean;
  markDelivered(id: string, at: number): boolean;
  isDelivered(id: string): boolean;
  deleteRow(id: string): void;
}

/**
 * The in-process {@link WorkLedgerSink} over a {@link SyncWorkLedgerSink}: the
 * same six operations, awaited. The store itself stays synchronous — the agent
 * reads and writes it directly on dozens of paths — so the async contract lives
 * only where the compute layer touches it, next to the RPC back-call that shares
 * the contract (`createSandboxThreadHostDeps`).
 *
 * TEST-ONLY today. No production caller remains: the compute service runs in
 * `AgentSandbox` and is always handed the RPC back-call sink, so there is no
 * in-process store for it to wrap. Kept because unit tests that construct a
 * `ThreadComputeService` directly need a real ledger behind the async contract.
 */
export function localWorkLedgerSink(store: SyncWorkLedgerSink): WorkLedgerSink {
  return {
    register: async (row) => store.register(row),
    stampAlive: async (id, at) => store.stampAlive(id, at),
    terminalize: async (id, terminal) => store.terminalize(id, terminal),
    markDelivered: async (id, at) => store.markDelivered(id, at),
    isDelivered: async (id) => store.isDelivered(id),
    deleteRow: async (id) => store.deleteRow(id),
  };
}
