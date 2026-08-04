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

  it("posts the memory policy with an autoscaling limit", async () => {
    const { calls, client } = harness({ status: 204 });

    await client.setMemoryPolicy("s1", 4096);

    expect(calls[0]?.url).toBe("https://api.sprites.dev/v1/sprites/s1/policy/resources");
    expect(bodyJson(calls[0]!)).toEqual({ memory: { limit_mb: 4096, autoscale: true } });
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
  it("accepts both session_id and id keys", async () => {
    const { client } = harness(
      json([
        { session_id: "sess-1", command: "sleep 1" },
        { id: "sess-2", command: "sleep 2" },
      ]),
    );

    await expect(client.listSessions("s1")).resolves.toEqual([
      { sessionId: "sess-1", command: "sleep 1" },
      { sessionId: "sess-2", command: "sleep 2" },
    ]);
  });

  it("throws sprites_sessions_unexpected_shape when command is missing", async () => {
    const { client } = harness(json([{ session_id: "sess-1" }]));

    await expect(messageOf(client.listSessions("s1"))).resolves.toBe(
      "sprites_sessions_unexpected_shape",
    );
  });

  it("throws sprites_sessions_unexpected_shape when the payload is a wrapper object", async () => {
    const { client } = harness(json({ sessions: [] }));

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

    expect(calls[0]?.url).toBe("https://api.sprites.dev/v1/sprites/s1/fs/read?path=%2Ftmp%2Fa.txt");
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

  it("returns null when the path is absent", async () => {
    const { client } = harness({ status: 404 });

    await expect(client.fsRead("s1", "/nope")).resolves.toBeNull();
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

  it("writes raw bytes with mkdir and an octet-stream content type", async () => {
    const { calls, client } = harness({ status: 204 });
    const bytes = new TextEncoder().encode("payload").buffer as ArrayBuffer;

    await client.fsWrite("s1", "/tmp/out.txt", bytes, true);

    expect(calls[0]?.url).toBe(
      "https://api.sprites.dev/v1/sprites/s1/fs/write?path=%2Ftmp%2Fout.txt&mkdir=true",
    );
    expect(calls[0]?.init.method).toBe("PUT");
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/octet-stream",
    );
    expect(calls[0]?.init.body).toBe(bytes);
  });

  it("writes with mkdir=false when not requested", async () => {
    const { calls, client } = harness({ status: 204 });

    await client.fsWrite("s1", "/tmp/out.txt", new ArrayBuffer(0), false);

    expect(calls[0]?.url).toContain("mkdir=false");
  });

  it("lists entries, accepting is_dir or isDir", async () => {
    const { calls, client } = harness(
      json([
        { name: "a.txt", is_dir: false, size: 12 },
        { name: "sub", isDir: true, size: 0 },
      ]),
    );

    await expect(client.fsList("s1", "/work")).resolves.toEqual([
      { name: "a.txt", isDir: false, size: 12 },
      { name: "sub", isDir: true, size: 0 },
    ]);
    expect(calls[0]?.url).toBe("https://api.sprites.dev/v1/sprites/s1/fs/list?path=%2Fwork");
  });

  it("throws sprites_list_unexpected_shape for a wrapper object instead of returning []", async () => {
    const { client } = harness(json({ entries: [] }));

    await expect(messageOf(client.fsList("s1", "/work"))).resolves.toBe(
      "sprites_list_unexpected_shape",
    );
  });

  it("throws sprites_list_unexpected_shape when an entry name carries a slash", async () => {
    const { client } = harness(json([{ name: "/work/a.txt", is_dir: false, size: 1 }]));

    await expect(messageOf(client.fsList("s1", "/work"))).resolves.toBe(
      "sprites_list_unexpected_shape",
    );
  });

  it("throws sprites_list_unexpected_shape when an entry name is empty", async () => {
    const { client } = harness(json([{ name: "", is_dir: false, size: 1 }]));

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

  it("accepts an empty payload", () => {
    expect(parseExecFrame(frame(1, "")).payload.length).toBe(0);
  });

  it("throws on an empty frame with no stream byte", () => {
    expect(() => parseExecFrame(new ArrayBuffer(0))).toThrow(ComputeError);
  });

  it("throws on an unknown stream id", () => {
    expect(() => parseExecFrame(frame(9, "x"))).toThrow(ComputeError);
  });
});

class FakeWebSocket {
  accepted = false;
  closed = false;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  accept(): void {
    this.accepted = true;
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
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  emitFrame(stream: number, payload: string | Uint8Array): void {
    this.emit("message", { data: frame(stream, payload) });
  }
}

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
    expect(url.searchParams.getAll("env")).toEqual(["A=1", "B=2"]);
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

  it("rejects with sprites_exec_no_exit when the socket closes without an exit frame", async () => {
    const ws = new FakeWebSocket();
    const { client } = harness({ webSocket: ws });

    const pending = client.execCollect("s1", { argv: ["bash"] });
    await flush();
    ws.emitFrame(1, "partial");
    ws.emit("close", {});

    await expect(messageOf(pending)).resolves.toBe("sprites_exec_no_exit");
  });

  it("rejects with sprites_exec_timeout and closes the socket when timeoutMs elapses", async () => {
    const ws = new FakeWebSocket();
    const { client } = harness({ webSocket: ws });

    const pending = client.execCollect("s1", { argv: ["sleep"], timeoutMs: 5 });

    await expect(messageOf(pending)).resolves.toBe("sprites_exec_timeout");
    expect(ws.closed).toBe(true);
  });

  it("maps a failed upgrade to the status-appropriate ComputeError", async () => {
    const { client } = harness({ status: 404 });

    await expect(codeOf(client.execCollect("s1", { argv: ["bash"] }))).resolves.toBe(
      "runtime_missing",
    );
  });
});

describe("execDetached", () => {
  it("passes detachable and max_run_after_disconnect, then closes the socket", async () => {
    const ws = new FakeWebSocket();
    const { calls, client } = harness({ webSocket: ws });

    await client.execDetached("s1", {
      argv: ["bash", "-c", "long"],
      detachable: true,
      maxRunAfterDisconnect: "600s",
    });

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("detachable")).toBe("true");
    expect(url.searchParams.get("max_run_after_disconnect")).toBe("600s");
    expect(ws.accepted).toBe(true);
    expect(ws.closed).toBe(true);
  });

  it("maps a failed upgrade to compute_unavailable on 403", async () => {
    const { client } = harness({ status: 403 });

    await expect(codeOf(client.execDetached("s1", { argv: ["bash"] }))).resolves.toBe(
      "compute_unavailable",
    );
  });
});
