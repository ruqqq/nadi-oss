import { describe, expect, it } from "vitest";
import { reserveFeedbackSlot } from "../../../src/agent/feedback-rate-limit";

type StoredValue = unknown;

class MemoryStorage {
  readonly values = new Map<string, StoredValue>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
}

const now = 1_800_000_000_000;

describe("reserveFeedbackSlot", () => {
  it("allows 30 model turns per rolling hour and returns earliest retry", async () => {
    const storage = new MemoryStorage();

    for (let i = 0; i < 30; i += 1) {
      expect(
        await reserveFeedbackSlot(storage, { kind: "model_turn", key: `msg_${i}`, now }),
      ).toEqual({ ok: true });
    }
    expect(await reserveFeedbackSlot(storage, { kind: "model_turn", key: "msg_31", now })).toEqual({
      ok: false,
      retryAfterSeconds: 3600,
    });
    expect(
      await reserveFeedbackSlot(storage, {
        kind: "model_turn",
        key: "msg_31",
        now: now + 3_600_000,
      }),
    ).toEqual({ ok: true });
  });

  it("keeps five hourly reports and twenty daily reports independent", async () => {
    const hourlyStorage = new MemoryStorage();

    for (let i = 0; i < 5; i += 1) {
      expect(
        await reserveFeedbackSlot(hourlyStorage, {
          kind: "report_submission",
          key: `hour_${i}`,
          now,
        }),
      ).toEqual({ ok: true });
    }
    expect(
      await reserveFeedbackSlot(hourlyStorage, { kind: "report_submission", key: "hour_6", now }),
    ).toEqual({
      ok: false,
      retryAfterSeconds: 3600,
    });

    const dailyStorage = new MemoryStorage();
    for (let i = 0; i < 20; i += 1) {
      expect(
        await reserveFeedbackSlot(dailyStorage, {
          kind: "report_submission",
          key: `day_${i}`,
          now: now + i * 3_600_000,
        }),
      ).toEqual({ ok: true });
    }
    expect(
      await reserveFeedbackSlot(dailyStorage, {
        kind: "report_submission",
        key: "day_21",
        now: now + 20 * 3_600_000,
      }),
    ).toEqual({
      ok: false,
      retryAfterSeconds: 14_400,
    });
  });

  it("does not consume another slot for a reused idempotency key", async () => {
    const storage = new MemoryStorage();

    expect(
      await reserveFeedbackSlot(storage, { kind: "model_turn", key: "msg_same", now }),
    ).toEqual({
      ok: true,
    });
    expect(
      await reserveFeedbackSlot(storage, { kind: "model_turn", key: "msg_same", now }),
    ).toEqual({
      ok: true,
    });

    for (let i = 1; i < 30; i += 1) {
      expect(
        await reserveFeedbackSlot(storage, { kind: "model_turn", key: `msg_${i}`, now }),
      ).toEqual({ ok: true });
    }
    expect(await reserveFeedbackSlot(storage, { kind: "model_turn", key: "msg_30", now })).toEqual({
      ok: false,
      retryAfterSeconds: 3600,
    });
  });
});
