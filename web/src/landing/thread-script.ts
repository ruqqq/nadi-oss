import type { UIMessage } from "ai";

// The hero transcript, fed to the real chat components rather than a drawing of
// them.
//
// The page's thesis is that one conversation does the whole job, so the data is
// built to make that literally true: this is ONE thread, not a gallery of them.
// It starts as data work, becomes code running on a real machine, becomes work
// that runs on a schedule — and the last move has no question above it at all,
// because by then the thread is working without you. Split this into separate
// threads, or one per capability, and the hero starts arguing the opposite of
// the page.
//
// The second, quieter claim is "the agent isn't the model": within a move, every
// model runs the SAME tools, and only the closing text changes. If you find
// yourself varying a move's tools per model, the hero has started lying.

/** The provider Nadi leads with. Featured in the hero and flagged in the list. */
export const FEATURED_PROVIDER = "OpenCode Go";

export type HeroModel = {
  /** Provider label, as it appears in Settings → Providers. */
  provider: string;
  /** The model id, shown raw in the thread badge exactly like the real app. */
  model: string;
  /** What it costs you, and to whom. */
  note: string;
};

// One chip per *model*, never two chips on the same one: the strip's claim is
// "pick a model, the answer changes", and a duplicate id would answer itself.
// So the model Nadi recommends appears once, under the provider it leads with.
export const HERO_MODELS: HeroModel[] = [
  { provider: "OpenCode Go", model: "deepseek-v4-flash", note: "your OpenCode Go key" },
  { provider: "Anthropic", model: "claude-sonnet-4-6", note: "your Anthropic key" },
  { provider: "OpenAI", model: "gpt-5.4-mini", note: "your OpenAI key" },
  {
    provider: "Cloudflare Workers AI",
    model: "@cf/moonshotai/kimi-k2.7-code",
    note: "no key, runs on Cloudflare",
  },
];

let seq = 0;
const tool = (name: string, input: unknown, output: unknown) => {
  seq += 1;
  return [
    { type: "step-start" },
    {
      type: `tool-${name}`,
      toolCallId: `landing-${seq}`,
      state: "output-available",
      input,
      output,
    },
  ];
};

export type HeroMove = {
  id: string;
  /**
   * How much later this move happened, shown on the thread's spine. The seams in
   * this thread are made of time, not of products — that is the argument, so it
   * is the only divider the transcript gets.
   */
  since: string | null;
  /** What you asked. Null on the move the thread takes on its own. */
  ask: string | null;
  /** The fixed tool strip. Identical for every model, by construction. */
  tools: unknown[];
  /** How each model closes the move, keyed by model id. Same facts, different voice. */
  answers: Record<string, string>;
};

export const HERO_MOVES: HeroMove[] = [
  // Data first: the move a non-engineer can see themselves in, and it carries the
  // hardest thing to believe — agents working in parallel, code written and run
  // on your behalf that you never have to look at.
  {
    id: "data",
    since: null,
    ask: "Q3 sales for APAC, EMEA and the US are attached. What actually changed, and is anything worth worrying about?",
    tools: [
      ...tool(
        "spawn_subagent",
        { label: "APAC", task: "Load apac_q3.csv. Churn, ARPU, logo movement vs Q2." },
        { runId: "sa_01", status: "running" },
      ),
      ...tool(
        "spawn_subagent",
        { label: "EMEA", task: "Load emea_q3.csv. Churn, ARPU, logo movement vs Q2." },
        { runId: "sa_02", status: "running" },
      ),
      ...tool(
        "spawn_subagent",
        { label: "US", task: "Load us_q3.csv. Churn, ARPU, logo movement vs Q2." },
        { runId: "sa_03", status: "running" },
      ),
      ...tool("check_subagents", {}, { done: 3, running: 0 }),
      ...tool(
        "exec",
        { command: "python combine.py --regions apac emea us", cwd: "/workspace" },
        { exitCode: 0, stdout: "churn ↑ 1.8pp (EMEA) · ARPU ↑ $4.10 · enterprise ↓ 3 logos" },
      ),
      ...tool(
        "exec_download_file",
        { path: "/workspace/churn_by_segment.png" },
        { attachmentId: "att_9f31", name: "churn_by_segment.png" },
      ),
    ],
    answers: {
      "deepseek-v4-flash":
        "The headline masks the story: **churn +1.8pp**, concentrated entirely in EMEA enterprise (3 logos gone). ARPU is up $4.10, so smaller accounts are spending more while your best customers leave. Worth worrying about. I ran a region per agent in parallel, then combined. Chart attached.",
      "claude-sonnet-4-6":
        "The headline is good and the detail isn't. ARPU is up $4.10, but **churn rose 1.8 percentage points**, and it isn't spread evenly: it's EMEA, and it's enterprise, where three logos left. Smaller accounts are covering for departing large ones. That's what I'd worry about. I read each region in parallel and combined them; chart attached.",
      "gpt-5.4-mini":
        "Up on the surface, weak underneath: **churn +1.8pp**, all EMEA enterprise (3 logos lost). ARPU +$4.10, so smaller accounts are masking the loss. Yes, worth worrying about. One agent per region, then combined. Chart attached.",
      "@cf/moonshotai/kimi-k2.7-code":
        "ARPU is up $4.10 but **churn is up 1.8pp**, and all of it is EMEA enterprise, with 3 logos lost. Smaller accounts are papering over departing large ones. Ran a region per agent, then combined. Chart attached.",
    },
  },
  // Same thread, and now it is a coding tool — on a real machine, for minutes,
  // without holding the line open. Nobody opened a second product.
  {
    id: "code",
    since: "four minutes later",
    ask: "Does billing actually agree? The reconciler is in the billing repo, release/0.14.",
    tools: [
      ...tool(
        "exec",
        { command: "pnpm reconcile --quarter q3", cwd: "/workspace/billing" },
        { processId: "px_4f21c9a0", running: true },
      ),
      ...tool(
        "exec_watch",
        { processId: "px_4f21c9a0", label: "reconcile · release/0.14" },
        {
          outcome: "exited",
          exitCode: 0,
          durationMs: 372_000,
          stdout: "3 enterprise closures confirmed · EMEA · no billing drift",
        },
      ),
    ],
    answers: {
      "deepseek-v4-flash":
        "Confirmed. `pnpm reconcile` finished in 6m 12s, exit 0: **3 enterprise closures in EMEA, no billing drift**. So the 1.8pp is real churn, not an artefact. I watched the run instead of holding the thread open on it.",
      "claude-sonnet-4-6":
        "It does agree. The reconciler took 6m 12s and came back clean: three EMEA enterprise accounts genuinely closed, and no billing drift is manufacturing the number. So the 1.8pp is real. I let it run and watched for the exit rather than blocking on it.",
      "gpt-5.4-mini":
        "Yes. Reconcile ran 6m 12s, exit 0: 3 EMEA enterprise closures, no drift. The 1.8pp is real churn. Watched the process; didn't hold the line open.",
      "@cf/moonshotai/kimi-k2.7-code":
        "Billing agrees: 6m 12s, exit 0, 3 EMEA enterprise closures and no drift. The 1.8pp is real. I watched the process to its exit.",
    },
  },
  // Same thread again, and now it is a scheduler. Note what is NOT here: a second
  // product, a re-upload, a re-explanation of what churn means to you.
  {
    id: "schedule",
    since: "a minute later",
    ask: "Keep an eye on it. Every Monday at 8, and only tell me if churn moves.",
    tools: [
      ...tool(
        "create_automaton",
        {
          name: "Churn watch",
          prompt:
            "Recompute churn by region and segment. Report only if it moved more than half a point.",
          schedule: { kind: "weekly", weekday: "monday", hour: 8, minute: 0 },
          timezone: "Asia/Singapore",
          notifyMode: "needs-you",
        },
        { id: "aut_7c2", enabled: true, nextRunAt: "Monday, 08:00 +08" },
      ),
    ],
    answers: {
      "deepseek-v4-flash":
        "Done. **Churn watch**, Mondays 08:00 (+08), first run next week. It keeps this thread's context, so nothing to re-explain, and it only reaches you if churn moves by more than half a point.",
      "claude-sonnet-4-6":
        "Set up. **Churn watch** runs every Monday at 08:00 Singapore time, starting next week. It remembers what we established here, so you won't have to explain it again, and it stays quiet unless churn moves more than half a point.",
      "gpt-5.4-mini":
        "Created. **Churn watch**, Mondays 08:00 (+08), first run next week. Keeps this context, and only pings you if churn moves >0.5pp.",
      "@cf/moonshotai/kimi-k2.7-code":
        "Saved: **Churn watch**, Mondays 08:00 (+08) from next week. It carries this thread's context and only notifies you if churn moves more than half a point.",
    },
  },
  // The move with no question above it. The thread came back on its own, into the
  // same conversation, knowing what it already knew. This is the whole page.
  {
    id: "monday",
    since: "the following Monday, 08:00",
    ask: null,
    tools: [
      ...tool(
        "exec",
        { command: "python churn.py --since last-week", cwd: "/workspace" },
        { exitCode: 0, stdout: "churn ↑ 2.3pp (EMEA) · +0.5pp week over week" },
      ),
    ],
    answers: {
      "deepseek-v4-flash":
        "Churn moved: **2.3pp**, up half a point week over week, still concentrated in EMEA enterprise. Flagging it because you asked to be told when it moves.",
      "claude-sonnet-4-6":
        "It moved, so I'm telling you: churn is **2.3pp**, half a point up on last week, and it's still EMEA enterprise. Same pattern, getting worse.",
      "gpt-5.4-mini":
        "Churn moved: **2.3pp**, +0.5pp week over week, still EMEA enterprise. Telling you as asked.",
      "@cf/moonshotai/kimi-k2.7-code":
        "Churn is **2.3pp**, up half a point on last week, still EMEA enterprise. You asked to be told when it moved.",
    },
  },
];

export function askMessage(move: HeroMove): UIMessage | null {
  if (move.ask === null) return null;
  return {
    id: `landing-ask-${move.id}`,
    role: "user",
    parts: [{ type: "text", text: move.ask }],
  } as unknown as UIMessage;
}

/** The assistant turn: one fixed tool strip per move, one swapped answer. */
export function answerMessage(move: HeroMove, model: HeroModel): UIMessage {
  return {
    id: `landing-answer-${move.id}-${model.model}`,
    role: "assistant",
    parts: [...move.tools, { type: "text", text: move.answers[model.model] ?? "" }],
  } as unknown as UIMessage;
}
