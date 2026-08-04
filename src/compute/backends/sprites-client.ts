import { ComputeError } from "../errors";

/**
 * A narrow client over the sprites.dev REST + WebSocket API.
 *
 * This file is deliberately the ONLY place that knows sprites wire shapes:
 * paths, snake_case field names, and the exec frame protocol. The backend above
 * it speaks the provider-neutral compute vocabulary, so correcting a wrong
 * assumption here (several of the endpoint details below are inferred from the
 * vendor's JS SDK, not from a live probe) never reaches past this seam.
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
}

export interface SpritesSessionInfo {
  sessionId: string;
  command: string;
}

export interface SpritesFsEntry {
  name: string;
  isDir: boolean;
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
  /** WS exec, buffered to completion. */
  execCollect(name: string, options: SpritesExecOptions): Promise<SpritesExecResult>;
  /** WS exec with detachable=true; connects, confirms launch, disconnects. */
  execDetached(name: string, options: SpritesExecOptions): Promise<void>;
  listSessions(name: string): Promise<SpritesSessionInfo[]>;
  killSession(name: string, sessionId: string, signal: SpritesSignal): Promise<void>;
  /** `null` = 404, i.e. the path is absent. */
  fsRead(name: string, path: string): Promise<{ bytes: ArrayBuffer; mimeType?: string } | null>;
  fsWrite(name: string, path: string, bytes: ArrayBuffer, mkdir: boolean): Promise<void>;
  fsList(name: string, path: string): Promise<SpritesFsEntry[]>;
}

export type SpritesSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

export interface SpritesClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Test seam; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export const SPRITES_DEFAULT_BASE_URL = "https://api.sprites.dev/v1";

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
 * One exec frame: byte 0 is the stream id, the rest is payload. Exit frames
 * (stream 3) carry a single byte, the exit code.
 *
 * Exported for direct unit testing — the framing is the one piece of this file
 * with no HTTP status to key on, so an unrecognized stream id must THROW rather
 * than be dropped: a silently ignored frame would let `execCollect` return a
 * short stdout, or hang waiting for an exit that already arrived mislabeled.
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
  return { stream, payload: view.subarray(1) };
}

function toArrayBuffer(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
  return data;
}

/** The subset of the socket this client uses, so tests can script one. */
interface ExecSocket {
  accept(): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: never) => void): void;
}

class SpritesHttpClient implements SpritesClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(options: SpritesClientOptions) {
    this.apiKey = options.apiKey;
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
        ...(payload === undefined ? {} : { body: payload }),
      });
    } catch (error) {
      // Transport failure — never a provider verdict, always worth a retry.
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
    const response = await this.request("POST", "/sprites", undefined, {
      name,
      environment: input.environment ?? {},
    });
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
      { memory: { limit_mb: limitMb, autoscale: true } },
    );
    if (!response.ok) throw mapError(response.status, "sprites_memory_policy_failed");
  }

  async listSessions(name: string): Promise<SpritesSessionInfo[]> {
    const response = await this.request("GET", `/sprites/${encodeURIComponent(name)}/exec`);
    if (!response.ok) throw mapError(response.status, "sprites_sessions_failed");
    const payload = await this.json(response, "sprites_sessions_unexpected_shape");
    if (!Array.isArray(payload)) {
      throw new ComputeError("provider_transient", "sprites_sessions_unexpected_shape");
    }
    return payload.map((entry) => {
      const row = entry as { session_id?: unknown; id?: unknown; command?: unknown } | null;
      const sessionId = typeof row?.session_id === "string" ? row.session_id : row?.id;
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
    });
    // The one endpoint where 404 is an answer, not a fault.
    if (response.status === 404) return null;
    if (!response.ok) throw mapError(response.status, "sprites_fs_read_failed");
    const bytes = await response.arrayBuffer();
    const contentType = response.headers.get("Content-Type")?.split(";")[0]?.trim();
    return contentType && contentType !== "application/octet-stream"
      ? { bytes, mimeType: contentType }
      : { bytes };
  }

  async fsWrite(name: string, path: string, bytes: ArrayBuffer, mkdir: boolean): Promise<void> {
    const response = await this.request(
      "PUT",
      `/sprites/${encodeURIComponent(name)}/fs/write`,
      { path, mkdir },
      undefined,
      bytes,
    );
    if (!response.ok) throw mapError(response.status, "sprites_fs_write_failed");
  }

  async fsList(name: string, path: string): Promise<SpritesFsEntry[]> {
    const response = await this.request("GET", `/sprites/${encodeURIComponent(name)}/fs/list`, {
      path,
    });
    if (!response.ok) throw mapError(response.status, "sprites_fs_list_failed");
    const payload = await this.json(response, "sprites_list_unexpected_shape");
    // Mirrors `daytona.ts:652-661`: a listing that does not parse must throw,
    // never map to `[]`. An empty list is a positive claim ("this directory is
    // empty") that higher layers act on destructively; a shape mismatch is not
    // evidence for it.
    if (!Array.isArray(payload)) {
      throw new ComputeError("provider_transient", "sprites_list_unexpected_shape");
    }
    return payload.map((entry) => {
      const row = entry as {
        name?: unknown;
        is_dir?: unknown;
        isDir?: unknown;
        size?: unknown;
      } | null;
      const entryName = row?.name;
      if (typeof entryName !== "string" || entryName.length === 0 || entryName.includes("/")) {
        throw new ComputeError("provider_transient", "sprites_list_unexpected_shape");
      }
      return {
        name: entryName,
        isDir: row?.is_dir === true || row?.isDir === true,
        size: typeof row?.size === "number" ? row.size : 0,
      };
    });
  }

  private execUrl(name: string, options: SpritesExecOptions): string {
    const url = new URL(`${this.baseUrl}/sprites/${encodeURIComponent(name)}/exec`);
    for (const arg of options.argv) url.searchParams.append("cmd", arg);
    if (options.dir) url.searchParams.set("dir", options.dir);
    for (const [key, value] of Object.entries(options.env ?? {})) {
      url.searchParams.append("env", `${key}=${value}`);
    }
    if (options.detachable) url.searchParams.set("detachable", "true");
    if (options.maxRunAfterDisconnect) {
      url.searchParams.set("max_run_after_disconnect", options.maxRunAfterDisconnect);
    }
    return url.toString();
  }

  /** Opens and accepts the exec socket, or throws the mapped upgrade failure. */
  private async openExecSocket(name: string, options: SpritesExecOptions): Promise<ExecSocket> {
    let response: Response;
    try {
      response = await this.doFetch(this.execUrl(name, options), {
        headers: { Upgrade: "websocket", Authorization: `Bearer ${this.apiKey}` },
      });
    } catch (error) {
      throw new ComputeError(
        "provider_transient",
        `sprites_exec_upgrade_failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const ws = (response as unknown as { webSocket?: ExecSocket | null }).webSocket;
    if (!ws) throw mapError(response.status, "sprites_exec_upgrade_failed");
    ws.accept();
    return ws;
  }

  async execCollect(name: string, options: SpritesExecOptions): Promise<SpritesExecResult> {
    const ws = await this.openExecSocket(name, options);
    return await new Promise<SpritesExecResult>((resolve, reject) => {
      const stdoutDecoder = new TextDecoder();
      const stderrDecoder = new TextDecoder();
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
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

      ws.addEventListener("message", (event: never) => {
        const data = (event as { data: unknown }).data;
        // Text frames are JSON control notifications (e.g. `port_opened`).
        if (typeof data === "string") return;
        if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return;
        let frame: { stream: 1 | 2 | 3; payload: Uint8Array };
        try {
          frame = parseExecFrame(toArrayBuffer(data as ArrayBuffer | ArrayBufferView));
        } catch (error) {
          settle(() => reject(error));
          return;
        }
        if (frame.stream === 1) {
          stdout += stdoutDecoder.decode(frame.payload, { stream: true });
          return;
        }
        if (frame.stream === 2) {
          stderr += stderrDecoder.decode(frame.payload, { stream: true });
          return;
        }
        const exitCode = frame.payload[0] ?? 0;
        // Flush any trailing partial multi-byte sequence.
        stdout += stdoutDecoder.decode();
        stderr += stderrDecoder.decode();
        settle(() => resolve({ exitCode, stdout, stderr }));
      });

      ws.addEventListener("close", () => {
        // No exit frame means the command's outcome is unknown — reporting a
        // fabricated exit code here would let a killed run read as success.
        settle(() => reject(new ComputeError("provider_transient", "sprites_exec_no_exit")));
      });

      ws.addEventListener("error", () => {
        settle(() => reject(new ComputeError("provider_transient", "sprites_exec_socket_error")));
      });
    });
  }

  async execDetached(name: string, options: SpritesExecOptions): Promise<void> {
    const ws = await this.openExecSocket(name, { ...options, detachable: true });
    // The command is launched server-side on connection, so one macrotask after
    // the socket is open is enough to confirm the launch. The process's survival
    // does not depend on this socket — the detachable session does.
    await new Promise((resolve) => setTimeout(resolve, 0));
    ws.close();
  }
}

export function createSpritesClient(options: SpritesClientOptions): SpritesClient {
  return new SpritesHttpClient(options);
}
