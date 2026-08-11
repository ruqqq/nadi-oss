import { ComputeError } from "../errors";

/**
 * A narrow client over the sprites.dev REST + WebSocket API.
 *
 * This file is deliberately the ONLY place that knows sprites wire shapes:
 * paths, snake_case field names, and the exec frame protocol. The backend above
 * it speaks the provider-neutral compute vocabulary, so correcting a wrong
 * assumption here never reaches past this seam. The wire shapes marked LIVE
 * below were captured against the real API on 2026-08-04; the rest still comes
 * from the vendor's JS SDK.
 *
 * Exec runs over a WebSocket upgrade exclusively — the plain `POST /exec` route
 * is not used, because it cannot express detachable sessions.
 */

export interface SpritesExecOptions {
  argv: string[];
  dir?: string;
  env?: Record<string, string>;
  /** Server keeps the session alive after the socket drops. */
  detachable?: boolean;
  /** e.g. "600s"; only meaningful with `detachable`. */
  maxRunAfterDisconnect?: string;
  /** Client-side abort for `execCollect`. */
  timeoutMs?: number;
}

export interface SpritesExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * `true` when the server served this run from its REPLAY history and that
   * history hit the 64KiB cap, i.e. `stdout`/`stderr` are a PREFIX of what the
   * command actually wrote. Absent otherwise — never `false` — so a result the
   * caller compares structurally stays the three-field shape it always was.
   *
   * See `execCollect`'s doc for how this is detected.
   */
  truncated?: boolean;
}

export interface SpritesSessionInfo {
  sessionId: string;
  command: string;
}

export type SpritesFsEntryType = "file" | "directory" | "symlink" | "other";

export interface SpritesFsEntry {
  name: string;
  /**
   * Derived from the entry's own `type` string, NOT from `isDir`: the live
   * listing reports a symlink as `type:"symlink"` with `isDir:false`, so reading
   * `isDir` silently demotes every link to a file.
   */
  type: SpritesFsEntryType;
  size: number;
}

export interface SpritesClient {
  createSprite(name: string, input: { environment?: Record<string, string> }): Promise<void>;
  deleteSprite(name: string): Promise<void>;
  listSprites(maxResults?: number): Promise<{ names: string[] }>;
  setNetworkPolicy(
    name: string,
    rules: Array<{ domain: string; action: "allow" | "deny" }>,
  ): Promise<void>;
  setMemoryPolicy(name: string, limitMb: number): Promise<void>;
  /**
   * WS exec, buffered to completion.
   *
   * **PROVIDER LIMITATION — output above 64KiB can be silently truncated.**
   * The server serves an exec session down one of two paths, and names which in
   * its `debug` text frames:
   *
   *  - `normal_path history_len=0` — we attached BEFORE the command finished, so
   *    output is streamed live. Complete, at any size (349528 bytes over 13
   *    frames, live 2026-08-04).
   *  - `fast_path ... history_len=65536` — the command had ALREADY EXITED when
   *    the socket opened, so the server replays its recorded history, and that
   *    history is capped at exactly 65536 bytes. The same 349528-byte command
   *    came back as 65536 bytes with a zero exit code and no error of any kind.
   *
   * Which path a given call takes is a race between the command's runtime and
   * the upgrade round-trip (~25ms), so it is not a stable property of the
   * command: a fast command that produces a lot of output is the exposed case.
   * There is no flag to raise the cap, and the sentinel-file route
   * (`startProcess` + `readProcessOutput`, which reads the output from the
   * sandbox filesystem) is still the only way to get large output back INTACT.
   *
   * **It is, however, DETECTABLE — and detected.** An earlier revision of this
   * comment claimed there was "no marker in the result"; that was wrong, and
   * the evidence was already in our own captures. The server names the path in
   * a `debug` text frame, verbatim (LIVE 2026-08-04):
   *
   * ```
   * {"msg":"fast_path attach_err=session has exited exit_code=0 history_len=65536","pid":333,"t_ms":22,"type":"debug"}
   * {"msg":"normal_path history_len=0","pid":23,"t_ms":17,"type":"debug"}
   * ```
   *
   * A `fast_path` frame whose `history_len` is at the 65536 cap means the
   * replay was cut (a fast_path replay UNDER the cap is complete — the same
   * probe saw `history_len=3` for `echo hi`). `execCollect` parses that frame
   * and sets `truncated: true` on the result, which `SpritesComputeBackend`
   * propagates as `RunCommandResult.stdoutTruncated` so the model is TOLD its
   * output is a prefix rather than acting on a silently halved `git diff`.
   */
  execCollect(name: string, options: SpritesExecOptions): Promise<SpritesExecResult>;
  /**
   * WS exec with detachable=true; connects, waits for the server's
   * `session_info` frame, disconnects, and RETURNS that session id.
   *
   * The id is the only durable handle on a detached run: the session listing
   * reports the INNER process's argv (`sleep 120`), never the wrapper script we
   * sent, so nothing we embed in the command is findable afterwards.
   */
  execDetached(name: string, options: SpritesExecOptions): Promise<string>;
  listSessions(name: string): Promise<SpritesSessionInfo[]>;
  killSession(name: string, sessionId: string, signal: SpritesSignal): Promise<void>;
  /** `null` = the path is absent (a 404 whose body says ENOENT). */
  fsRead(name: string, path: string): Promise<{ bytes: ArrayBuffer; mimeType?: string } | null>;
  fsWrite(name: string, path: string, bytes: ArrayBuffer, mkdirParents: boolean): Promise<void>;
  fsList(name: string, path: string): Promise<SpritesFsEntry[]>;
}

export type SpritesSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

export interface SpritesClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Test seam; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * How long the exec WebSocket UPGRADE may take. Test seam; defaults to
   * `REQUEST_TIMEOUT_MS`. It bounds the handshake only — see `openExecSocket`,
   * where disarming it afterwards is load-bearing.
   */
  execUpgradeTimeoutMs?: number;
}

export const SPRITES_DEFAULT_BASE_URL = "https://api.sprites.dev/v1";

/**
 * Every REST call is bounded, matching the vendor SDK (30s per request, 120s
 * for creation). Nothing else stops a stalled `fsRead`/`listSessions` from
 * pinning the Durable Object turn it runs inside until the platform kills it.
 */
const REQUEST_TIMEOUT_MS = 30_000;
const CREATE_TIMEOUT_MS = 120_000;

/** Anything past one of these may be part of the exec URL. See {@link redactTransportError}. */
const EXEC_URL_MARKERS = /\b(?:https?|wss?):\/\/|\?|(?:^|[^A-Za-z])env=/i;

/**
 * An exec-upgrade transport error, cut back to the part that cannot carry a
 * secret.
 *
 * The exec URL's query holds `env=GH_TOKEN=ghs_…` and every other workbench
 * secret, and this message reaches the MODEL (as `compute-tools.ts`'s `detail`),
 * the persisted transcript, and the logs — so it may not carry the URL. It used
 * to withhold the message entirely for that reason, which is safe and also made
 * every transport failure here identical: a celld deployment where the upgrade
 * was rejected outright read exactly like a network blip, and finding the
 * difference took a purpose-built probe worker.
 *
 * So: TRUNCATE at the first marker that could begin a URL rather than trying to
 * strip one out. What precedes a scheme, a `?`, or an `env=` is the runtime's
 * own prose about what went wrong ("connect api.sprites.dev:443", "TLS
 * handshake with …", "not a WebSocket scheme"), which is the diagnostic part;
 * everything after it is unsafe by construction. Truncating cannot leak on a
 * runtime whose phrasing we have never seen, which stripping could.
 */
function redactTransportError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const raw = error instanceof Error ? error.message : String(error);
  const marker = raw.search(EXEC_URL_MARKERS);
  const kept = (marker === -1 ? raw : raw.slice(0, marker)).trim().slice(0, 200);
  const detail = kept || "transport error";
  return marker === -1
    ? `${detail} [${name || "unknown"}]`
    : `${detail} … [${name || "unknown"}, detail truncated: the exec URL carries secrets]`;
}

/**
 * The `workingDir` every `/fs` route resolves relative paths against. We only
 * ever send absolute paths, so this is belt-and-braces — but the SDK sends it on
 * every call and a server default we never observed is not something to rely on.
 */
const FS_WORKING_DIR = "/";

/**
 * How long `execCollect` waits for the authoritative binary exit frame after the
 * server has ANNOUNCED an exit in text — RENEWED on every data frame that
 * follows, so it measures silence rather than elapsed time since the notice.
 *
 * It was 250ms and armed exactly once, which made it a SILENT TRUNCATION: any
 * trailing output arriving later than a quarter second after the text exit was
 * dropped and the run resolved with the announced code and no error. Live, one
 * command's 349528 bytes arrived over 13 frames, so a backpressure gap past
 * 250ms is entirely plausible.
 *
 * Both halves of the fix matter. The renewal means a stream that keeps talking
 * is never cut mid-flight; the larger budget means the FIRST trailing frame,
 * which has no earlier frame to renew from, is not cut either. It costs nothing
 * on the observed path — live, the binary frame followed the text notice inside
 * the same tick — and is only ever paid by a server that announces an exit in
 * text and then goes silent without closing the socket.
 */
const TEXT_EXIT_GRACE_MS = 2_000;

/**
 * How long `execDetached` waits for the `session_info` frame that names the
 * session it just launched. The live server sent it inside the same tick as the
 * upgrade; without it we have no handle on the process at all, so waiting is
 * mandatory and failing is better than returning an unaddressable run.
 */
const SESSION_INFO_TIMEOUT_MS = 10_000;

type QueryValue = string | number | boolean | undefined;

/**
 * Status -> compute taxonomy. 404 is context-dependent and resolved by the
 * CALLER: `fsRead` turns it into `null`, `deleteSprite` swallows it, and every
 * sprite-level operation lets `runtime_missing` through.
 */
function mapError(status: number, context: string): ComputeError {
  if (status === 404) return new ComputeError("runtime_missing", `${context}: 404`);
  if (status === 401 || status === 403) {
    return new ComputeError("compute_unavailable", `${context}: ${status}`);
  }
  return new ComputeError("provider_transient", `${context}: ${status}`);
}

/**
 * A one-line, bounded rendering of a value for an error message. `undefined`
 * survives as the word (`JSON.stringify` drops it), and anything long is cut
 * short — these messages reach the model as a tool result.
 */
function preview(value: unknown, maxLength = 200): string {
  // `JSON.stringify` is typed as returning a string but answers `undefined` for
  // a function or a symbol, and throws on a circular or BigInt-bearing value —
  // both would otherwise masquerade as an absent field.
  let rendered: string | undefined;
  try {
    rendered = value === undefined ? "undefined" : JSON.stringify(value);
  } catch {
    rendered = undefined;
  }
  const text = rendered ?? String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * The listing's `type` string -> our vocabulary. Anything outside the three the
 * SDK names (`file`, `directory`, `symlink`) becomes `other` rather than a
 * throw: a socket or device node in a directory is a listable entry, not a
 * malformed response.
 */
function toEntryType(raw: string): SpritesFsEntryType {
  if (raw === "directory") return "directory";
  if (raw === "symlink") return "symlink";
  if (raw === "file") return "file";
  return "other";
}

/**
 * Does this 404 body say "that FILE does not exist" (as opposed to "that sprite
 * does not exist")?
 *
 * LIVE-VERIFIED (2026-08-04) — the two 404 bodies, quoted exactly as the API
 * returned them:
 *
 *  - absent FILE on a live sprite:
 *    `{"error":"open /tmp/x: no such file or directory","path":"/tmp/x"}`
 *  - absent SPRITE:
 *    `{"error":"sprite not found"}`
 *
 * **There is NO `code` field on either.** The SDK-derived `ENOENT` branch below
 * therefore never fires against the real server, and the error-TEXT fallback is
 * what actually does all the work. Do not "simplify" the fallback away as
 * redundant with the `code` check — it is the only arm that runs. The `code`
 * arm is kept because the vendor SDK's `parseErrorCode` maps a `code` field
 * through a fixed table whose absent-file member is `ENOENT`
 * (`src/filesystem.ts`, `src/types.ts:FilesystemErrorCode`), so a server that
 * starts sending one must keep answering correctly.
 *
 * A `path` field is additional file-scoped evidence: the sprite-level 404
 * carries none, and a body that names the path it failed to open is talking
 * about a path inside a sprite it found.
 *
 * Consumes the response body; only ever called on a path that will not read it
 * again.
 */
async function isFileNotFound(response: Response): Promise<boolean> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return false;
  }
  const row = payload as { code?: unknown; error?: unknown; path?: unknown } | null;
  if (typeof row?.code === "string" && row.code.length > 0) {
    return row.code.toUpperCase() === "ENOENT";
  }
  if (typeof row?.error !== "string") return false;
  if (/no such file|does not exist/i.test(row.error)) return true;
  // Path-scoped body with a message we do not recognise: still a file-level
  // answer, because the sprite-level 404 never names a path.
  return typeof row.path === "string" && row.path.length > 0;
}

/**
 * One exec frame: byte 0 is the stream id, the rest is payload. Exit frames
 * (stream 3) carry exactly one byte, the exit code.
 *
 * Exported for direct unit testing — the framing is the one piece of this file
 * with no HTTP status to key on, so an unrecognized stream id must THROW rather
 * than be dropped: a silently ignored frame would let `execCollect` return a
 * short stdout, or hang waiting for an exit that already arrived mislabeled.
 *
 * The exit payload's LENGTH is validated for the same reason: a truncated
 * stream-3 frame read as "no byte, so 0" would report a killed or crashed run
 * as a success, which is precisely the outcome `execCollect`'s no-exit
 * rejection exists to prevent. An empty payload is fine on stdout/stderr (a
 * zero-length write), and only there.
 */
export function parseExecFrame(data: ArrayBuffer): { stream: 1 | 2 | 3; payload: Uint8Array } {
  const view = new Uint8Array(data);
  if (view.length === 0) {
    throw new ComputeError("provider_transient", "sprites_exec_unexpected_frame");
  }
  const stream = view[0];
  if (stream !== 1 && stream !== 2 && stream !== 3) {
    throw new ComputeError("provider_transient", "sprites_exec_unexpected_frame");
  }
  const payload = view.subarray(1);
  if (stream === 3 && payload.length !== 1) {
    throw new ComputeError("provider_transient", "sprites_exec_bad_exit");
  }
  return { stream, payload };
}

/**
 * `{"type":"session_info","session_id":"15",...}` -> `"15"`, anything else ->
 * `undefined`.
 *
 * This frame is the ONLY place the server names the session it just created.
 * The session listing reports the inner process's argv, so nothing we put in
 * the command line comes back — capturing this id at launch is the only way to
 * ever address a detached run again.
 */
export function parseSessionId(data: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return undefined;
  }
  const row = payload as { type?: unknown; session_id?: unknown } | null;
  if (row?.type !== "session_info") return undefined;
  if (typeof row.session_id !== "string" || row.session_id.length === 0) return undefined;
  return row.session_id;
}

/**
 * `{"type":"exit","exit_code":N}` -> N, anything else -> `undefined`.
 *
 * The server announces completion TWICE: this text notification and the binary
 * stream-3 frame (the live probe saw both, text first). The BINARY frame is the
 * one we settle on: the text notification can precede trailing output, so
 * resolving on it truncates stdout. The code it carries is recorded and used
 * only if the socket closes (or a short grace elapses) with no binary frame.
 *
 * An `exit` message whose `exit_code` is absent or not an integer returns
 * `undefined` rather than `0`, for the same reason `parseExecFrame` rejects a
 * truncated exit frame: the binary frame or the close handler then decides, and
 * a killed run never reads as a success.
 */
export function parseTextExitCode(data: string): number | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return undefined;
  }
  const row = payload as { type?: unknown; exit_code?: unknown } | null;
  if (row?.type !== "exit") return undefined;
  if (typeof row.exit_code !== "number" || !Number.isInteger(row.exit_code)) return undefined;
  return row.exit_code;
}

/**
 * The `pid` a `debug` frame carries, as a session-id string.
 *
 * LIVE (2026-08-04): the two are the SAME number. Three probes in one run:
 * `{"msg":"session_created cmd=bash","pid":333,…}` was followed by
 * `{"type":"session_info","session_id":"333",…}`, and likewise 23/23 and
 * 346/346. This is used ONLY as a cleanup handle in `execDetached`'s reject
 * path — never as the id we return — because the `debug` frame arrives first
 * and is therefore the only handle available when `session_info` never does.
 */
export function parseDebugSessionId(data: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return undefined;
  }
  const row = payload as { type?: unknown; pid?: unknown } | null;
  if (row?.type !== "debug") return undefined;
  if (typeof row.pid !== "number" || !Number.isInteger(row.pid) || row.pid <= 0) return undefined;
  return String(row.pid);
}

/**
 * The exact size the server's replay history is capped at. A `fast_path` frame
 * reporting this many bytes means the recorded output was CUT; anything less is
 * the whole thing (live: `history_len=3` for `echo hi`).
 */
export const FAST_PATH_HISTORY_CAP_BYTES = 65_536;

/**
 * Is this text frame the server's `debug` notice that it replayed a CAPPED
 * history? See `execCollect`'s doc for the verbatim live frames.
 *
 * `msg` is a flat `key=value` log line, not a structured object, so the two
 * facts are read out of it by pattern: the leading path name and `history_len`.
 * A `normal_path` frame (streamed live) is never truncation, whatever its
 * `history_len` says.
 */
export function isTruncatedReplayFrame(data: string): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return false;
  }
  const row = payload as { type?: unknown; msg?: unknown } | null;
  if (row?.type !== "debug" || typeof row.msg !== "string") return false;
  if (!/^fast_path\b/.test(row.msg)) return false;
  const matched = /\bhistory_len=(\d+)\b/.exec(row.msg);
  if (!matched?.[1]) return false;
  return Number.parseInt(matched[1], 10) >= FAST_PATH_HISTORY_CAP_BYTES;
}

/**
 * The `env` query param REPLACES the sprite's default environment rather than
 * extending it, so any exec that supplies env at all loses `PATH` unless we put
 * one back — and a `bash` that cannot resolve `mkdir` fails in exactly the shape
 * that is hardest to read from production: the socket opens, nothing useful
 * arrives, it closes. Only used when the caller sends env and omits `PATH`.
 *
 * LIVE (2026-08-04): this is the sprite's OWN default `PATH`, read back verbatim
 * from `echo $PATH` in an exec that sent no env. The two leading entries matter —
 * `/home/sprite/.local/bin` is where a sandbox's user-installed tools land, and
 * `/.sprite/bin` is the provider's own — so a hand-written "sane default" that
 * omitted them would silently un-install every tool the agent had installed the
 * moment we started sending env on every exec (which `SpritesComputeBackend`
 * now does, to carry the runtime env; see `sprites.ts`).
 *
 * Note that `env` does not replace EVERYTHING: `HOME` survived a replacement
 * that never mentioned it (same probe), so the server seeds a small base itself.
 * `PATH` is not part of that base, which is why this constant exists.
 */
const DEFAULT_EXEC_PATH =
  "/home/sprite/.local/bin:/.sprite/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function toArrayBuffer(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
  return data;
}

/** The subset of the socket this client uses, so tests can script one. */
interface ExecSocket {
  /**
   * MUST be set to `"arraybuffer"` before `accept()`.
   *
   * REGRESSION (live smoke, 2026-08-04): workerd delivers binary WebSocket
   * messages as a **`Blob`** by default, not an `ArrayBuffer`. Every stdout,
   * stderr and exit frame therefore failed the handler's
   * `instanceof ArrayBuffer` guard and was DROPPED — silently, so every exec
   * ended as `sprites_exec_no_exit` with no clue why. Instrumenting the live
   * Worker showed frames arriving with `ctor=Blob`, and `ctor=ArrayBuffer`
   * (`[1,65,65,...]`, `[3,0]`) once this was set. 187 unit tests stayed green
   * throughout, because the fake socket fed ArrayBuffers the real one never
   * sends — which is why the fake now defaults to `Blob` too.
   */
  binaryType?: string;
  accept(): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: never) => void): void;
}

class SpritesHttpClient implements SpritesClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly execUpgradeTimeoutMs: number;

  constructor(options: SpritesClientOptions) {
    this.apiKey = options.apiKey;
    this.execUpgradeTimeoutMs = options.execUpgradeTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.baseUrl = (options.baseUrl ?? SPRITES_DEFAULT_BASE_URL).replace(/\/+$/, "");
    // A bare stored reference to the native `fetch` throws "illegal invocation"
    // on Workers when later called as a method, so wrap it in an arrow.
    this.doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  private url(path: string, query?: Record<string, QueryValue>): URL {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  private async request(
    method: string,
    path: string,
    query?: Record<string, QueryValue>,
    body?: unknown,
    rawBody?: ArrayBuffer,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    let payload: BodyInit | undefined;
    if (rawBody !== undefined) {
      headers["Content-Type"] = "application/octet-stream";
      payload = rawBody;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    try {
      return await this.doFetch(this.url(path, query).toString(), {
        method,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        ...(payload === undefined ? {} : { body: payload }),
      });
    } catch (error) {
      // Transport failure — never a provider verdict, always worth a retry. An
      // abort is the timeout above firing, and is named so the log says which.
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new ComputeError("provider_transient", `sprites_request_timeout: ${path}`);
      }
      throw new ComputeError(
        "provider_transient",
        `sprites_request_failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async json(response: Response, context: string): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new ComputeError("provider_transient", context);
    }
  }

  async createSprite(name: string, input: { environment?: Record<string, string> }): Promise<void> {
    const response = await this.request(
      "POST",
      "/sprites",
      undefined,
      { name, environment: input.environment ?? {} },
      undefined,
      // Creation provisions a machine; the SDK gives it four times the budget.
      CREATE_TIMEOUT_MS,
    );
    if (!response.ok) throw mapError(response.status, "sprites_create_failed");
  }

  async deleteSprite(name: string): Promise<void> {
    const response = await this.request("DELETE", `/sprites/${encodeURIComponent(name)}`);
    // Delete is called from cleanup paths that must be idempotent: already gone
    // is the goal state, not a failure.
    if (response.status === 404) return;
    if (!response.ok) throw mapError(response.status, "sprites_delete_failed");
  }

  async listSprites(maxResults?: number): Promise<{ names: string[] }> {
    const response = await this.request("GET", "/sprites", { max_results: maxResults });
    if (!response.ok) throw mapError(response.status, "sprites_list_sprites_failed");
    const payload = await this.json(response, "sprites_list_sprites_unexpected_shape");
    const sprites = (payload as { sprites?: unknown } | null)?.sprites;
    // A wrapper object or a renamed key must THROW, not degrade to an empty
    // list: callers use this to decide whether a sprite still exists, and a
    // false "no sprites" reads as a wipe.
    if (!Array.isArray(sprites)) {
      throw new ComputeError("provider_transient", "sprites_list_sprites_unexpected_shape");
    }
    return {
      names: sprites.map((entry) => {
        const name = (entry as { name?: unknown } | null)?.name;
        if (typeof name !== "string" || name.length === 0) {
          throw new ComputeError("provider_transient", "sprites_list_sprites_unexpected_shape");
        }
        return name;
      }),
    };
  }

  async setNetworkPolicy(
    name: string,
    rules: Array<{ domain: string; action: "allow" | "deny" }>,
  ): Promise<void> {
    const response = await this.request(
      "POST",
      `/sprites/${encodeURIComponent(name)}/policy/network`,
      undefined,
      { rules },
    );
    if (!response.ok) throw mapError(response.status, "sprites_network_policy_failed");
  }

  async setMemoryPolicy(name: string, limitMb: number): Promise<void> {
    const response = await this.request(
      "POST",
      `/sprites/${encodeURIComponent(name)}/policy/resources`,
      undefined,
      // `autoscale: true` makes `limit_mb` advisory — the sprite grows past it
      // and the bill grows with it. The profile limit is meant to be a CAP.
      { memory: { limit_mb: limitMb, autoscale: false } },
    );
    if (!response.ok) throw mapError(response.status, "sprites_memory_policy_failed");
  }

  async listSessions(name: string): Promise<SpritesSessionInfo[]> {
    const response = await this.request("GET", `/sprites/${encodeURIComponent(name)}/exec`);
    if (!response.ok) throw mapError(response.status, "sprites_sessions_failed");
    const payload = await this.json(response, "sprites_sessions_unexpected_shape");
    // LIVE (2026-08-04): `{"count":1,"sessions":[{"id":"15","command":"sleep
    // 120",...}]}`. A bare array is NOT what this route returns; a missing or
    // non-array `sessions` still throws rather than degrading to "no sessions",
    // because callers read an empty listing as "the process is gone".
    const sessions = (payload as { sessions?: unknown } | null)?.sessions;
    if (!Array.isArray(sessions)) {
      throw new ComputeError("provider_transient", "sprites_sessions_unexpected_shape");
    }
    return sessions.map((entry) => {
      // `id` is the live key; `session_id` is kept as a tolerated alias.
      //
      // NOTE: the row also carries `is_active`, which is NOT liveness — live, it
      // read `false` while `sleep 120` was genuinely running. It means "a client
      // is attached". Presence in this list is the only liveness signal.
      const row = entry as { session_id?: unknown; id?: unknown; command?: unknown } | null;
      const sessionId = typeof row?.id === "string" ? row.id : row?.session_id;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new ComputeError("provider_transient", "sprites_sessions_unexpected_shape");
      }
      if (typeof row?.command !== "string") {
        throw new ComputeError("provider_transient", "sprites_sessions_unexpected_shape");
      }
      return { sessionId, command: row.command };
    });
  }

  async killSession(name: string, sessionId: string, signal: SpritesSignal): Promise<void> {
    const response = await this.request(
      "POST",
      `/sprites/${encodeURIComponent(name)}/exec/${encodeURIComponent(sessionId)}/kill`,
      { signal },
    );
    if (!response.ok) throw mapError(response.status, "sprites_kill_failed");
    // The response streams NDJSON progress; drain it so the connection is not
    // left half-read.
    await response.text();
  }

  async fsRead(
    name: string,
    path: string,
  ): Promise<{ bytes: ArrayBuffer; mimeType?: string } | null> {
    const response = await this.request("GET", `/sprites/${encodeURIComponent(name)}/fs/read`, {
      path,
      workingDir: FS_WORKING_DIR,
    });
    // The one endpoint where 404 CAN be an answer rather than a fault — but only
    // when the body says the FILE is missing. A deleted sprite 404s here too,
    // and reading that as "empty file" reported a dead sprite's process as
    // having produced no output at all.
    if (response.status === 404) {
      if (await isFileNotFound(response)) return null;
      throw mapError(404, "sprites_fs_read_failed");
    }
    if (!response.ok) throw mapError(response.status, "sprites_fs_read_failed");
    const bytes = await response.arrayBuffer();
    const contentType = response.headers.get("Content-Type")?.split(";")[0]?.trim();
    return contentType && contentType !== "application/octet-stream"
      ? { bytes, mimeType: contentType }
      : { bytes };
  }

  /**
   * `mkdirParents` is the SDK's spelling of the parent-creation flag.
   *
   * LIVE PROBE (2026-08-04): parents were created under BOTH `mkdir` and
   * `mkdirParents`, and under neither — the server appears to create them
   * unconditionally. So `false` here is a REQUEST, not an enforced constraint,
   * and no caller may treat a write as having failed because a parent was
   * missing. We do not fake the enforcement locally.
   */
  async fsWrite(
    name: string,
    path: string,
    bytes: ArrayBuffer,
    mkdirParents: boolean,
  ): Promise<void> {
    const response = await this.request(
      "PUT",
      `/sprites/${encodeURIComponent(name)}/fs/write`,
      { path, workingDir: FS_WORKING_DIR, mkdirParents },
      undefined,
      bytes,
    );
    if (!response.ok) throw mapError(response.status, "sprites_fs_write_failed");
  }

  async fsList(name: string, path: string): Promise<SpritesFsEntry[]> {
    const response = await this.request("GET", `/sprites/${encodeURIComponent(name)}/fs/list`, {
      path,
      workingDir: FS_WORKING_DIR,
    });
    if (!response.ok) throw mapError(response.status, "sprites_fs_list_failed");
    const payload = await this.json(
      response,
      "sprites_list_unexpected_shape: response body was not JSON",
    );
    // LIVE (2026-08-04): `{"path":"/workspace","entries":[...],"count":2}` — a
    // WRAPPER, not a bare array.
    //
    // Mirrors `daytona.ts:652-661`: a listing that does not parse must throw,
    // never map to `[]`. An empty list is a positive claim ("this directory is
    // empty") that higher layers act on destructively; a missing or non-array
    // `entries` is not evidence for it.
    //
    // `null` is the ONE exception, and it is not a guess. LIVE (2026-08-05), a
    // directory created empty answered `{"path":...,"entries":null,"count":0}` —
    // Go marshals a nil slice as `null`. So `null` IS this server's empty
    // listing, and reading it as a fault made every empty directory throw:
    // `exec_publish_artifact`'s recursive walk hits one and the publish dies.
    // The `count` cross-check keeps the claim honest — a `null` list the server
    // itself says has members is a contradiction, not an empty directory.
    //
    // Every arm below names the value that failed its check. The four arms used
    // to throw the same bare string, so a production report could not tell this
    // `null` from an entry missing its `type` — and the operator, staring at
    // `provider_transient — sprites_list_unexpected_shape`, had nothing to act
    // on. That is how this bug survived: the message never named the cause.
    const payloadCount = (payload as { count?: unknown } | null)?.count;
    const entries = (payload as { entries?: unknown } | null)?.entries;
    if (entries === null && !(typeof payloadCount === "number" && payloadCount > 0)) return [];
    if (!Array.isArray(entries)) {
      throw new ComputeError(
        "provider_transient",
        `sprites_list_unexpected_shape: ${path} entries=${preview(entries)} body=${preview(payload)}`,
      );
    }
    return entries.map((entry, index) => {
      const row = entry as { name?: unknown; type?: unknown; size?: unknown } | null;
      const entryName = row?.name;
      if (typeof entryName !== "string" || entryName.length === 0 || entryName.includes("/")) {
        throw new ComputeError(
          "provider_transient",
          `sprites_list_unexpected_shape: ${path} entry[${index}].name=${preview(entryName)} entry=${preview(entry)}`,
        );
      }
      if (typeof row?.type !== "string" || row.type.length === 0) {
        throw new ComputeError(
          "provider_transient",
          `sprites_list_unexpected_shape: ${path} entry[${index}].type=${preview(row?.type)} entry=${preview(entry)}`,
        );
      }
      return {
        name: entryName,
        type: toEntryType(row.type),
        size: typeof row?.size === "number" ? row.size : 0,
      };
    });
  }

  /**
   * `wss:`/`ws:`, never `https:`/`http:` — this is the WebSocket upgrade URL,
   * and the scheme is load-bearing on self-hosted celld.
   *
   * workerd accepts either form for a client upgrade, so `https:` + an
   * `Upgrade: websocket` header (the shape the Cloudflare docs show) works on
   * Cloudflare and hid this for as long as that was the only target. celld
   * dispatches on the scheme and rejects the http one outright — "WebSocket
   * upgrade failed: not a WebSocket scheme: https", thrown before any request
   * leaves the isolate — so EVERY exec failed there while plain REST over the
   * same `baseUrl` was fine. `wss:` is accepted by both.
   *
   * REST keeps `baseUrl` verbatim (see `url()`): only the upgrade is affected.
   */
  private execUrl(name: string, options: SpritesExecOptions): string {
    const url = new URL(`${this.baseUrl}/sprites/${encodeURIComponent(name)}/exec`);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    for (const arg of options.argv) url.searchParams.append("cmd", arg);
    // The vendor SDK always pairs the repeated `cmd` params with `path`, the
    // executable to resolve — argv[0], verbatim, not an absolute path.
    const executable = options.argv[0];
    if (executable !== undefined) url.searchParams.set("path", executable);
    if (options.dir) url.searchParams.set("dir", options.dir);
    const env = options.env;
    if (env !== undefined && Object.keys(env).length > 0) {
      const withPath = "PATH" in env ? env : { PATH: DEFAULT_EXEC_PATH, ...env };
      for (const [key, value] of Object.entries(withPath)) {
        url.searchParams.append("env", `${key}=${value}`);
      }
    }
    if (options.detachable) url.searchParams.set("detachable", "true");
    if (options.maxRunAfterDisconnect) {
      url.searchParams.set("max_run_after_disconnect", options.maxRunAfterDisconnect);
    }
    return url.toString();
  }

  /**
   * Opens the exec socket, or throws the mapped upgrade failure.
   *
   * It deliberately does NOT call `accept()`. On Workers, `accept()` starts
   * delivering frames immediately and there is no buffering for listeners
   * attached afterwards — a frame that arrives before its listener exists is
   * DROPPED. The live server answers in ~25ms, well inside a single `await`, so
   * accepting here and returning cost us every frame of every exec (the socket
   * then closed with nothing parsed: `sprites_exec_no_exit`).
   *
   * Each caller therefore attaches its listeners first and calls `accept()`
   * itself, with no `await` in between.
   *
   * The upgrade's timeout is an `AbortController` that is DISARMED the moment
   * the handshake answers, and that is load-bearing rather than tidy.
   *
   * REGRESSION (live, 2026-08-05): it used to be `AbortSignal.timeout(...)`,
   * which cannot be disarmed. workerd keeps a fetch's signal wired to the
   * connection that fetch produced, and for a WebSocket upgrade that connection
   * IS the socket — so the signal firing 30s later killed an exec that was
   * running perfectly well. Reproduced in workerd against a silent WebSocket
   * server: with the signal the socket died at exactly the timeout with
   * `code=1006 reason="WebSocket disconnected without sending Close frame."`,
   * and without it the socket stayed open. That close is `sprites_exec_no_exit`,
   * and it hit every exec that ran longer than 30 seconds — an install, a test
   * run, a clone — which is why it read as a flaky provider rather than a clock.
   *
   * The bound itself still matters: `execCollect`'s own timer only arms AFTER
   * this await resolves, so an upgrade that never answers would otherwise pin
   * the Durable Object turn indefinitely.
   */
  private async openExecSocket(name: string, options: SpritesExecOptions): Promise<ExecSocket> {
    let response: Response;
    const upgrade = new AbortController();
    const upgradeTimer = setTimeout(() => upgrade.abort(), this.execUpgradeTimeoutMs);
    try {
      response = await this.doFetch(this.execUrl(name, options), {
        headers: { Upgrade: "websocket", Authorization: `Bearer ${this.apiKey}` },
        signal: upgrade.signal,
      });
    } catch (error) {
      // SECRET SAFETY: the transport error is NOT interpolated. workerd's fetch
      // rejections routinely embed the request URL, and the exec URL carries
      // `env=GH_TOKEN=ghs_…` plus every workbench secret (see `execUrl`). This
      // message is returned to the MODEL as `compute-tools.ts`'s `detail` and
      // lands in the persisted transcript and the logs, so nothing derived from
      // the transport may appear in it. Only the abort/non-abort distinction is
      // carried through, which is the only part that changes what to do next.
      // (The REST path in `request()` may interpolate freely — its query
      // strings carry no secrets.)
      const name_ = error instanceof Error ? error.name : "";
      if (name_ === "TimeoutError" || name_ === "AbortError") {
        throw new ComputeError("provider_transient", "sprites_exec_upgrade_timeout");
      }
      throw new ComputeError(
        "provider_transient",
        `sprites_exec_upgrade_failed: ${redactTransportError(error)}`,
      );
    } finally {
      // Disarm on EVERY exit, success or throw: a timer left running past a
      // successful handshake aborts the live socket (see the doc comment), and
      // one left running past a failure aborts nothing but keeps the isolate's
      // timer queue non-empty for no reason.
      clearTimeout(upgradeTimer);
    }
    const ws = (response as unknown as { webSocket?: ExecSocket | null }).webSocket;
    if (!ws) throw mapError(response.status, "sprites_exec_upgrade_failed");
    return ws;
  }

  async execCollect(name: string, options: SpritesExecOptions): Promise<SpritesExecResult> {
    const ws = await this.openExecSocket(name, options);
    const openedAt = Date.now();
    return await new Promise<SpritesExecResult>((resolve, reject) => {
      const stdoutDecoder = new TextDecoder();
      const stderrDecoder = new TextDecoder();
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      /** The text `exit` code, held until the binary frame or the socket close. */
      let textExitCode: number | undefined;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      let truncated = false;

      /**
       * (Re)start the post-text-exit grace window.
       *
       * Called both when the text `exit` arrives AND on every data frame that
       * follows it. The grace is "how long since the last thing the server
       * said", not "how long since the exit notice": live, 349528 bytes arrived
       * over 13 frames, so trailing output landing more than
       * `TEXT_EXIT_GRACE_MS` after the announcement is entirely plausible under
       * backpressure — and a timer that only ever armed once resolved the run
       * with the announced code and the output SILENTLY CUT.
       */
      const armGrace = (announced: number) => {
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        graceTimer = setTimeout(() => {
          stdout += stdoutDecoder.decode();
          stderr += stderrDecoder.decode();
          settle(() =>
            resolve({ exitCode: announced, stdout, stderr, ...(truncated ? { truncated } : {}) }),
          );
        }, TEXT_EXIT_GRACE_MS);
      };

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        try {
          ws.close();
        } catch {
          // A socket already closed by the peer is not an error here.
        }
        fn();
      };

      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          settle(() => reject(new ComputeError("provider_transient", "sprites_exec_timeout")));
        }, options.timeoutMs);
      }

      // ASSUMPTION [unverified against a live server]: exactly ONE frame per
      // WebSocket message. WebSocket preserves message boundaries, so a
      // frame-per-message contract is the natural design and is what the vendor
      // SDK appears to rely on — but nothing in the payload states it. If the
      // server ever coalesced two frames into one message, the second frame's
      // stream-id byte would be appended to the first stream as CONTENT: silent
      // output corruption, and an exit code swallowed into stdout.
      //
      // The only self-evidencing part is the exit frame, which `parseExecFrame`
      // rejects unless its payload is exactly one byte — so a coalesced message
      // ENDING in an exit frame throws `sprites_exec_bad_exit` rather than
      // returning a wrong code. A coalesced stdout+stderr pair is undetectable
      // here by construction.
      //
      // If the live smoke shows coalescing, the fix is a length prefix (if the
      // server sends one) or a reassembly buffer in this closure that consumes
      // frames until the message is drained — a change confined to this handler
      // and `parseExecFrame`, not to anything above this file.
      //
      // LIVE PROBE (2026-08-04), framing confirmed, stream SEPARATION not:
      // `echo hello-stdout; echo hello-stderr >&2; exit 7` came back as ONE
      // stream-1 frame carrying "hello-stderr\nhello-stdout\n" — stderr merged
      // into stdout, and not even in the emitted order. No stream-2 frame was
      // sent at all. The session was a non-TTY replay (`fast_path` on an
      // already-exited session), so this may be replay-specific rather than
      // universal; either way, callers must treat `stderr` as possibly EMPTY
      // with its content sitting in `stdout`, and must not read an empty
      // `stderr` as "the command wrote nothing to stderr".
      ws.addEventListener("message", (event: never) => {
        const data = (event as { data: unknown }).data;
        // Text frames are JSON control notifications (`debug`, `session_info`,
        // `port_opened`) — and `exit`, which is a completion signal in its own
        // right; see `parseTextExitCode`.
        if (typeof data === "string") {
          // The `debug` frame that names the serving path is the ONLY signal
          // that a fast-path replay was cut at the 64KiB cap; it arrives before
          // any output. See `execCollect`'s doc.
          if (isTruncatedReplayFrame(data)) truncated = true;
          const announced = parseTextExitCode(data);
          if (announced === undefined) return;
          // RECORD, do not settle: the text notification can arrive before the
          // last output frames, and settling here truncates them. The binary
          // stream-3 frame is authoritative; this code is the fallback for a
          // close (or a stalled server) that never sends one.
          textExitCode = announced;
          armGrace(announced);
          return;
        }
        // Anything non-string that is not already bytes means `binaryType` did
        // not take: workerd's default delivers a `Blob` here, which this handler
        // cannot read synchronously. NEVER return silently — dropping a frame
        // loses stdout or an exit code with no error to read, which is exactly
        // how the Blob bug survived a live deploy and 187 green unit tests.
        if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
          const kind =
            (data as { constructor?: { name?: string } } | null)?.constructor?.name ?? typeof data;
          settle(() =>
            reject(
              new ComputeError(
                "provider_transient",
                `sprites_exec_unreadable_frame: expected ArrayBuffer, got ${kind} ` +
                  `(binaryType was not honoured before accept())`,
              ),
            ),
          );
          return;
        }
        let frame: { stream: 1 | 2 | 3; payload: Uint8Array };
        try {
          frame = parseExecFrame(toArrayBuffer(data as ArrayBuffer | ArrayBufferView));
        } catch (error) {
          settle(() => reject(error));
          return;
        }
        if (frame.stream === 1) {
          stdout += stdoutDecoder.decode(frame.payload, { stream: true });
          // Output after the text exit means the run is still talking; push the
          // grace window out rather than let a fixed 250ms deadline cut it.
          if (textExitCode !== undefined) armGrace(textExitCode);
          return;
        }
        if (frame.stream === 2) {
          stderr += stderrDecoder.decode(frame.payload, { stream: true });
          if (textExitCode !== undefined) armGrace(textExitCode);
          return;
        }
        const exitCode = frame.payload[0];
        if (exitCode === undefined) {
          // Unreachable while `parseExecFrame` enforces a one-byte exit payload;
          // kept so no future edit to the parser can turn a missing exit code
          // into a silent `0`.
          settle(() => reject(new ComputeError("provider_transient", "sprites_exec_bad_exit")));
          return;
        }
        // Flush any trailing partial multi-byte sequence.
        stdout += stdoutDecoder.decode();
        stderr += stderrDecoder.decode();
        settle(() => resolve({ exitCode, stdout, stderr, ...(truncated ? { truncated } : {}) }));
      });

      ws.addEventListener("close", (event: never) => {
        // A close after an announced text exit is a complete run: every output
        // frame preceded the close, so the recorded code is now safe to use.
        if (textExitCode !== undefined) {
          const announced = textExitCode;
          stdout += stdoutDecoder.decode();
          stderr += stderrDecoder.decode();
          settle(() =>
            resolve({ exitCode: announced, stdout, stderr, ...(truncated ? { truncated } : {}) }),
          );
          return;
        }
        // No exit frame means the command's outcome is unknown — reporting a
        // fabricated exit code here would let a killed run read as success.
        //
        // The close code and reason ride in the message because this error was
        // the only production symptom of the dropped-frame bug, and without
        // them it named no cause at all.
        //
        // So does the elapsed time, and it is the field that names the SIDE.
        // Measured in workerd: a socket we abort ourselves and a socket the
        // server destroys without a close frame BOTH report
        // `code=1006 reason="WebSocket disconnected without sending Close
        // frame."` — the text is workerd's own, generated for any close it did
        // not receive, so it cannot distinguish them. WHEN the close lands can:
        // a cluster at one constant is a timer of ours (that is exactly how the
        // 30s upgrade-signal bug looked — see `openExecSocket`), while a spread
        // that tracks how long each command ran is the far end hanging up.
        const detail = event as { code?: unknown; reason?: unknown } | undefined;
        const code = typeof detail?.code === "number" ? String(detail.code) : "unknown";
        const reason =
          typeof detail?.reason === "string" && detail.reason.length > 0
            ? ` reason=${detail.reason}`
            : "";
        const elapsed = ` after=${Date.now() - openedAt}ms`;
        settle(() =>
          reject(
            new ComputeError(
              "provider_transient",
              `sprites_exec_no_exit: code=${code}${reason}${elapsed}`,
            ),
          ),
        );
      });

      ws.addEventListener("error", () => {
        settle(() => reject(new ComputeError("provider_transient", "sprites_exec_socket_error")));
      });

      // LAST, and synchronously after the three attachments above: `accept()`
      // starts frame delivery, and anything delivered before a listener exists
      // is lost. Never put an `await` between the listeners and this call.
      try {
        ws.binaryType = "arraybuffer";
        ws.accept();
      } catch (error) {
        settle(() =>
          reject(
            new ComputeError(
              "provider_transient",
              `sprites_exec_upgrade_failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        );
      }
    });
  }

  /**
   * Launch a detached session and return the server's id for it.
   *
   * Waiting for `session_info` is not an optimisation — it is the only moment
   * the session id is ever disclosed. The alternative we shipped before (embed a
   * marker in the wrapper script and substring-match the session listing) can
   * never work: the listing reports the INNER argv (`sleep 120`), so the marker
   * is not in it, every background process read as `failed`, and every
   * `stopProcess` silently killed nothing.
   *
   * Every REJECT path best-effort reaps what it may have launched. `detachable`
   * means the server keeps the session running after we disconnect, so a launch
   * we could not get an id for is a process that runs to its
   * `max_run_after_disconnect` deadline holding memory against the sprite's cap
   * with nothing able to address it. The handle used is the `debug` frame's
   * `pid` (see `parseDebugSessionId`), which arrives before `session_info` and
   * is the same number; the kill is confirmed against `listSessions` first and
   * every error is swallowed, because this is cleanup for a call that is
   * already failing.
   */
  async execDetached(name: string, options: SpritesExecOptions): Promise<string> {
    const ws = await this.openExecSocket(name, { ...options, detachable: true });
    /** Cleanup handle only; never returned as the session id. */
    let candidateSessionId: string | undefined;
    const reap = async () => {
      const sessionId = candidateSessionId;
      if (sessionId === undefined) return;
      try {
        const sessions = await this.listSessions(name);
        if (!sessions.some((session) => session.sessionId === sessionId)) return;
        await this.killSession(name, sessionId, "SIGKILL");
      } catch {
        // Best effort: the launch already failed, and a failed reap must not
        // replace that error with a less informative one.
      }
    };

    try {
      return await this.awaitSessionInfo(ws, (id) => {
        candidateSessionId = id;
      });
    } catch (error) {
      await reap();
      throw error;
    }
  }

  /** The `session_info` wait, split out so `execDetached` can reap on any throw. */
  private async awaitSessionInfo(
    ws: ExecSocket,
    noteCandidate: (sessionId: string) => void,
  ): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          // Closing the socket does NOT stop the run: `detachable=true` keeps
          // the session alive past the disconnect (verified live).
          ws.close();
        } catch {
          // Already closed by the peer.
        }
        fn();
      };

      const timer = setTimeout(() => {
        settle(() =>
          reject(new ComputeError("provider_transient", "sprites_exec_no_session_info")),
        );
      }, SESSION_INFO_TIMEOUT_MS);

      // Listeners FIRST, `accept()` last — see `openExecSocket`. A dropped
      // `session_info` here is an unaddressable process, not a lost log line.
      ws.addEventListener("message", (event: never) => {
        const data = (event as { data: unknown }).data;
        if (typeof data !== "string") return;
        // Recorded before the `session_info` check: on a launch that never gets
        // one, this is the only handle the reap path will have.
        const debugId = parseDebugSessionId(data);
        if (debugId !== undefined) noteCandidate(debugId);
        const sessionId = parseSessionId(data);
        if (sessionId === undefined) return;
        noteCandidate(sessionId);
        settle(() => resolve(sessionId));
      });

      ws.addEventListener("close", () => {
        settle(() =>
          reject(new ComputeError("provider_transient", "sprites_exec_no_session_info: closed")),
        );
      });

      ws.addEventListener("error", () => {
        settle(() => reject(new ComputeError("provider_transient", "sprites_exec_socket_error")));
      });

      try {
        ws.binaryType = "arraybuffer";
        ws.accept();
      } catch (error) {
        settle(() =>
          reject(
            new ComputeError(
              "provider_transient",
              `sprites_exec_upgrade_failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        );
      }
    });
  }
}

export function createSpritesClient(options: SpritesClientOptions): SpritesClient {
  return new SpritesHttpClient(options);
}
