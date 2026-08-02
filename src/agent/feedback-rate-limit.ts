export type FeedbackRateDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

export type FeedbackRateKind = "model_turn" | "report_submission";

type FeedbackRateEvent = {
  key: string;
  at: number;
};

type FeedbackRateLimitState = {
  modelTurns?: FeedbackRateEvent[];
  reportSubmissions?: FeedbackRateEvent[];
};

type FeedbackRateStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
};

const STORAGE_KEY = "feedback:rate-limits";
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MODEL_TURNS_PER_HOUR = 30;
const REPORTS_PER_HOUR = 5;
const REPORTS_PER_DAY = 20;

function activeEvents(events: FeedbackRateEvent[] | undefined, now: number): FeedbackRateEvent[] {
  return (events ?? []).filter((event) => event.at > now - DAY_MS).sort((a, b) => a.at - b.at);
}

function activeInWindow(events: FeedbackRateEvent[], now: number, windowMs: number) {
  return events.filter((event) => event.at > now - windowMs);
}

function retryAfterSeconds(events: FeedbackRateEvent[], now: number, windowMs: number): number {
  const earliest = events[0];
  if (!earliest) return 1;
  return Math.max(1, Math.ceil((earliest.at + windowMs - now) / 1000));
}

function capEvents(events: FeedbackRateEvent[], limit: number): FeedbackRateEvent[] {
  return events.slice(Math.max(0, events.length - limit));
}

export async function reserveFeedbackSlot(
  storage: FeedbackRateStorage,
  input: { kind: FeedbackRateKind; key: string; now: number },
): Promise<FeedbackRateDecision> {
  const state = (await storage.get<FeedbackRateLimitState>(STORAGE_KEY)) ?? {};
  const modelTurns = activeEvents(state.modelTurns, input.now);
  const reportSubmissions = activeEvents(state.reportSubmissions, input.now);

  if (input.kind === "model_turn") {
    if (modelTurns.some((event) => event.key === input.key)) {
      await storage.put(STORAGE_KEY, {
        modelTurns: capEvents(modelTurns, MODEL_TURNS_PER_HOUR),
        reportSubmissions: capEvents(reportSubmissions, REPORTS_PER_DAY),
      });
      return { ok: true };
    }
    const hourly = activeInWindow(modelTurns, input.now, HOUR_MS);
    if (hourly.length >= MODEL_TURNS_PER_HOUR) {
      await storage.put(STORAGE_KEY, {
        modelTurns: capEvents(modelTurns, MODEL_TURNS_PER_HOUR),
        reportSubmissions: capEvents(reportSubmissions, REPORTS_PER_DAY),
      });
      return { ok: false, retryAfterSeconds: retryAfterSeconds(hourly, input.now, HOUR_MS) };
    }
    await storage.put(STORAGE_KEY, {
      modelTurns: capEvents(
        [...modelTurns, { key: input.key, at: input.now }],
        MODEL_TURNS_PER_HOUR,
      ),
      reportSubmissions: capEvents(reportSubmissions, REPORTS_PER_DAY),
    });
    return { ok: true };
  }

  if (reportSubmissions.some((event) => event.key === input.key)) {
    await storage.put(STORAGE_KEY, {
      modelTurns: capEvents(modelTurns, MODEL_TURNS_PER_HOUR),
      reportSubmissions: capEvents(reportSubmissions, REPORTS_PER_DAY),
    });
    return { ok: true };
  }
  const hourlyReports = activeInWindow(reportSubmissions, input.now, HOUR_MS);
  if (hourlyReports.length >= REPORTS_PER_HOUR) {
    await storage.put(STORAGE_KEY, {
      modelTurns: capEvents(modelTurns, MODEL_TURNS_PER_HOUR),
      reportSubmissions: capEvents(reportSubmissions, REPORTS_PER_DAY),
    });
    return { ok: false, retryAfterSeconds: retryAfterSeconds(hourlyReports, input.now, HOUR_MS) };
  }
  if (reportSubmissions.length >= REPORTS_PER_DAY) {
    await storage.put(STORAGE_KEY, {
      modelTurns: capEvents(modelTurns, MODEL_TURNS_PER_HOUR),
      reportSubmissions: capEvents(reportSubmissions, REPORTS_PER_DAY),
    });
    return {
      ok: false,
      retryAfterSeconds: retryAfterSeconds(reportSubmissions, input.now, DAY_MS),
    };
  }
  await storage.put(STORAGE_KEY, {
    modelTurns: capEvents(modelTurns, MODEL_TURNS_PER_HOUR),
    reportSubmissions: capEvents(
      [...reportSubmissions, { key: input.key, at: input.now }],
      REPORTS_PER_DAY,
    ),
  });
  return { ok: true };
}
