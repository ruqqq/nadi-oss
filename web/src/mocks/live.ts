/**
 * `/live` user-hub socket stub for the mock app.
 *
 * `openUserHubSocket` (web/src/lib/user-hub-socket.ts) constructs a partysocket
 * `ReconnectingWebSocket` directly, and partysocket resolves the global
 * `WebSocket` at connect time. So the smallest honest fake is a global
 * constructor override that returns a fake socket for the `/live` URL only and
 * delegates every other URL to the native constructor.
 *
 * MSW's WebSocket interception is deliberately NOT used here: it would require
 * routing the `ws:` URL through the service worker and buys nothing, since the
 * mock app never needs real duplex traffic.
 *
 * The fake reports OPEN (so the app never renders a disconnected state),
 * swallows the only message the client ever sends (`{type:"presence",…}`), and
 * dispatches `open` on the next tick so partysocket's connection timeout never
 * fires — that timeout is what would otherwise produce a reconnect loop.
 */

const LIVE_PATHNAME = "/live";

type WebSocketEventMap = {
  open: Event;
  close: CloseEvent;
  error: Event;
  message: MessageEvent;
};

/** Minimal WebSocket-shaped fake. Extends EventTarget so listener management is real. */
class FakeLiveSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  readonly protocol = "";
  readonly extensions = "";
  readonly bufferedAmount = 0;
  binaryType: BinaryType = "blob";
  readyState: number = FakeLiveSocket.CONNECTING;

  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    // Open on a macrotask, mirroring a real connection: partysocket attaches its
    // listeners synchronously after construction, so a synchronous open would be
    // missed and its connection timeout would tear the socket down and retry.
    setTimeout(() => {
      if (this.readyState !== FakeLiveSocket.CONNECTING) return;
      this.readyState = FakeLiveSocket.OPEN;
      this.#emit("open", new Event("open"));
    }, 0);
  }

  /** Accepts `{type:"presence",…}` (the only thing the client sends) and drops it. */
  send(_data: unknown): void {
    if (this.readyState !== FakeLiveSocket.OPEN) {
      throw new DOMException("Still in CONNECTING state.", "InvalidStateError");
    }
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === FakeLiveSocket.CLOSING || this.readyState === FakeLiveSocket.CLOSED) {
      return;
    }
    this.readyState = FakeLiveSocket.CLOSED;
    this.#emit("close", new CloseEvent("close", { code, reason, wasClean: true }));
  }

  /**
   * Push a raw server→client frame at the app — a JSON string shaped like the
   * `UserEvent` union in web/src/lib/thread-events.ts. Unused by default; here
   * so a scenario can drive live list updates.
   */
  emitServerMessage(raw: string): void {
    if (this.readyState !== FakeLiveSocket.OPEN) return;
    this.#emit("message", new MessageEvent("message", { data: raw }));
  }

  #emit<K extends keyof WebSocketEventMap>(type: K, event: WebSocketEventMap[K]): void {
    this.dispatchEvent(event);
    const handler = this[`on${type}`] as ((ev: WebSocketEventMap[K]) => unknown) | null;
    handler?.call(this as unknown as WebSocket, event);
  }
}

const liveSockets = new Set<FakeLiveSocket>();

function isLiveUrl(url: string | URL): boolean {
  try {
    // A relative URL is resolved against the page, matching WebSocket semantics.
    return new URL(String(url), window.location.href).pathname === LIVE_PATHNAME;
  } catch {
    return false;
  }
}

let installed = false;

/**
 * Override `window.WebSocket` so `/live` gets the fake and every other URL gets
 * the real thing. Idempotent. Must run before the app opens its hub socket.
 */
export function installLiveSocketStub(): void {
  if (installed) return;
  installed = true;

  const NativeWebSocket = window.WebSocket;

  // A Proxy over the native constructor keeps the statics (WebSocket.OPEN, used
  // by setUserHubPresence), `instanceof`, and the name intact for free.
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args: [string | URL, (string | string[])?]) {
      const [url] = args;
      if (isLiveUrl(url)) {
        const socket = new FakeLiveSocket(url);
        liveSockets.add(socket);
        socket.addEventListener("close", () => liveSockets.delete(socket), { once: true });
        return socket as unknown as object;
      }
      return Reflect.construct(target, args);
    },
  });
}

export function dispatchMockFeedbackReportCreated(reportId: string, submittedAt: number): void {
  const raw = JSON.stringify({ type: "feedback.report.created", reportId, submittedAt });
  for (const socket of liveSockets) socket.emitServerMessage(raw);
}

/**
 * Push a `thread.updated` at the app, exactly as the real hub does when a run
 * ends. This is what drives the in-app activity toast — the only way to see it
 * without a backend, since it fires on a live transition rather than on any
 * seeded state.
 */
export function dispatchMockThreadUpdated(thread: unknown, preview?: string): void {
  const raw = JSON.stringify({
    type: "thread.updated",
    thread,
    ...(preview ? { preview } : {}),
  });
  for (const socket of liveSockets) socket.emitServerMessage(raw);
}
