import { describe, expect, it, vi } from "vitest";
import { handleNotificationClick } from "./notification-click";

function makeTarget(clientCount: number) {
  const order: string[] = [];
  const clients = Array.from({ length: clientCount }, () => ({
    focus: vi.fn(() => {
      order.push("focus");
      return Promise.resolve({});
    }),
    postMessage: vi.fn(() => order.push("postMessage")),
  }));
  return {
    order,
    clients,
    getClients: vi.fn(() => {
      order.push("getClients");
      return Promise.resolve(clients);
    }),
    openWindow: vi.fn(() => {
      order.push("openWindow");
      return Promise.resolve(null);
    }),
    savePending: vi.fn(() => {
      order.push("savePending");
      return Promise.resolve();
    }),
    origin: "https://nadi.test",
  };
}

describe("handleNotificationClick", () => {
  it("records the pending thread before touching any client", async () => {
    const target = makeTarget(1);

    await handleNotificationClick("/threads/thr_001", target);

    expect(target.savePending).toHaveBeenCalledWith("thr_001");
    // The client may never hear the message; the record must already be there.
    expect(target.order[0]).toBe("savePending");
    // Looking clients up is itself an await, and on an iOS foreground tap it is
    // the one that does not come back. It must not gate the record.
    expect(target.order.indexOf("savePending")).toBeLessThan(target.order.indexOf("getClients"));
  });

  it("records the pending thread even when the client lookup never settles", async () => {
    // The reported iOS failure: `clients.matchAll()` hangs on a foreground tap,
    // so a handler that awaits it first writes nothing, messages nobody, and
    // leaves no trace for the page to find on the next resume either.
    const target = makeTarget(0);
    target.getClients.mockReturnValueOnce(new Promise<never>(() => {}));

    void handleNotificationClick("/threads/thr_001", target);
    await vi.waitFor(() => expect(target.savePending).toHaveBeenCalledWith("thr_001"));
  });

  it("falls back to opening a window when the client lookup fails", async () => {
    const target = makeTarget(0);
    target.getClients.mockRejectedValueOnce(new Error("matchAll unavailable"));

    await handleNotificationClick("/threads/thr_001", target);

    expect(target.savePending).toHaveBeenCalledWith("thr_001");
    expect(target.openWindow).toHaveBeenCalledWith("https://nadi.test/threads/thr_001");
  });

  it("records the pending thread on the cold-start path too", async () => {
    const target = makeTarget(0);

    await handleNotificationClick("/threads/thr_001", target);

    expect(target.savePending).toHaveBeenCalledWith("thr_001");
    expect(target.openWindow).toHaveBeenCalledWith("https://nadi.test/threads/thr_001");
  });

  it("focuses and messages every open client instead of reloading them", async () => {
    const target = makeTarget(2);

    await handleNotificationClick("/threads/thr_001", target);

    for (const client of target.clients) {
      expect(client.focus).toHaveBeenCalled();
      expect(client.postMessage).toHaveBeenCalledWith({
        type: "navigate-thread",
        threadId: "thr_001",
      });
    }
    expect(target.openWindow).not.toHaveBeenCalled();
  });

  it("decodes an encoded thread id", async () => {
    const target = makeTarget(1);

    await handleNotificationClick(`/threads/${encodeURIComponent("thr/oddly named")}`, target);

    expect(target.savePending).toHaveBeenCalledWith("thr/oddly named");
  });

  it("opens the raw url with no pending record when the path is not a thread", async () => {
    const target = makeTarget(0);

    await handleNotificationClick("/", target);

    expect(target.savePending).not.toHaveBeenCalled();
    expect(target.openWindow).toHaveBeenCalledWith("https://nadi.test/");
  });

  it("still focuses clients when saving the record fails", async () => {
    const target = makeTarget(1);
    target.savePending.mockRejectedValueOnce(new Error("IndexedDB unavailable"));

    await expect(handleNotificationClick("/threads/thr_001", target)).resolves.toBeUndefined();

    expect(target.clients[0]?.postMessage).toHaveBeenCalled();
  });
});
