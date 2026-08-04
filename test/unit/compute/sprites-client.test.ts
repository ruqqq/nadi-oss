import { describe, expect, it } from "vitest";
import { ComputeError } from "../../../src/compute/errors";
import {
  createSpritesClient,
  parseExecFrame,
  type SpritesClient,
} from "../../../src/compute/backends/sprites-client";

interface RecordedCall {
  url: string;
  init: RequestInit;
}

interface FetchScript {
  status?: number;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  webSocket?: unknown;
  throws?: Error;
}

function harness(script: FetchScript | FetchScript[] = {}) {
  const calls: RecordedCall[] = [];
  const queue = Array.isArray(script) ? [...script] : [script];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = queue.length > 1 ? queue.shift()! : (queue[0] ?? {});
    if (next.throws) throw next.throws;
    if (next.webSocket) {
      return { status: next.status ?? 101, ok: false, webSocket: next.webSocket } as never;
    }
    const status = next.status ?? 200;
    // 204/205/304 must be constructed with a null body.
    const nullBody = status === 204 || status === 205 || status === 304;
    return new Response(nullBody ? null : (next.body ?? ""), {
      status,
      ...(next.headers ? { headers: next.headers } : {}),
    });
  }) as unknown as typeof fetch;

  const client: SpritesClient = createSpritesClient({ apiKey: "k-123", fetchImpl });
  return { calls, client };
}

function authOf(call: RecordedCall): unknown {
  return (call.init.headers as Record<string, string>).Authorization;
}

function bodyJson(call: RecordedCall): unknown {
  return JSON.parse(call.init.body as string);
}

function json(value: unknown, status = 200): FetchScript {
  return { status, body: JSON.stringify(value), headers: { "Content-Type": "application/json" } };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ComputeError) return error.code;
    throw error;
  }
  throw new Error("expected the promise to reject");
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ComputeError) return error.message;
    throw error;
  }
  throw new Error("expected the promise to reject");
}

describe("createSpritesClient REST surface", () => {
  it("sends the bearer token on every request", async () => {
    const { calls, client } = harness(json({ sprites: [] }));

    await client.listSprites(5);
    await client.setMemoryPolicy("s1", 2048);

    expect(calls).toHaveLength(2);
    for (const call of calls) expect(authOf(call)).toBe("Bearer k-123");
  });

  it("creates a sprite against the default base URL with a snake_case body", async () => {
    const { calls, client } = harness({ status: 201 });

    await client.createSprite("s1", { environment: { FOO: "bar" } });

    expect(calls[0]?.url).toBe("https://api.sprites.dev/v1/sprites");
    expect(calls[0]?.init.method).toBe("POST");
    expect(bodyJson(calls[0]!)).toEqual({ name: "s1", environment: { FOO: "bar" } });
  });

  it("honours a custom base URL", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const client = createSpritesClient({
      apiKey: "k",
      baseUrl: "https://example.test/v9",
      fetchImpl,
    });

    await client.deleteSprite("s1");

    expect(calls[0]?.url).toBe("https://example.test/v9/sprites/s1");
    expect(calls[0]?.init.method).toBe("DELETE");
  });

  it("lists sprites by name", async () => {
    const { calls, client } = harness(json({ sprites: [{ name: "a" }, { name: "b" }] }));

    await expect(client.listSprites(10)).resolves.toEqual({ names: ["a", "b"] });
    expect(calls[0]?.url).toContain("max_results=10");
  });

  it("throws provider_transient when the sprite listing is not an array", async () => {
    const { client } = harness(json({ sprites: { name: "a" } }));

    await expect(codeOf(client.listSprites())).resolves.toBe("provider_transient");
  });

  it("posts the network policy rules", async () => {
    const { calls, client } = harness({ status: 204 });

    await client.setNetworkPolicy("s1", [{ domain: "example.com", action: "allow" }]);

    expect(calls[0]?.url).toBe("https://api.sprites.dev/v1/sprites/s1/policy/network");
    expect(bodyJson(calls[0]!)).toEqual({ rules: [{ domain: "example.com", action: "allow" }] });
  });

  // `autoscale: true` makes the limit advisory: the sprite grows past the
  // profile's memory cap and bills for it. The cap has to be a cap.
  it("posts the memory policy as a hard cap, not an autoscaling hint", async () => {
    const { calls, client } = harness({ status: 204 });

    await client.setMemoryPolicy("s1", 4096);

    expect(calls[0]?.url).toBe("https://api.sprites.dev/v1/sprites/s1/policy/resources");
    expect(bodyJson(calls[0]!)).toEqual({ memory: { limit_mb: 4096, autoscale: false } });
  });

  it("bounds every request, giving creation the longer budget", async () => {
    // Nothing else stops a stalled REST call from pinning the Durable Object
    // turn it runs inside.
    const { calls, client } = harness({ status: 201 });

    await client.createSprite("s1", {});
    await client.setMemoryPolicy("s1", 2048);

    for (const call of calls) expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps an aborted request to provider_transient", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const { client } = harness({ throws: timeout });

    await expect(messageOf(client.listSprites())).resolves.toContain("sprites_request_timeout");
  });

  it("resolves deleteSprite on a 404 so cleanup stays idempotent", async () => {
    const { client } = harness({ status: 404 });

    await expect(client.deleteSprite("gone")).resolves.toBeUndefined();
  });

  it("maps a 500 on deleteSprite to provider_transient", async () => {
    const { client } = harness({ status: 500 });

    await expect(codeOf(client.deleteSprite("s1"))).resolves.toBe("provider_transient");
  });

  it("maps a 404 on a sprite-level operation to runtime_missing", async () => {
    const { client } = harness({ status: 404 });

    await expect(codeOf(client.setMemoryPolicy("s1", 1024))).resolves.toBe("runtime_missing");
  });

  it("maps a network failure to provider_transient", async () => {
    const { client } = harness({ throws: new TypeError("connection reset") });

    await expect(codeOf(client.listSprites())).resolves.toBe("provider_transient");
  });
});

describe("sessions", () => {
  // LIVE (2026-08-04), verbatim: `GET /exec` answers a WRAPPER and names the
  // session `id`. The previous bare-array parse threw on every real response, so
  // `getProcessStatus` and `stopProcess` could never work.
  it("parses the sessions wrapper and reads the id key", async () => {
    const { client } = harness(
      json({
        count: 1,
        sessions: [
          {
            id: "15",
            created: "2026-08-04T00:00:00Z",
            command: "sleep 120",
            workdir: "/home/sprite",
            tty: false,
            bytes_per_second: 0,
            is_active: false,
            last_activity: "2026-08-04T00:00:01Z",
          },
        ],
      }),
    );

    await expect(client.listSessions("s1")).resolves.toEqual([
      { sessionId: "15", command: "sleep 120" },
    ]);
  });

  it("still accepts a session_id alias", async () => {
    const { client } = harness(json({ sessions: [{ session_id: "sess-1", command: "sleep 1" }] }));

    await expect(client.listSessions("s1")).resolves.toEqual([
      { sessionId: "sess-1", command: "sleep 1" },
    ]);
  });

  it("parses an empty sessions wrapper as no sessions", async () => {
    const { client } = harness(json({ count: 0, sessions: [] }));

    await expect(client.listSessions("s1")).resolves.toEqual([]);
  });

  it("throws sprites_sessions_unexpected_shape when command is missing", async () => {
    const { client } = harness(json({ sessions: [{ id: "sess-1" }] }));

    await expect(messageOf(client.listSessions("s1"))).resolves.toBe(
      "sprites_sessions_unexpected_shape",
    );
  });

  it("throws when the body carries no sessions key at all", async () => {
    // A missing key is not evidence of "no sessions" — callers read an empty
    // listing as "the process is gone".
    const { client } = harness(json({ count: 0 }));

    await expect(messageOf(client.listSessions("s1"))).resolves.toBe(
      "sprites_sessions_unexpected_shape",
    );
  });

  it("throws when sessions is not an array", async () => {
    const { client } = harness(json({ sessions: "nope" }));

    await expect(messageOf(client.listSessions("s1"))).resolves.toBe(
      "sprites_sessions_unexpected_shape",
    );
  });

  it("kills a session with the signal in the query and drains the NDJSON body", async () => {
    const { calls, client } = harness({ body: '{"ok":true}\n' });

    await client.killSession("s1", "sess-1", "SIGTERM");

    expect(calls[0]?.url).toBe(
      "https://api.sprites.dev/v1/sprites/s1/exec/sess-1/kill?signal=SIGTERM",
    );
    expect(calls[0]?.init.method).toBe("POST");
  });
});

describe("filesystem", () => {
  it("reads bytes and carries a meaningful content type", async () => {
    const { calls, client } = harness({
      body: new TextEncoder().encode("hello").buffer as ArrayBuffer,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });

    const result = await client.fsRead("s1", "/tmp/a.txt");

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/sprites/s1/fs/read");
    expect(url.searchParams.get("path")).toBe("/tmp/a.txt");
    // The SDK sends `workingDir` on every /fs call; ours are absolute, but a
    // server default we never observed is not something to depend on.
    expect(url.searchParams.get("workingDir")).toBe("/");
    expect(new TextDecoder().decode(result?.bytes)).toBe("hello");
    expect(result?.mimeType).toBe("text/plain");
  });

  it("drops an application/octet-stream content type", async () => {
    const { client } = harness({
      body: new TextEncoder().encode("x").buffer as ArrayBuffer,
      headers: { "Content-Type": "application/octet-stream" },
    });

    const result = await client.fsRead("s1", "/tmp/a.bin");

    expect(result?.mimeType).toBeUndefined();
  });

  it("returns null for a 404 whose body says ENOENT", async () => {
    const { client } = harness(
      json({ error: "no such file or directory", code: "ENOENT", path: "/nope" }, 404),
    );

    await expect(client.fsRead("s1", "/nope")).resolves.toBeNull();
  });

  // A DELETED SPRITE 404s here too. Reading that as "empty file" made
  // `readSentinelText` report a dead sprite's process as having produced no
  // output — a silent empty transcript instead of a fault.
  it("maps a 404 that is not a missing FILE to runtime_missing", async () => {
    const { client } = harness(json({ error: "sprite not found" }, 404));

    await expect(codeOf(client.fsRead("s1", "/tmp/a"))).resolves.toBe("runtime_missing");
  });

  it("maps a 404 with a non-ENOENT filesystem code to runtime_missing", async () => {
    const { client } = harness(json({ error: "not a directory", code: "ENOTDIR" }, 404));

    await expect(codeOf(client.fsRead("s1", "/tmp/a/b"))).resolves.toBe("runtime_missing");
  });

  it("falls back to the error text when the 404 body carries no code", async () => {
    const { client } = harness(json({ error: "open /nope: no such file or directory" }, 404));

    await expect(client.fsRead("s1", "/nope")).resolves.toBeNull();
  });

  // LIVE-CAPTURED BODIES (2026-08-04), verbatim. Neither carries a `code`
  // field, so the SDK-derived ENOENT branch never fires against the real
  // server and the error-TEXT fallback is what does all the work. These two
  // cases are the record of that; if a "simplification" ever drops the
  // fallback, the first of them fails.
  it("discriminates the LIVE absent-file 404 from the LIVE absent-sprite 404", async () => {
    const absentFile = harness(
      json({ error: "open /tmp/x: no such file or directory", path: "/tmp/x" }, 404),
    );
    await expect(absentFile.client.fsRead("s1", "/tmp/x")).resolves.toBeNull();

    const absentSprite = harness(json({ error: "sprite not found" }, 404));
    await expect(codeOf(absentSprite.client.fsRead("s1", "/tmp/x"))).resolves.toBe(
      "runtime_missing",
    );
  });

  // Sturdier discrimination: the sprite-level 404 never names a path, so a body
  // that does is talking about a path inside a sprite it found — even if the
  // message wording changes out from under the regex.
  it("treats a path-scoped 404 body as file-level even with an unrecognised message", async () => {
    const { client } = harness(json({ error: "open /tmp/x: unlinked", path: "/tmp/x" }, 404));

    await expect(client.fsRead("s1", "/tmp/x")).resolves.toBeNull();
  });

  it("maps a 500 read to provider_transient", async () => {
    const { client } = harness({ status: 500 });

    await expect(codeOf(client.fsRead("s1", "/tmp/a"))).resolves.toBe("provider_transient");
  });

  it("maps a 401 read to compute_unavailable", async () => {
    const { client } = harness({ status: 401 });

    await expect(codeOf(client.fsRead("s1", "/tmp/a"))).resolves.toBe("compute_unavailable");
  });

  it("maps a 403 read to compute_unavailable", async () => {
    const { client } = harness({ status: 403 });

    await expect(codeOf(client.fsRead("s1", "/tmp/a"))).resolves.toBe("compute_unavailable");
  });

  it("maps a 429 read to provider_transient", async () => {
    const { client } = harness({ status: 429 });

    await expect(codeOf(client.fsRead("s1", "/tmp/a"))).resolves.toBe("provider_transient");
  });

  it("writes raw bytes with mkdirParents and an octet-stream content type", async () => {
    const { calls, client } = harness({ status: 204 });
    const bytes = new TextEncoder().encode("payload").buffer as ArrayBuffer;

    await client.fsWrite("s1", "/tmp/out.txt", bytes, true);

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/sprites/s1/fs/write");
    expect(url.searchParams.get("path")).toBe("/tmp/out.txt");
    expect(url.searchParams.get("workingDir")).toBe("/");
    // `mkdirParents` is the SDK's spelling. LIVE: parents were created under
    // both spellings AND under neither, so `false` is a request the server does
    // not enforce — we send it, and claim nothing about it.
    expect(url.searchParams.get("mkdirParents")).toBe("true");
    expect(calls[0]?.init.method).toBe("PUT");
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/octet-stream",
    );
    expect(calls[0]?.init.body).toBe(bytes);
  });

  it("writes with mkdirParents=false when not requested", async () => {
    const { calls, client } = harness({ status: 204 });

    await client.fsWrite("s1", "/tmp/out.txt", new ArrayBuffer(0), false);

    expect(calls[0]?.url).toContain("mkdirParents=false");
  });

  // LIVE (2026-08-04), verbatim: `/fs/list` answers a WRAPPER carrying `entries`
  // and a `count`, and each entry names its own `type`. The previous bare-array
  // parse threw on every real response, so `listDirectory` never worked at all.
  it("parses the entries wrapper and reads each entry's type", async () => {
    const { calls, client } = harness(
      json({
        path: "/work",
        count: 3,
        entries: [
          {
            name: "newdir",
            path: "/work/newdir",
            type: "directory",
            size: 4096,
            mode: "755",
            modTime: "2026-08-04T00:00:00Z",
            isDir: true,
          },
          {
            name: "a.txt",
            path: "/work/a.txt",
            type: "file",
            size: 12,
            mode: "644",
            modTime: "2026-08-04T00:00:00Z",
            isDir: false,
          },
          // `isDir` is FALSE for a link, which is why reading it demoted every
          // symlink to a regular file.
          {
            name: "link",
            path: "/work/link",
            type: "symlink",
            size: 11,
            mode: "777",
            modTime: "2026-08-04T00:00:00Z",
            isDir: false,
          },
        ],
      }),
    );

    await expect(client.fsList("s1", "/work")).resolves.toEqual([
      { name: "newdir", type: "directory", size: 4096 },
      { name: "a.txt", type: "file", size: 12 },
      { name: "link", type: "symlink", size: 11 },
    ]);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/sprites/s1/fs/list");
    expect(url.searchParams.get("path")).toBe("/work");
    expect(url.searchParams.get("workingDir")).toBe("/");
  });

  it("parses an empty entries wrapper as an empty directory", async () => {
    const { client } = harness(json({ path: "/work", entries: [], count: 0 }));

    await expect(client.fsList("s1", "/work")).resolves.toEqual([]);
  });

  it("maps a type it does not recognise to other rather than throwing", async () => {
    // A socket or device node is a listable entry, not a malformed response.
    const { client } = harness(json({ entries: [{ name: "sock", type: "socket", size: 0 }] }));

    await expect(client.fsList("s1", "/work")).resolves.toEqual([
      { name: "sock", type: "other", size: 0 },
    ]);
  });

  it("throws sprites_list_unexpected_shape when the body carries no entries key", async () => {
    // A shape mismatch is not evidence that the directory is empty — callers act
    // on `[]` destructively.
    const { client } = harness(json({ path: "/work", count: 0 }));

    await expect(messageOf(client.fsList("s1", "/work"))).resolves.toBe(
      "sprites_list_unexpected_shape",
    );
  });

  it("throws sprites_list_unexpected_shape when entries is not an array", async () => {
    const { client } = harness(json({ entries: "nope" }));

    await expect(messageOf(client.fsList("s1", "/work"))).resolves.toBe(
      "sprites_list_unexpected_shape",
    );
  });

  it("throws sprites_list_unexpected_shape when an entry has no type", async () => {
    const { client } = harness(json({ entries: [{ name: "a.txt", isDir: false, size: 1 }] }));

    await expect(messageOf(client.fsList("s1", "/work"))).resolves.toBe(
      "sprites_list_unexpected_shape",
    );
  });

  it("throws sprites_list_unexpected_shape when an entry name carries a slash", async () => {
    const { client } = harness(json({ entries: [{ name: "/work/a.txt", type: "file", size: 1 }] }));

    await expect(messageOf(client.fsList("s1", "/work"))).resolves.toBe(
      "sprites_list_unexpected_shape",
    );
  });

  it("throws sprites_list_unexpected_shape when an entry name is empty", async () => {
    const { client } = harness(json({ entries: [{ name: "", type: "file", size: 1 }] }));

    await expect(messageOf(client.fsList("s1", "/work"))).resolves.toBe(
      "sprites_list_unexpected_shape",
    );
  });
});

function frame(stream: number, payload: string | Uint8Array): ArrayBuffer {
  const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const out = new Uint8Array(bytes.length + 1);
  out[0] = stream;
  out.set(bytes, 1);
  return out.buffer;
}

describe("parseExecFrame", () => {
  it("reads the stdout stream id and payload", () => {
    const parsed = parseExecFrame(frame(1, "hi"));

    expect(parsed.stream).toBe(1);
    expect(new TextDecoder().decode(parsed.payload)).toBe("hi");
  });

  it("reads the stderr stream id", () => {
    expect(parseExecFrame(frame(2, "boom")).stream).toBe(2);
  });

  it("reads an exit frame whose payload is the single exit-code byte", () => {
    const parsed = parseExecFrame(frame(3, new Uint8Array([7])));

    expect(parsed.stream).toBe(3);
    expect(parsed.payload[0]).toBe(7);
  });

  it("accepts an empty payload on stdout", () => {
    expect(parseExecFrame(frame(1, "")).payload.length).toBe(0);
  });

  it("accepts an empty payload on stderr", () => {
    expect(parseExecFrame(frame(2, "")).payload.length).toBe(0);
  });

  it("rejects an exit frame with no exit-code byte rather than defaulting to 0", () => {
    expect(() => parseExecFrame(frame(3, ""))).toThrow("sprites_exec_bad_exit");
  });

  it("rejects an exit frame carrying more than one byte", () => {
    expect(() => parseExecFrame(frame(3, new Uint8Array([0, 1])))).toThrow("sprites_exec_bad_exit");
  });

  it("throws on an empty frame with no stream byte", () => {
    expect(() => parseExecFrame(new ArrayBuffer(0))).toThrow(ComputeError);
  });

  it("throws on an unknown stream id", () => {
    expect(() => parseExecFrame(frame(9, "x"))).toThrow(ComputeError);
  });
});

/**
 * Models the Workers WebSocket contract that the live smoke exposed:
 *
 * - frames emitted BEFORE `accept()` are buffered by the runtime and delivered
 *   at `accept()`;
 * - once accepted, delivery is immediate and a frame with NO listener attached
 *   is DROPPED — there is no replay for a listener attached later.
 * - **binary messages arrive as a `Blob`** unless `binaryType` was set to
 *   `"arraybuffer"` BEFORE `accept()`. This is workerd's real default, and the
 *   reason it is modelled here: the previous fake handed out `ArrayBuffer`s
 *   unconditionally, so 187 green tests coexisted with a production client that
 *   silently dropped every stdout, stderr and exit frame it was ever sent.
 *
 * The drop is recorded rather than thrown so a test can assert on it.
 */
class FakeWebSocket {
  accepted = false;
  closed = false;
  /** Set by the code under test; only a pre-`accept()` value counts. */
  binaryType = "blob";
  /** What `binaryType` read at `accept()` — what delivery actually honours. */
  binaryTypeAtAccept = "blob";
  /**
   * Deliver `Blob`s even when `binaryType` says otherwise, modelling a runtime
   * that ignores the setting. The client must complain, not drop the frame.
   */
  forceBlob = false;
  /** Event types delivered while no listener was attached, i.e. lost. */
  readonly dropped: string[] = [];
  /** Runs synchronously inside `accept()`, like a server that answers in ~25ms. */
  onAccept?: (socket: FakeWebSocket) => void;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  private readonly buffered: Array<{ type: string; event: unknown }> = [];

  accept(): void {
    this.accepted = true;
    // Latched here, like the real socket: `accept()` starts delivery, so a
    // `binaryType` assigned afterwards cannot change how frames arrive.
    this.binaryTypeAtAccept = this.binaryType;
    for (const item of this.buffered.splice(0)) this.deliver(item.type, item.event);
    this.onAccept?.(this);
  }

  close(): void {
    this.closed = true;
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(fn);
    this.listeners.set(type, existing);
  }

  emit(type: string, event: unknown): void {
    if (!this.accepted) {
      this.buffered.push({ type, event });
      return;
    }
    this.deliver(type, event);
  }

  /**
   * Queued as raw bytes; the Blob-vs-ArrayBuffer decision is made at DELIVERY,
   * because that is when the runtime consults the latched `binaryType`.
   */
  emitFrame(stream: number, payload: string | Uint8Array): void {
    this.emit(BINARY, frame(stream, payload));
  }

  private deliver(type: string, event: unknown): void {
    const isBinary = type === BINARY;
    const deliveredType = isBinary ? "message" : type;
    const deliveredEvent = isBinary
      ? {
          data:
            this.binaryTypeAtAccept === "arraybuffer" && !this.forceBlob
              ? (event as ArrayBuffer)
              : new Blob([event as ArrayBuffer]),
        }
      : event;
    const fns = this.listeners.get(deliveredType) ?? [];
    if (fns.length === 0) {
      this.dropped.push(deliveredType);
      return;
    }
    for (const fn of fns) fn(deliveredEvent);
  }
}

/** Internal queue tag for a binary frame awaiting its delivery-time shape. */
const BINARY = "__binary";

/** Let the client reach its `addEventListener` calls before frames are emitted. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("execCollect", () => {
  it("builds the exec URL with repeated cmd and env params and upgrades the connection", async () => {
    const ws = new FakeWebSocket();
    const { calls, client } = harness({ webSocket: ws });

    const pending = client.execCollect("s1", {
      argv: ["bash", "-c", "echo hi"],
      dir: "/work",
      env: { A: "1", B: "2" },
    });
    await flush();
    ws.emitFrame(3, new Uint8Array([0]));
    await pending;

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/sprites/s1/exec");
    expect(url.searchParams.getAll("cmd")).toEqual(["bash", "-c", "echo hi"]);
    expect(url.searchParams.get("dir")).toBe("/work");
    expect(url.searchParams.get("path")).toBe("bash");
    // `env` REPLACES the sprite environment, so a PATH is prepended for callers
    // that did not supply one — and it is the sprite's OWN default, read back
    // live. The two leading entries are load-bearing: `/home/sprite/.local/bin`
    // is where a sandbox's user-installed tools live, so a "sane default" that
    // omitted it would un-install them the moment env is sent on every exec.
    expect(url.searchParams.getAll("env")).toEqual([
      "PATH=/home/sprite/.local/bin:/.sprite/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "A=1",
      "B=2",
    ]);
    expect(url.searchParams.get("detachable")).toBeNull();
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Upgrade).toBe("websocket");
    expect(headers.Authorization).toBe("Bearer k-123");
    expect(ws.accepted).toBe(true);
  });

  it("accumulates stdout and stderr and resolves on the exit frame", async () => {
    const ws = new FakeWebSocket();
    const { client } = harness({ webSocket: ws });

    const pending = client.execCollect("s1", { argv: ["bash", "-c", "x"] });
    await flush();
    ws.emitFrame(1, "hello ");
    ws.emitFrame(2, "warn");
    ws.emitFrame(1, "world");
    ws.emit("message", { data: JSON.stringify({ type: "port_opened", port: 3000 }) });
    ws.emitFrame(3, new Uint8Array([42]));

    await expect(pending).resolves.toEqual({
      exitCode: 42,
      stdout: "hello world",
      stderr: "warn",
    });
    expect(ws.closed).toBe(true);
  });

  it("decodes multi-byte characters split across frames", async () => {
    const ws = new FakeWebSocket();
    const { client } = harness({ webSocket: ws });
    const euro = new TextEncoder().encode("€");

    const pending = client.execCollect("s1", { argv: ["bash"] });
    await flush();
    ws.emitFrame(1, euro.slice(0, 1));
    ws.emitFrame(1, euro.slice(1));
    ws.emitFrame(3, new Uint8Array([0]));

    await expect(pending).resolves.toMatchObject({ stdout: "€" });
  });

  it("rejects a truncated exit frame instead of reporting success", async () => {
    const ws = new FakeWebSocket();
    const { client } = harness({ webSocket: ws });

    const pending = client.execCollect("s1", { argv: ["bash"] });
    await flush();
    ws.emitFrame(1, "output");
    ws.emitFrame(3, "");

    await expect(messageOf(pending)).resolves.toBe("sprites_exec_bad_exit");
    expect(ws.closed).toBe(true);
  });

  it("rejects an exit frame with a multi-byte payload", async () => {
    const ws = new FakeWebSocket();
    const { client } = harness({ webSocket: ws });

    const pending = client.execCollect("s1", { argv: ["bash"] });
    await flush();
    ws.emitFrame(3, new Uint8Array([0, 0]));

    await expect(messageOf(pending)).resolves.toBe("sprites_exec_bad_exit");
  });

  it("rejects with sprites_exec_no_exit when the socket closes without an exit frame", async () => {
    const ws = new FakeWebSocket();
    const { client } = harness({ webSocket: ws });

    const pending = client.execCollect("s1", { argv: ["bash"] });
    await flush();
    ws.emitFrame(1, "partial");
    ws.emit("close", { code: 1006, reason: "abnormal" });

    // The close code and reason are the only diagnosis this failure ever gets.
    await expect(messageOf(pending)).resolves.toBe(
      "sprites_exec_no_exit: code=1006 reason=abnormal",
    );
  });

  it("reports an unknown close code rather than omitting it", async () => {
    const ws = new FakeWebSocket();
    const { client } = harness({ webSocket: ws });

    const pending = client.execCollect("s1", { argv: ["bash"] });
    await flush();
    ws.emit("close", {});

    await expect(messageOf(pending)).resolves.toBe("sprites_exec_no_exit: code=unknown");
  });

  // The text notification can PRECEDE trailing output, so settling on it
  // truncates stdout. The binary stream-3 frame is the one that settles the run.
  it("keeps output that arrives after the text exit notification", async () => {
    const ws = new FakeWebSocket();
    const { client } = harness({ webSocket: ws });

    const pending = client.execCollect("s1", { argv: ["bash"] });
    await flush();
    ws.emitFrame(1, "out");
    ws.emit("message", { data: JSON.stringify({ type: "exit", exit_code: 7 }) });
    ws.emitFrame(1, "-trailing");
    ws.emitFrame(3, new Uint8Array([7]));

    await expect(pending).resolves.toEqual({ exitCode: 7, stdout: "out-trailing", stderr: "" });
    expect(ws.closed).toBe(true);
  });

  it("falls back to the announced text code when the socket closes with no binary frame", async () => {
    const ws = new FakeWebSocket();
    const { client } = harness({ webSocket: ws });

    const pending = client.execCollect("s1", { argv: ["bash"] });
    await flush();
    ws.emitFrame(1, "out");
    ws.emit("message", { data: JSON.stringify({ type: "exit", exit_code: 7 }) });
    ws.emit("close", { code: 1000 });

    await expect(pending).resolves.toEqual({ exitCode: 7, stdout: "out", stderr: "" });
  });

  it("falls back to the announced text code after a short grace, without a close", async () => {
    // A server that only ever sends the text form must not hang the caller until
    // its own timeout.
    const ws = new FakeWebSocket();
    const { client } = harness({ webSocket: ws });

    const pending = client.execCollect("s1", { argv: ["bash"] });
    await flush();
    ws.emitFrame(1, "out");
    ws.emit("message", { data: JSON.stringify({ type: "exit", exit_code: 7 }) });

    await expect(pending).resolves.toEqual({ exitCode: 7, stdout: "out", stderr: "" });
  });

  it("ignores an exit notification whose code is missing rather than reporting success", async () => {
    const ws = new FakeWebSocket();
    const { client } = harness({ webSocket: ws });

    const pending = client.execCollect("s1", { argv: ["bash"] });
    await flush();
    ws.emit("message", { data: JSON.stringify({ type: "exit" }) });
    // The authoritative binary frame still decides.
    ws.emitFrame(3, new Uint8Array([3]));

    await expect(pending).resolves.toMatchObject({ exitCode: 3 });
  });

  it("ignores non-exit text notifications", async () => {
    const ws = new FakeWebSocket();
    const { client } = harness({ webSocket: ws });

    const pending = client.execCollect("s1", { argv: ["bash"] });
    await flush();
    ws.emit("message", { data: JSON.stringify({ type: "debug", msg: "session_created" }) });
    ws.emit("message", { data: "not json at all" });
    ws.emitFrame(3, new Uint8Array([0]));

    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
  });

  it("keeps a caller-supplied PATH instead of overriding it", async () => {
    const ws = new FakeWebSocket();
    const { calls, client } = harness({ webSocket: ws });

    const pending = client.execCollect("s1", { argv: ["bash"], env: { PATH: "/opt/bin" } });
    await flush();
    ws.emitFrame(3, new Uint8Array([0]));
    await pending;

    expect(new URL(calls[0]!.url).searchParams.getAll("env")).toEqual(["PATH=/opt/bin"]);
  });

  it("sends no env param at all when the caller supplies none", async () => {
    const ws = new FakeWebSocket();
    const { calls, client } = harness({ webSocket: ws });

    const pending = client.execCollect("s1", { argv: ["bash"] });
    await flush();
    ws.emitFrame(3, new Uint8Array([0]));
    await pending;

    expect(new URL(calls[0]!.url).searchParams.getAll("env")).toEqual([]);
  });

  it("rejects with sprites_exec_timeout and closes the socket when timeoutMs elapses", async () => {
    const ws = new FakeWebSocket();
    const { client } = harness({ webSocket: ws });

    const pending = client.execCollect("s1", { argv: ["sleep"], timeoutMs: 5 });

    await expect(messageOf(pending)).resolves.toBe("sprites_exec_timeout");
    expect(ws.closed).toBe(true);
  });

  // REGRESSION (live smoke, 2026-08-04): the client accepted the socket inside
  // `openExecSocket` and attached its listeners only after `await`-ing it. The
  // server answered inside that gap, every frame was dropped, and the run died
  // with `sprites_exec_no_exit` on the very first `mkdir -p -- /workspace`.
  // Replays the captured frame sequence verbatim.
  it("keeps frames that arrive the instant the socket is accepted", async () => {
    const ws = new FakeWebSocket();
    ws.onAccept = (socket) => {
      socket.emit("message", {
        data: JSON.stringify({ msg: "session_created cmd=bash", pid: 332, type: "debug" }),
      });
      socket.emit("message", {
        data: JSON.stringify({ type: "session_info", session_id: "332", command: "bash" }),
      });
      socket.emitFrame(1, "hello-stderr\nhello-stdout\n");
      socket.emit("message", { data: JSON.stringify({ type: "exit", exit_code: 7 }) });
      socket.emitFrame(3, new Uint8Array([7]));
      // The live socket closed ~5s after the frames; a macrotask stands in.
      setTimeout(() => socket.emit("close", {}), 0);
    };
    const { client } = harness({ webSocket: ws });

    await expect(client.execCollect("s1", { argv: ["bash", "-c", "x"] })).resolves.toEqual({
      exitCode: 7,
      stdout: "hello-stderr\nhello-stdout\n",
      stderr: "",
    });
    expect(ws.dropped).toEqual([]);
  });

  it("receives frames buffered before accept", async () => {
    const ws = new FakeWebSocket();
    const { client } = harness({ webSocket: ws });
    ws.emitFrame(1, "early");
    ws.emitFrame(3, new Uint8Array([0]));

    await expect(client.execCollect("s1", { argv: ["bash"] })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "early",
    });
    expect(ws.dropped).toEqual([]);
  });

  it("maps a failed upgrade to the status-appropriate ComputeError", async () => {
    const { client } = harness({ status: 404 });

    await expect(codeOf(client.execCollect("s1", { argv: ["bash"] }))).resolves.toBe(
      "runtime_missing",
    );
  });

  // REGRESSION (live smoke, 2026-08-04): workerd delivers binary WebSocket
  // messages as a `Blob`, and the handler's `instanceof ArrayBuffer` guard
  // dropped every one of them in silence — no stdout, no exit code, just
  // `sprites_exec_no_exit`. The fake now defaults to `Blob` like the real
  // runtime, so this test captures NOTHING unless the client asks for
  // ArrayBuffers before `accept()`.
  //
  // MUTATION CHECK: delete `ws.binaryType = "arraybuffer"` from `execCollect`
  // and this fails — the frames arrive as Blobs and the run rejects with
  // `sprites_exec_unreadable_frame` instead of resolving with stdout.
  it("captures stdout only because it asks for ArrayBuffer frames before accept", async () => {
    const ws = new FakeWebSocket();
    const { client } = harness({ webSocket: ws });

    const pending = client.execCollect("s1", { argv: ["bash", "-c", "echo AA"] });
    await flush();
    ws.emitFrame(1, "AA");
    ws.emitFrame(3, new Uint8Array([0]));

    await expect(pending).resolves.toEqual({ exitCode: 0, stdout: "AA", stderr: "" });
    // The ordering half of the same requirement: a `binaryType` assigned after
    // `accept()` is too late for frames already in flight.
    expect(ws.binaryTypeAtAccept).toBe("arraybuffer");
  });

  it("rejects, naming the type, if a Blob arrives despite binaryType", async () => {
    const ws = new FakeWebSocket();
    // A runtime that ignores the setting. The frame must never be dropped in
    // silence again — that is the whole failure mode this class of bug has.
    ws.forceBlob = true;
    const { client } = harness({ webSocket: ws });

    const pending = client.execCollect("s1", { argv: ["bash", "-c", "echo AA"] });
    await flush();
    ws.emitFrame(1, "AA");

    const message = await messageOf(pending);
    expect(message).toContain("sprites_exec_unreadable_frame");
    expect(message).toContain("Blob");
    expect(ws.closed).toBe(true);
  });

  // SECRET LEAK REGRESSION. The exec URL carries `env=GH_TOKEN=ghs_…` and every
  // workbench secret, and workerd's fetch rejections routinely embed the
  // request URL in their message. That message is NOT swallowed: it is returned
  // to the model as `compute-tools.ts`'s `detail`, so it lands in the persisted
  // transcript and the logs.
  //
  // MUTATION CHECK: restore the interpolation
  // (`` `sprites_exec_upgrade_failed: ${error.message}` ``) in `openExecSocket`
  // and this test fails on all three assertions.
  it("never leaks the exec URL's secrets when the upgrade fetch rejects", async () => {
    const token = "ghs_supersecrettokenvalue";
    // The rejection message a real transport failure produces: the whole URL.
    const leak = new Error(
      `Fetch API cannot load: https://api.sprites.dev/v1/sprites/s1/exec?cmd=bash&env=GH_TOKEN=${token}&env=NPM_TOKEN=npm_alsosecret`,
    );
    const { client } = harness({ throws: leak });

    const message = await messageOf(
      client.execCollect("s1", { argv: ["bash"], env: { GH_TOKEN: token } }),
    );

    expect(message).toContain("sprites_exec_upgrade_failed");
    expect(message).not.toContain(token);
    expect(message).not.toContain("env=");
    expect(message).not.toContain("api.sprites.dev");
  });

  // The REST path is deliberately NOT scrubbed — its query strings carry no
  // secrets and the detail is worth having. Pinned so the scrub above is not
  // "helpfully" generalised into the one place it costs diagnosis.
  it("still interpolates the transport error on the REST path", async () => {
    const { client } = harness({ throws: new Error("connect ECONNREFUSED 10.0.0.1:443") });

    await expect(messageOf(client.listSprites())).resolves.toContain("ECONNREFUSED");
  });

  it("bounds the upgrade itself, mapping the abort to provider_transient", async () => {
    // Without a signal on the upgrade fetch, `execCollect`'s own timer never
    // arms (it is set up after the await) and a stalled upgrade pins the
    // Durable Object turn indefinitely.
    const aborted = new Error("The operation was aborted due to timeout");
    aborted.name = "TimeoutError";
    const { calls, client } = harness({ throws: aborted });

    const pending = client.execCollect("s1", { argv: ["bash"] });
    await expect(codeOf(pending)).resolves.toBe("provider_transient");
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  // SILENT TRUNCATION REGRESSION. The text `exit` notification can precede the
  // last output frames — live, 349528 bytes arrived over 13 frames — so a grace
  // timer that arms once and is never renewed DROPS everything that lands after
  // it and resolves with the announced code and no error at all.
  //
  // The gaps below (700ms, then 1200ms cumulative) are far past the 250ms the
  // grace used to be, which is exactly the window that dropped output.
  //
  // MUTATION CHECK, both halves independently:
  //  - restore `TEXT_EXIT_GRACE_MS = 250` → stdout is `"before"`, exit 0, no
  //    error (the silent-wrong-answer this test exists for);
  //  - restore the `if (graceTimer === undefined)` guard around the arm →
  //    stdout is `"before-after"`, because the un-renewed 2s timer fires while
  //    the third frame is still coming.
  it("re-arms the text-exit grace on every data frame, so trailing output survives", async () => {
    const ws = new FakeWebSocket();
    const { client } = harness({ webSocket: ws });

    const pending = client.execCollect("s1", { argv: ["bash"] });
    await flush();
    ws.emitFrame(1, "before");
    ws.emit("message", { data: JSON.stringify({ type: "exit", exit_code: 0 }) });
    // A server under backpressure, drip-feeding what it had buffered.
    await new Promise((resolve) => setTimeout(resolve, 700));
    ws.emitFrame(1, "-after");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    ws.emitFrame(1, "-later");
    ws.emitFrame(3, new Uint8Array([0]));

    await expect(pending).resolves.toEqual({
      exitCode: 0,
      stdout: "before-after-later",
      stderr: "",
    });
  });

  // The other half of the contract: a server that only ever announces in text
  // and then goes silent must still not hang the caller — the renewed timer has
  // to actually fire once the frames stop.
  it("still settles on the grace once trailing output stops arriving", async () => {
    const ws = new FakeWebSocket();
    const { client } = harness({ webSocket: ws });

    const pending = client.execCollect("s1", { argv: ["bash"] });
    await flush();
    ws.emit("message", { data: JSON.stringify({ type: "exit", exit_code: 5 }) });
    await new Promise((resolve) => setTimeout(resolve, 100));
    ws.emitFrame(1, "tail");

    await expect(pending).resolves.toEqual({ exitCode: 5, stdout: "tail", stderr: "" });
  });

  // The 64KiB fast-path replay cap IS detectable: the server names the path and
  // the history length in a `debug` frame. Both frames below are LIVE captures,
  // verbatim (2026-08-04).
  it("flags a fast_path replay at the 64KiB cap as truncated", async () => {
    const ws = new FakeWebSocket();
    const { client } = harness({ webSocket: ws });

    const pending = client.execCollect("s1", { argv: ["bash"] });
    await flush();
    ws.emit("message", {
      data: '{"msg":"session_created cmd=bash","pid":333,"t_ms":22,"type":"debug"}',
    });
    ws.emit("message", {
      data: '{"msg":"fast_path attach_err=session has exited exit_code=0 history_len=65536","pid":333,"t_ms":22,"type":"debug"}',
    });
    ws.emitFrame(1, "AAAA");
    ws.emitFrame(3, new Uint8Array([0]));

    await expect(pending).resolves.toEqual({
      exitCode: 0,
      stdout: "AAAA",
      stderr: "",
      truncated: true,
    });
  });

  it("does not flag a streamed run, or a fast_path replay under the cap", async () => {
    const streamed = new FakeWebSocket();
    const a = harness({ webSocket: streamed });
    const streaming = a.client.execCollect("s1", { argv: ["bash"] });
    await flush();
    streamed.emit("message", {
      data: '{"msg":"normal_path history_len=0","pid":23,"t_ms":17,"type":"debug"}',
    });
    streamed.emitFrame(3, new Uint8Array([0]));
    await expect(streaming).resolves.toEqual({ exitCode: 0, stdout: "", stderr: "" });

    // A replay UNDER the cap is complete output; live, `echo hi` replayed with
    // `history_len=3`. Flagging it would train callers to ignore the flag.
    const small = new FakeWebSocket();
    const b = harness({ webSocket: small });
    const short = b.client.execCollect("s1", { argv: ["bash"] });
    await flush();
    small.emit("message", {
      data: '{"msg":"fast_path attach_err=session has exited exit_code=0 history_len=3","pid":346,"t_ms":22,"type":"debug"}',
    });
    small.emitFrame(1, "hi\n");
    small.emitFrame(3, new Uint8Array([0]));
    await expect(short).resolves.toEqual({ exitCode: 0, stdout: "hi\n", stderr: "" });
  });
});

describe("execDetached", () => {
  /** The frame the live server sends on connect, verbatim. */
  function sessionInfo(sessionId: string): string {
    return JSON.stringify({
      type: "session_info",
      session_id: sessionId,
      command: "bash",
      created: "2026-08-04T00:00:00Z",
      cols: 0,
      rows: 0,
      is_owner: false,
      tty: false,
    });
  }

  // The session listing reports the INNER process's argv, so nothing we embed in
  // the wrapper is ever findable. This frame is the only disclosure of the id,
  // and returning it is what makes a background process addressable at all.
  it("returns the session id from the server's session_info frame", async () => {
    const ws = new FakeWebSocket();
    const { calls, client } = harness({ webSocket: ws });
    ws.emit("message", { data: JSON.stringify({ type: "debug", msg: "session_created" }) });
    ws.emit("message", { data: sessionInfo("15") });

    await expect(
      client.execDetached("s1", {
        argv: ["bash", "-c", "long"],
        detachable: true,
        maxRunAfterDisconnect: "600s",
      }),
    ).resolves.toBe("15");

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("detachable")).toBe("true");
    expect(url.searchParams.get("max_run_after_disconnect")).toBe("600s");
    expect(ws.accepted).toBe(true);
    // Closing does not stop the run — `detachable=true` outlives the socket.
    expect(ws.closed).toBe(true);
    expect(ws.dropped).toEqual([]);
  });

  it("takes the session id from a frame delivered the instant the socket is accepted", async () => {
    const ws = new FakeWebSocket();
    ws.onAccept = (socket) => socket.emit("message", { data: sessionInfo("42") });
    const { client } = harness({ webSocket: ws });

    await expect(client.execDetached("s1", { argv: ["bash"] })).resolves.toBe("42");
    expect(ws.dropped).toEqual([]);
  });

  it("fails rather than returning an unaddressable process when the socket closes first", async () => {
    const ws = new FakeWebSocket();
    ws.onAccept = (socket) => socket.emit("close", { code: 1006 });
    const { client } = harness({ webSocket: ws });

    await expect(messageOf(client.execDetached("s1", { argv: ["bash"] }))).resolves.toContain(
      "sprites_exec_no_session_info",
    );
  });

  it("maps a failed upgrade to compute_unavailable on 403", async () => {
    const { client } = harness({ status: 403 });

    await expect(codeOf(client.execDetached("s1", { argv: ["bash"] }))).resolves.toBe(
      "compute_unavailable",
    );
  });

  // `detachable` means the server keeps the session running after we
  // disconnect, so a launch we never got an id for is a process nothing can
  // address, holding memory against the sprite's cap until its
  // `max_run_after_disconnect` deadline. The `debug` frame's `pid` is the same
  // number as the session id (live: 333/333, 23/23, 346/346) and arrives first,
  // which is why it is the only handle available here.
  it("best-effort reaps the launched session when it never gets a session_info", async () => {
    const ws = new FakeWebSocket();
    ws.onAccept = (socket) => {
      socket.emit("message", {
        data: '{"msg":"session_created cmd=bash","pid":333,"t_ms":22,"type":"debug"}',
      });
      socket.emit("close", { code: 1006 });
    };
    const { calls, client } = harness([
      { webSocket: ws },
      json({ count: 1, sessions: [{ id: "333", command: "bash" }] }),
      { status: 200, body: "" },
    ]);

    await expect(messageOf(client.execDetached("s1", { argv: ["bash"] }))).resolves.toContain(
      "sprites_exec_no_session_info",
    );

    expect(calls[1]?.url).toBe("https://api.sprites.dev/v1/sprites/s1/exec");
    expect(calls[2]?.url).toBe(
      "https://api.sprites.dev/v1/sprites/s1/exec/333/kill?signal=SIGKILL",
    );
  });

  it("does not kill a session id the listing does not confirm", async () => {
    const ws = new FakeWebSocket();
    ws.onAccept = (socket) => {
      socket.emit("message", {
        data: '{"msg":"session_created cmd=bash","pid":333,"t_ms":22,"type":"debug"}',
      });
      socket.emit("close", { code: 1006 });
    };
    const { calls, client } = harness([
      { webSocket: ws },
      json({ count: 0, sessions: [] }),
      { status: 200, body: "" },
    ]);

    await expect(codeOf(client.execDetached("s1", { argv: ["bash"] }))).resolves.toBe(
      "provider_transient",
    );

    expect(calls.map((call) => call.url).filter((url) => url.includes("/kill"))).toEqual([]);
  });

  it("keeps the launch error when the reap itself fails", async () => {
    const ws = new FakeWebSocket();
    ws.onAccept = (socket) => {
      socket.emit("message", {
        data: '{"msg":"session_created cmd=bash","pid":333,"t_ms":22,"type":"debug"}',
      });
      socket.emit("close", { code: 1006 });
    };
    const { client } = harness([{ webSocket: ws }, { status: 500 }]);

    // A failed cleanup must not replace the error that says why the launch
    // failed with a less informative one.
    await expect(messageOf(client.execDetached("s1", { argv: ["bash"] }))).resolves.toContain(
      "sprites_exec_no_session_info",
    );
  });
});
