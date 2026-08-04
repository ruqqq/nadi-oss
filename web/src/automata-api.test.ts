import { describe, expect, it, vi } from "vitest";
import {
  archiveAutomaton,
  createAutomaton,
  describeSchedule,
  getAutomaton,
  listAutomata,
  runAutomatonNow,
  updateAutomaton,
} from "./automata-api";

function mockFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

describe("listAutomata", () => {
  it("unwraps the automata field", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ automata: [{ id: "auto_1" }] }), { status: 200 }),
      );
    await expect(listAutomata(fetchImpl)).resolves.toEqual([{ id: "auto_1" }]);
    expect(fetchImpl).toHaveBeenCalledWith("/api/automata", { credentials: "include" });
  });

  it("throws a human-readable error, never a status code", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    await expect(listAutomata(fetchImpl)).rejects.toThrow(/load your automata/i);
  });

  it("surfaces lastRun: null for an automaton that has never run", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ automata: [{ id: "auto_1", lastRun: null }] }), {
        status: 200,
      }),
    );
    await expect(listAutomata(fetchImpl)).resolves.toEqual([{ id: "auto_1", lastRun: null }]);
  });

  it("surfaces the inlined lastRun for an automaton that has run", async () => {
    const lastRun = {
      id: "run_1",
      status: "completed",
      trigger: "scheduled",
      startedAt: 1,
      finishedAt: 2,
      threadId: "thr_1",
      error: null,
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ automata: [{ id: "auto_1", lastRun }] }), { status: 200 }),
      );
    await expect(listAutomata(fetchImpl)).resolves.toEqual([{ id: "auto_1", lastRun }]);
  });

  it("surfaces workbenchId for an automaton with a per-automaton workbench override", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ automata: [{ id: "auto_1", workbenchId: "wbk_1" }] }), {
        status: 200,
      }),
    );
    const [parsed] = await listAutomata(fetchImpl);
    expect(parsed?.workbenchId).toBe("wbk_1");
  });
});

describe("getAutomaton", () => {
  it("unwraps the automaton and runs fields", async () => {
    const automaton = await getAutomaton(
      "auto_1",
      mockFetch(200, { automaton: { id: "auto_1" }, runs: [{ id: "run_1" }] }),
    );
    expect(automaton).toEqual({ automaton: { id: "auto_1" }, runs: [{ id: "run_1" }] });
  });

  it("throws a human-readable error on a non-ok response", async () => {
    await expect(getAutomaton("auto_1", mockFetch(404, {}))).rejects.toThrow(
      "That item couldn't be found — it may have already been removed.",
    );
  });
});

describe("createAutomaton", () => {
  it("posts the input and returns the created automaton", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ automaton: { id: "auto_1", name: "Daily briefing" } }), {
        status: 201,
      }),
    );
    const input = {
      name: "Daily briefing",
      prompt: "Give me my briefing.",
      schedule: { kind: "weekdays" as const, hour: 8, minute: 0 },
      timezone: "Asia/Singapore",
    };
    await expect(createAutomaton(input, fetchImpl)).resolves.toEqual({
      id: "auto_1",
      name: "Daily briefing",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/automata",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("throws a human-readable error, never a status code", async () => {
    await expect(
      createAutomaton(
        { name: "", prompt: "", schedule: { kind: "hourly", minute: 0 }, timezone: "UTC" },
        mockFetch(400, { error: "Give the automaton a name." }),
      ),
    ).rejects.toThrow("Give the automaton a name.");
  });
});

describe("updateAutomaton", () => {
  it("patches the input and returns the updated automaton", async () => {
    const automaton = await updateAutomaton(
      "auto_1",
      { enabled: false },
      mockFetch(200, { automaton: { id: "auto_1", enabled: false } }),
    );
    expect(automaton).toEqual({ id: "auto_1", enabled: false });
  });

  it("throws a human-readable error, never a status code", async () => {
    await expect(updateAutomaton("auto_1", {}, mockFetch(500, {}))).rejects.toThrow(
      /save the automaton/i,
    );
  });
});

describe("archiveAutomaton", () => {
  it("deletes and returns the archived automaton", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ automaton: { id: "auto_1", archivedAt: 1 } }), {
        status: 200,
      }),
    );
    await expect(archiveAutomaton("auto_1", fetchImpl)).resolves.toEqual({
      id: "auto_1",
      archivedAt: 1,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/automata/auto_1",
      expect.objectContaining({ method: "DELETE", credentials: "include" }),
    );
  });

  it("throws a human-readable error, never a status code", async () => {
    await expect(archiveAutomaton("auto_1", mockFetch(500, {}))).rejects.toThrow(
      /delete the automaton/i,
    );
  });
});

describe("runAutomatonNow", () => {
  it("posts and returns the created thread id", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ runId: "arun_1", threadId: "thr_1" }), { status: 202 }),
      );
    await expect(runAutomatonNow("auto_1", fetchImpl)).resolves.toEqual({
      runId: "arun_1",
      threadId: "thr_1",
    });
  });

  it("throws a human-readable error on a 500", async () => {
    await expect(runAutomatonNow("auto_1", mockFetch(500, { error: "boom" }))).rejects.toThrow(
      "boom",
    );
  });
});

describe("describeSchedule", () => {
  const tz = "UTC";

  it("renders a human summary for the list row", () => {
    expect(describeSchedule({ kind: "weekdays", hour: 8, minute: 0 }, tz)).toBe("Weekdays at 08:00");
    expect(describeSchedule({ kind: "daily", hour: 8, minute: 5 }, tz)).toBe("Daily at 08:05");
    expect(describeSchedule({ kind: "hourly", minute: 0 }, tz)).toBe("Hourly at :00");
    expect(describeSchedule({ kind: "weekly", weekday: 1, hour: 8, minute: 0 }, tz)).toBe(
      "Mondays at 08:00",
    );
    expect(describeSchedule({ kind: "cron", expr: "0 8 * * 1-5" }, tz)).toBe(
      "Custom (0 8 * * 1-5)",
    );
  });
});
