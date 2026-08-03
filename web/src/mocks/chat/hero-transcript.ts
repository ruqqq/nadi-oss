/**
 * A transcript sized and shaped for documentation screenshots: two full
 * exchanges, each with prose either side of an activity run, so the conversation
 * pane is full rather than a short turn floating above whitespace.
 *
 * Deliberately NOT a coding session. A hero image is read as a claim about who
 * the product is for, and the run log already reads as developer tooling on its
 * own; a shell-and-patch transcript would say "this is an IDE". This one is
 * support/ops work — read the tickets, find the pattern, write the update,
 * schedule it — which is what the tools plus a schedule actually enable.
 *
 * Payloads stay small. The run log's own branches (failures, denials, huge
 * outputs) are covered by {@link toolRunTranscript}; duplicating them here would
 * only make this fixture harder to keep true.
 */

export const HERO_THREAD_ID = "thr_hero";

/** Match the `tool_<serverId>_<toolName>` keys mcpToolKey() mints, and the
 *  server ids heroStore registers, so the run log renders friendly names. */
const ZENDESK = "tool_s4zen_search_tickets";
const MARKDUMP = "tool_s3ghi_write";
const LINEAR = "tool_s1abc_create_issue";

function call(
  toolName: string,
  id: string,
  input: unknown,
  output: unknown,
): Record<string, unknown> {
  return {
    type: `tool-${toolName}`,
    toolCallId: id,
    state: "output-available",
    input,
    output,
  };
}

export function heroTranscript(): unknown[] {
  return [
    {
      id: "msg_hero_user_1",
      role: "user",
      parts: [
        {
          type: "text",
          text: "Support volume doubled this week and nobody knows why. Have a look and give me the short version.",
        },
      ],
    },
    {
      id: "msg_hero_assistant_1",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "Let me read the tickets themselves rather than the summary dashboard — the tags lag by a day.",
        },
        call(
          ZENDESK,
          "call_hero_tickets",
          { query: "created>2026-07-27", group: "Support" },
          {
            content: [
              {
                type: "text",
                text: "412 tickets (prev. week: 197). Top terms: “invoice” 168, “VAT” 141, “address” 96.",
              },
            ],
          },
        ),
        call(
          "search_threads",
          "call_hero_threads",
          { query: "invoice VAT billing address" },
          {
            ok: true,
            matches: 3,
            threads: ["Billing address migration", "EU VAT rollout", "Invoice template refresh"],
          },
        ),
        {
          type: "text",
          text: [
            "It's one cause, not a wave. The EU VAT rollout on **Monday** started requiring a",
            "billing country on invoices, but accounts created before March have no country",
            "on file — so their invoice renders without VAT and the customer writes in.",
            "",
            "- **338 of 412** tickets are the same missing-country invoice",
            "- All from accounts created before 2026-03-14",
            "- Nothing is broken for anyone who signed up after that",
            "",
            "It reads as a support spike; it's a backfill we skipped.",
          ].join("\n"),
        },
      ],
    },
    {
      id: "msg_hero_user_2",
      role: "user",
      parts: [
        {
          type: "text",
          text: "Draft the customer note and get it in front of me Monday morning, not now.",
        },
      ],
    },
    {
      id: "msg_hero_assistant_2",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "Drafted, filed the backfill so it doesn't get lost, and scheduled the reminder.",
        },
        call(
          MARKDUMP,
          "call_hero_draft",
          { filename: "/drafts/2026-08-invoice-vat-note.md", mode: "create" },
          { content: [{ type: "text", text: "Wrote /drafts/2026-08-invoice-vat-note.md (1.2 kB)" }] },
        ),
        call(
          LINEAR,
          "call_hero_linear",
          { title: "Backfill billing country for pre-March accounts", team: "Billing" },
          { content: [{ type: "text", text: "Created BIL-207" }] },
        ),
        call(
          "create_automaton",
          "call_hero_automaton",
          {
            name: "Monday: invoice note review",
            schedule: { kind: "weekly", day: "monday", hour: 9, minute: 0 },
            timezone: "Europe/Berlin",
          },
          { ok: true, id: "atm_invoice_note", nextDueAt: "Mon 09:00 CET" },
        ),
        {
          type: "text",
          text: "The draft opens here Monday at 9:00 with the ticket count refreshed, so you're approving current numbers rather than today's.",
        },
      ],
    },
  ];
}
