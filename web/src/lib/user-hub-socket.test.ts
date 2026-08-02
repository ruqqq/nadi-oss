import { describe, expect, it, test, vi } from "vitest";
import { liveUrl, setUserHubPresence } from "./user-hub-socket";

describe("liveUrl", () => {
  test("maps http origin to a ws /live url", () => {
    expect(liveUrl("http://localhost:8787")).toBe("ws://localhost:8787/live");
  });
  test("maps https origin to a wss /live url", () => {
    expect(liveUrl("https://legacy.example.com")).toBe("wss://legacy.example.com/live");
  });
});

describe("setUserHubPresence", () => {
  it("sends active thread presence when the socket is open", () => {
    const socket = { readyState: WebSocket.OPEN, send: vi.fn() };
    setUserHubPresence(socket as unknown as WebSocket, { activeThreadId: "thr_1", visible: true });
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "presence", activeThreadId: "thr_1", visible: true }),
    );
  });

  it("does not send presence while the socket is closed", () => {
    const socket = { readyState: WebSocket.CLOSED, send: vi.fn() };
    setUserHubPresence(socket as unknown as WebSocket, { activeThreadId: "thr_1", visible: true });
    expect(socket.send).not.toHaveBeenCalled();
  });
});
