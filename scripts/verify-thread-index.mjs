#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DATABASE = "nadi-registry";
const DEFAULT_CREATED_AT = 1_766_880_000_000;
const DEFAULT_SYSTEM_PROMPT = "You are Nadi, a helpful AI assistant. Be concise and clear.";

const DEFAULT_BACKFILL = {
  workspaceId: "default",
  workspaceName: "Default Workspace",
  agentId: "agent_default",
  agentName: "Default Agent",
  provider: "openai-oauth",
  model: "gpt-5.4-mini",
  threadId: "default",
  threadTitle: "Default",
  createdAt: DEFAULT_CREATED_AT,
};

export function buildBackfillStatements(input = {}) {
  const cfg = { ...DEFAULT_BACKFILL, ...input };
  return [
    `INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (${sqlString(cfg.workspaceId)}, ${sqlString(cfg.workspaceName)}, ${cfg.createdAt})`,
    `INSERT OR IGNORE INTO agents (id, workspace_id, name, system_prompt, provider, model, created_at) VALUES (${sqlString(cfg.agentId)}, ${sqlString(cfg.workspaceId)}, ${sqlString(cfg.agentName)}, ${sqlString(DEFAULT_SYSTEM_PROMPT)}, ${sqlString(cfg.provider)}, ${sqlString(cfg.model)}, ${cfg.createdAt})`,
    `INSERT OR IGNORE INTO thread_index (id, workspace_id, agent_id, title, source, automaton_id, automaton_run_id, last_event_id, last_message_preview, created_at, updated_at) VALUES (${sqlString(cfg.threadId)}, ${sqlString(cfg.workspaceId)}, ${sqlString(cfg.agentId)}, ${sqlString(cfg.threadTitle)}, 'manual', NULL, NULL, NULL, '', ${cfg.createdAt}, ${cfg.createdAt})`,
  ];
}

export function buildOrphanCountQuery() {
  return [
    "SELECT",
    "(SELECT COUNT(*) FROM thread_index t LEFT JOIN workspaces w ON w.id = t.workspace_id WHERE w.id IS NULL) AS workspace_orphans,",
    "(SELECT COUNT(*) FROM thread_index t LEFT JOIN agents a ON a.id = t.agent_id WHERE a.id IS NULL) AS agent_orphans",
  ].join(" ");
}

export function parseOrphanCounts(raw) {
  const parsed = JSON.parse(raw);
  const firstResult = Array.isArray(parsed) ? parsed[0] : parsed;
  const row = firstResult?.results?.[0];
  return {
    workspaceOrphans: Number(row?.workspace_orphans ?? 0),
    agentOrphans: Number(row?.agent_orphans ?? 0),
  };
}

export function parseArgs(argv) {
  return {
    local: argv.includes("--local"),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scope = options.local ? "--local" : "--remote";

  console.log(`Verifying thread_index against ${DATABASE} (${scope})`);
  runD1(buildBackfillStatements().join(";\n") + ";", { ...options, json: false });

  const orphanOutput = runD1(buildOrphanCountQuery(), { ...options, json: true });
  const counts = parseOrphanCounts(orphanOutput);
  console.log(`workspace_orphans=${counts.workspaceOrphans}`);
  console.log(`agent_orphans=${counts.agentOrphans}`);

  const summaryOutput = runD1(
    [
      "SELECT id, workspace_id, agent_id, title, source, created_at, updated_at",
      "FROM thread_index",
      "ORDER BY updated_at DESC",
      "LIMIT 20",
    ].join(" "),
    { ...options, json: true },
  );
  console.log(summaryOutput.trim());

  if (counts.workspaceOrphans !== 0 || counts.agentOrphans !== 0) {
    process.exitCode = 1;
  }
}

function runD1(command, options) {
  const args = [
    "exec",
    "wrangler",
    "d1",
    "execute",
    DATABASE,
    options.local ? "--local" : "--remote",
    "--command",
    command,
  ];
  if (options.json) args.push("--json");
  return execFileSync("pnpm", args, {
    encoding: "utf8",
    stdio: options.json ? ["ignore", "pipe", "inherit"] : "inherit",
  });
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
