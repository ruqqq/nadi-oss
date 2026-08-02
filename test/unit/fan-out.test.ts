import { describe, expect, it } from "vitest";
import { fanOutToUsers } from "../../src/agent/fan-out";
import type { UserEvent } from "../../src/agent/user-events";

const event: UserEvent = { type: "thread.deleted", threadId: "t1", workspaceId: "w1" };

function recordingHub() {
  const calls: Array<{ name: string; event: UserEvent }> = [];
  const hub = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      publish: async (e: UserEvent) => {
        calls.push({ name: id.name, event: e });
      },
    }),
  };
  return { hub, calls };
}

describe("fanOutToUsers", () => {
  it("publishes the event to every user's hub", async () => {
    const { hub, calls } = recordingHub();
    await fanOutToUsers(hub as never, ["u1", "u2"], event);
    expect(calls).toEqual([
      { name: "u1", event },
      { name: "u2", event },
    ]);
  });

  it("does not reject when one publish fails", async () => {
    const hub = {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        publish: async () => {
          if (id.name === "bad") throw new Error("boom");
        },
      }),
    };
    await expect(fanOutToUsers(hub as never, ["good", "bad"], event)).resolves.toBeUndefined();
  });
});
