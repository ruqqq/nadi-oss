import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { AUTO_ARCHIVE_CRON, AUTOMATA_CRON } from "../../src/automata/fire-due";
import wranglerConfigText from "../../wrangler.jsonc?raw";

function wranglerCrons(): string[] {
  const match = /"crons"\s*:\s*\[([^\]]+)\]/.exec(wranglerConfigText);
  if (!match) throw new Error("wrangler.jsonc has no triggers.crons array");
  return [...match[1]!.matchAll(/"([^"]+)"/g)].map((cron) => cron[1]!);
}

async function seedCorruptDueAutomaton() {
  const now = Date.now();
  await env.REGISTRY_DB.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)")
    .bind("ws_scheduled_handler", "Scheduled handler", now)
    .run();
  await env.REGISTRY_DB.prepare(
    "INSERT INTO users (id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind("usr_scheduled_handler", "scheduled-handler@example.com", 1, now, now)
    .run();
  await env.REGISTRY_DB.prepare(
    "INSERT INTO agents (id, workspace_id, name, system_prompt, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind("agt_scheduled_handler", "ws_scheduled_handler", "Agent", "", "mock", "mock", now)
    .run();
  await env.REGISTRY_DB.prepare(
    "INSERT INTO automata (id, workspace_id, owner_user_id, agent_id, name, prompt, schedule_json, timezone, enabled, next_due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      "auto_scheduled_handler",
      "ws_scheduled_handler",
      "usr_scheduled_handler",
      "agt_scheduled_handler",
      "Bad schedule",
      "Run",
      '{"kind":"daily","hour":"bad","minute":0}',
      "UTC",
      1,
      now - 1000,
      now,
      now,
    )
    .run();
}

async function readScheduledAutomaton() {
  return env.REGISTRY_DB.prepare("SELECT enabled, disabled_reason FROM automata WHERE id = ?")
    .bind("auto_scheduled_handler")
    .first<{ enabled: number; disabled_reason: string | null }>();
}

describe("Worker scheduled handler", () => {
  it("routes the real wrangler cron strings", async () => {
    const crons = wranglerCrons();
    expect(crons).toEqual(expect.arrayContaining([AUTO_ARCHIVE_CRON, AUTOMATA_CRON]));

    await seedCorruptDueAutomaton();

    await worker.scheduled!(
      { cron: AUTO_ARCHIVE_CRON, scheduledTime: Date.now() } as ScheduledController,
      env,
    );
    expect(await readScheduledAutomaton()).toEqual({
      enabled: 1,
      disabled_reason: null,
    });

    await worker.scheduled!(
      { cron: AUTOMATA_CRON, scheduledTime: Date.now() } as ScheduledController,
      env,
    );
    expect(await readScheduledAutomaton()).toEqual({
      enabled: 0,
      disabled_reason: "Schedule is invalid.",
    });
  });
});
