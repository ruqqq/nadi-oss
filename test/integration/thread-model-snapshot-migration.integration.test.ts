import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import migrationSql from "../../migrations/0011_thread_model_snapshots.sql?raw";

const TABLE_NAME = "thread_index_migration_test";

describe("thread model snapshot migration", () => {
  it("adds and backfills thread snapshot columns", async () => {
    await env.REGISTRY_DB.prepare(`DROP TABLE IF EXISTS ${TABLE_NAME}`).run();
    await env.REGISTRY_DB.prepare(
      `CREATE TABLE ${TABLE_NAME} (
        id text PRIMARY KEY NOT NULL,
        workspace_id text NOT NULL,
        agent_id text NOT NULL,
        title text NOT NULL,
        title_set integer DEFAULT false NOT NULL,
        runtime text DEFAULT 'legacy' NOT NULL,
        source text NOT NULL,
        automaton_id text,
        automaton_run_id text,
        last_event_id text,
        last_message_preview text DEFAULT '' NOT NULL,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )`,
    ).run();
    await env.REGISTRY_DB.prepare(
      `INSERT INTO ${TABLE_NAME} (
        id,
        workspace_id,
        agent_id,
        title,
        source,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind("thr_before_migration", "workspace-1", "agent-1", "Before", "manual", 1, 1)
      .run();

    const sql = migrationSql.replaceAll("thread_index", TABLE_NAME);
    for (const statement of sql
      .split(";")
      .map((stmt) => stmt.trim())
      .filter(Boolean)) {
      await env.REGISTRY_DB.prepare(statement).run();
    }

    const columns = await env.REGISTRY_DB.prepare(`PRAGMA table_info(${TABLE_NAME})`).all<{
      name: string;
    }>();
    expect(columns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "model_provider",
        "model",
        "model_input_modalities",
        "show_reasoning",
      ]),
    );

    const row = await env.REGISTRY_DB.prepare(
      `SELECT model_provider, model, model_input_modalities, show_reasoning
       FROM ${TABLE_NAME}
       WHERE id = ?`,
    )
      .bind("thr_before_migration")
      .first<{
        model_provider: string;
        model: string;
        model_input_modalities: string;
        show_reasoning: number;
      }>();
    expect(row).toEqual({
      model_provider: "openai-oauth",
      model: "gpt-5.5",
      model_input_modalities: '["text","image","file"]',
      show_reasoning: 1,
    });
  });
});
