/**
 * A transcript whose assistant turn exercises every branch of the run log:
 * a shell command that succeeds and one that fails with a real exit code, a
 * file read, a patch, a web search, an MCP call that returns text, an MCP call
 * that returns `isError`, a denied call, a memory tool that answers with a
 * plain string, and a call still running.
 *
 * The payloads mirror the real return shapes — `ExecCompletedResult` from
 * src/compute/thread-service.ts, `ReadFileResult`/`ApplyPatchResult` from
 * src/compute/file-service.ts, the shared `{ok:false, error, detail}` failure,
 * and MCP's `CallToolResult` envelope. Inventing a shape here would make the
 * mock agree with a UI that production can't feed.
 */

export const TOOL_RUN_THREAD_ID = "thr_tool_run";
/** The single-call, one-huge-payload case. */
export const TOOL_WRITE_THREAD_ID = "thr_tool_write";

/** Matches the `tool_<serverId>_<toolName>` keys mcpToolKey() mints. */
const LINEAR = "tool_s1abc_create_issue";
const SENTRY = "tool_s2def_list_issues";

const PATCH = [
  "*** Begin Patch",
  "*** Update File: src/db/schema.ts",
  "@@ export const threads = sqliteTable(",
  '   createdAt: integer("created_at", { mode: "timestamp" }).notNull(),',
  '   updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),',
  '+  archivedAt: integer("archived_at", { mode: "timestamp" }),',
  '+  archivedBy: text("archived_by"),',
  " });",
  "-export type ThreadInsert = typeof threads.$inferInsert;",
  "+export type ThreadInsert = typeof threads.$inferInsert;",
  '+export type ThreadArchive = Pick<ThreadInsert, "archivedAt" | "archivedBy">;',
  "*** End Patch",
].join("\n");

const TYPECHECK_STDERR = [
  "src/db/queries/threads.ts(214,9): error TS2379: Argument of type",
  "  '{ archivedAt: Date | undefined; }' is not assignable to parameter of type",
  "  'ThreadInsert' with 'exactOptionalPropertyTypes: true'.",
  "    Types of property 'archivedAt' are incompatible.",
  "      Type 'Date | undefined' is not assignable to type 'Date'.",
  "src/db/queries/threads.ts(261,22): error TS2379: Argument of type",
  "  '{ archivedAt: Date | undefined; }' is not assignable to parameter of type",
  "  'ThreadUpdate'.",
  "Found 2 errors in the same file, starting at src/db/queries/threads.ts:214",
  "",
  "  ELIFECYCLE  Command failed with exit code 2.",
].join("\n");

function execOutput(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: true,
    processId: "proc_1",
    label: null,
    stdoutPreview: "",
    stderrPreview: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

function call(
  toolName: string,
  id: string,
  state: string,
  input: unknown,
  output?: unknown,
): Record<string, unknown> {
  return {
    type: `tool-${toolName}`,
    toolCallId: id,
    state,
    input,
    ...(output === undefined ? {} : { output }),
  };
}

const MARKDUMP = "tool_s3ghi_write";

/**
 * The single-call case, with a payload big enough to be the bug it came from: an
 * MCP `write` whose `content` is a whole digest. Before FIELD_VALUE_MAX that
 * string was rendered into a table cell and filled the sheet.
 */
export function singleMcpWriteTranscript(): unknown[] {
  const digest = [
    "---",
    "type: reading_digest",
    "title: Reddit Digest — Sat, 01 Aug 2026",
    "description: Top 20 Reddit posts curated for you, grouped by interest.",
    "---",
    "",
    "## At a glance",
    "",
    "Saturday's round-up is heavy on AI model news, a strong e-ink cluster led by",
    "Xteink X3 owner stories and open-source firmware, plus Singapore headlines.",
    "",
    ...Array.from({ length: 40 }, (_, i) => `### Item ${i + 1}\n\n**What it's about:** …\n`),
  ].join("\n");

  return [
    {
      id: "msg_write_user",
      role: "user",
      parts: [{ type: "text", text: "Publish today's digest." }],
    },
    {
      id: "msg_write_assistant",
      role: "assistant",
      parts: [
        { type: "text", text: "Writing the remaining clusters plus r/askSingapore and r/singapore." },
        call(
          MARKDUMP,
          "call_write",
          "output-available",
          { filename: "/opds/reddit/2026-08-01/digest.md", mode: "create", content: digest },
          { content: [{ type: "text", text: "Wrote /opds/reddit/2026-08-01/digest.md (18.4 kB)" }] },
        ),
      ],
    },
  ];
}

export function toolRunTranscript(): unknown[] {
  return [
    {
      id: "msg_tool_run_user",
      role: "user",
      parts: [
        {
          type: "text",
          text: "Add an archivedAt column to threads, regenerate the migration, and make sure it typechecks.",
        },
      ],
    },
    {
      id: "msg_tool_run_assistant",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "I'll add the column, regenerate the migration, and check the types before running the db tests.",
        },
        call("read_file", "call_read", "output-available", { path: "src/db/schema.ts" }, {
          ok: true,
          path: "src/db/schema.ts",
          startLine: 180,
          endLine: 196,
          truncated: true,
          hash: "sha256:9f2c",
          content: [
            'export const threads = sqliteTable("threads", {',
            '  id: text("id").primaryKey(),',
            '  workspaceId: text("workspace_id").notNull(),',
            '  title: text("title"),',
            '  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),',
            '  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),',
            "});",
          ].join("\n"),
        }),
        call(
          "apply_patch",
          "call_patch",
          "output-available",
          { patch: PATCH, expectedHashes: { "src/db/schema.ts": "sha256:9f2c" } },
          { ok: true, operations: 1, written: 1, deleted: 0 },
        ),
        call(
          "exec",
          "call_generate",
          "output-available",
          { command: "pnpm run db:generate" },
          execOutput({
            status: "exited",
            exitCode: 0,
            command: "pnpm run db:generate",
            stdoutPreview: [
              "Reading config file 'drizzle.config.ts'",
              "2 tables, 14 columns, 3 indexes",
              "✓ Your SQL migration file → migrations/0042_odd_wildcard.sql",
            ].join("\n"),
          }),
        ),
        call(
          "exec",
          "call_typecheck",
          "output-available",
          { command: "pnpm run typecheck", label: "Typecheck" },
          execOutput({
            status: "exited",
            exitCode: 2,
            command: "pnpm run typecheck",
            label: "Typecheck",
            stderrPreview: TYPECHECK_STDERR,
            stderrTruncated: true,
          }),
        ),
        call(
          "web_search",
          "call_search",
          "output-available",
          { query: "drizzle exactOptionalPropertyTypes inferInsert" },
          {
            searchId: "srch_1",
            totalAvailable: 47,
            results: [
              {
                title: "Type-safe inserts with exactOptionalPropertyTypes",
                url: "https://orm.drizzle.team/docs/typescript",
                snippet: "Drizzle infers insert types from the table definition…",
              },
              {
                title: "$inferInsert widens optional columns · Issue #1420",
                url: "https://github.com/drizzle-team/drizzle-orm/issues/1420",
                snippet: "Under exactOptionalPropertyTypes the inferred type…",
              },
              {
                title: "exactOptionalPropertyTypes — TypeScript 4.4",
                url: "https://www.typescriptlang.org/tsconfig",
                snippet: "With this flag enabled, optional properties…",
              },
            ],
          },
        ),
        // MCP: a text CallToolResult from a server the client knows.
        call(LINEAR, "call_linear", "output-available", {
          teamId: "NAD",
          title: "Widen ThreadInsert for archivedAt",
          labels: ["types", "db"],
        }, {
          content: [{ type: "text", text: "Created NAD-284 — Widen ThreadInsert for archivedAt" }],
          structuredContent: {
            identifier: "NAD-284",
            url: "https://linear.app/nadi/issue/NAD-284",
            state: "Todo",
          },
        }),
        // MCP: isError is a failure even though the call itself returned 200.
        call(SENTRY, "call_sentry", "output-available", { project: "nadi-worker" }, {
          isError: true,
          content: [
            { type: "text", text: "403 Forbidden: token is missing the project:read scope." },
          ],
        }),
        // A memory tool, which answers with a plain string rather than an object.
        call(
          "remember",
          "call_remember",
          "output-available",
          {
            title: "Drizzle inserts under exactOptionalPropertyTypes",
            content:
              "Widen the insert type at the call site rather than making the schema column non-optional.",
            kind: "project",
          },
          "remembered: mem_8s1 Drizzle inserts under exactOptionalPropertyTypes",
        ),
        // A built-in with no hand-written gutter: the verb is derived from its
        // friendly name, so the row reads "confirm | Work saved" and the column
        // is never blank.
        call("confirm_work_saved", "call_confirm", "output-available", {}, { ok: true }),
        // Declined at the approval gate.
        call("exec", "call_denied", "output-denied", { command: "gh pr merge --squash 284" }),
        // Still running when the transcript was fetched.
        call("exec", "call_running", "input-available", { command: "pnpm test test/unit/db" }),
      ],
    },
  ];
}
