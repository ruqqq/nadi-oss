/**
 * Component-state harness (preview.html only, never shipped).
 *
 * Scope is deliberately narrow: transient states a backend mock cannot drive —
 * a failed upload, a permission prompt, a half-dragged sheet, an unreachable
 * history. Data-driven screens and flows belong in the mocked app
 * (`mock.html?scenario=…`, via `pnpm run web:mock`), which runs the real shell,
 * routing, and components against MSW instead of static fixtures.
 */
import { type CSSProperties, type ReactNode, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { IconContext } from "@phosphor-icons/react";
import "./fonts";
import "./index.css";

import { ProjectPicker } from "@/components/projects/ProjectPicker";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { StaleBundleNotice } from "@/components/StaleBundleNotice";
import { RootErrorBoundary } from "@/components/RootErrorBoundary";
import type { ProjectSummary } from "@/projects-api";

import { Conversation, ConversationContent } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { Loader } from "@/components/ai-elements/loader";
import { Composer } from "@/components/chat/Composer";
import { RecordingBar } from "@/components/chat/RecordingBar";
import { MessageRow } from "@/components/chat/MessageRow";
import { Check, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { AppToaster } from "@/components/ui/sonner";
import { BrandMark } from "@/components/BrandMark";
import { useLeftEdgeDrawerDrag } from "@/lib/use-edge-swipe";
import { Landing } from "@/landing/Landing";
import type { FileUIPart, ToolUIPart, UIMessage } from "ai";
import { ToolGroup } from "@/components/chat/ToolGroup";
import { CompletionGroup } from "@/components/chat/CompletionGroup";
import { ThreadHistoryUnavailable } from "@/components/ThreadHistoryErrorBoundary";
import { ThreadNavButton } from "@/components/chat/ThreadNavButton";
import { OfflineProvider } from "@/lib/use-offline";

// Mock multi-step assistant turn with step-start boundaries between tool calls
// (exactly how the AI SDK streams them) so the grouped "Dispatch strip" renders.
const groupedToolServers = [{ id: "s1", name: "Markdump" }];
let toolSeq = 0;
const tool = (name: string, input: unknown, output: unknown, errorText?: string) => {
  toolSeq += 1;
  return [
    { type: "step-start" },
    {
      type: `tool-tool_s1_${name}`,
      toolCallId: `call-${toolSeq}`,
      state: errorText ? "output-error" : "output-available",
      input,
      ...(errorText ? { errorText } : { output }),
    },
  ];
};
// Repeated read/edit on one server + enough rows to scroll, mirroring a real turn.
const groupedMessage = {
  id: "preview-grouped",
  role: "assistant",
  parts: [
    { type: "text", text: "Reorganized the backlog into per-ticket files:" },
    ...tool(
      "read",
      { filename: "projects/nadi/backlog/index.md", lines: { start: 1, end: 25 } },
      {
        content: "# Nadi Backlog…",
      },
    ),
    ...tool("edit", { filename: "open/strip.md", patch: "+ Strip variant" }, { ok: true }),
    ...tool("edit", { filename: "open/drafts.md", patch: "+ DO drafts" }, { ok: true }),
    ...tool("edit", { filename: "open/altenter.md", patch: "+ alias" }, { ok: true }),
    ...tool("read", { filename: "projects/nadi/roadmap.md" }, { content: "# Roadmap…" }),
    ...tool("read", { filename: "projects/nadi/index.md" }, { content: "# Nadi…" }),
    ...tool("edit", { filename: "index.md", patch: "+ links" }, { ok: true }),
    ...tool("read", { filename: "open/memory.md" }, null, "ENOENT: file not found"),
    ...tool("edit", { filename: "log.md", patch: "+ entry" }, { ok: true }),
  ],
} as unknown as UIMessage;

const assistantMd = `Here's the plan:

1. Build the **staging** artifact
2. Run smoke tests
3. Pause for your sign-off before anything destructive

Details are in [the runbook](https://example.com/runbook), or browse
https://example.com/deploys directly.

\`\`\`ts
await deploy({ env: "staging" });
\`\`\``;

function ToggleTheme() {
  return (
    <button
      type="button"
      className="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm"
      onClick={() => document.documentElement.classList.toggle("dark")}
    >
      Toggle theme
    </button>
  );
}

function Phone() {
  const flat = new URLSearchParams(location.search).has("flat");
  const body = (
    <>
      <Message from="user">
        <MessageContent>
          <MessageResponse>Deploy the staging build.</MessageResponse>
        </MessageContent>
      </Message>

      <Message from="assistant">
        <MessageContent>
          <MessageResponse>{assistantMd}</MessageResponse>

          <Tool defaultOpen>
            <ToolHeader title="fetch_build" type="tool-fetch_build" state="output-available" />
            <ToolContent>
              <ToolInput input={{ env: "staging" }} />
              <ToolOutput output={{ ok: true, artifact: "build-4821" }} errorText={undefined} />
            </ToolContent>
          </Tool>

          <Confirmation
            approval={{ id: "1" }}
            state="approval-requested"
            className="border-gate/50 bg-gate-bg"
          >
            <ConfirmationRequest>
              <div className="flex flex-col gap-0.5">
                <ConfirmationTitle className="font-medium text-gate">
                  Approval required
                </ConfirmationTitle>
                <span className="text-muted-foreground text-xs">
                  Nadi wants to run{" "}
                  <span className="font-mono text-foreground">delete_release</span>.
                </span>
              </div>
              <div className="mt-2 w-full min-w-0 overflow-hidden rounded-md bg-muted/50">
                <CodeBlock
                  code={JSON.stringify(
                    {
                      name: "Daily 8am Briefing",
                      prompt:
                        "Create a concise daily 8am briefing covering my calendar, overnight messages, and open tasks.",
                      timezone: "Asia/Singapore",
                      schedule: { kind: "daily", hour: 8, minute: 0 },
                      projectId: null,
                      notifyMode: "all",
                      enabled: true,
                    },
                    null,
                    2,
                  )}
                  language="json"
                />
              </div>
              <ConfirmationActions className="mt-3">
                <ConfirmationAction
                  variant="outline"
                  className="gap-1.5 border-reject/50 text-reject hover:bg-reject/10 hover:text-reject"
                >
                  <X />
                  Reject
                </ConfirmationAction>
                <ConfirmationAction className="gap-1.5 bg-approve text-approve-foreground hover:bg-approve/90">
                  <Check />
                  Approve
                </ConfirmationAction>
              </ConfirmationActions>
            </ConfirmationRequest>
          </Confirmation>

          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader />
            <span>Responding…</span>
          </div>
        </MessageContent>
      </Message>

      {/* Grouped tool calls → the Dispatch strip (tap to open the inspector). */}
      <MessageRow
        message={groupedMessage}
        servers={groupedToolServers}
        addToolApprovalResponse={() => undefined}
        busy={false}
      />
    </>
  );

  return (
    <div
      className={
        "flex w-[380px] flex-col overflow-hidden rounded-[28px] border border-border bg-background shadow-2xl " +
        (flat ? "" : "h-[760px]")
      }
    >
      <header className="flex items-center justify-between border-border border-b bg-card px-4 py-3">
        <span className="font-display font-semibold text-lg">nadi</span>
        <span className="size-2 rounded-full bg-approve" />
      </header>

      {flat ? (
        <div className="flex flex-col gap-8 p-4">{body}</div>
      ) : (
        <Conversation className="flex-1">
          <ConversationContent>{body}</ConversationContent>
        </Conversation>
      )}

      <Composer onSend={() => undefined} disabled={false} />
    </div>
  );
}

/**
 * The real drag hook against a real Sheet (screen=edge-swipe), so the gesture
 * and the CSS that moves the rail are both exercised — not a stub that would
 * agree with whatever the hook happens to do.
 */
const PREVIEW_RAIL_WIDTH_PX = 288;

function EdgeSwipePreview() {
  const [open, setOpen] = useState(false);
  useLeftEdgeDrawerDrag({
    enabled: true,
    isOpen: open,
    widthPx: PREVIEW_RAIL_WIDTH_PX,
    onOpenChange: setOpen,
  });
  return (
    <div className="min-h-screen bg-background p-6">
      <p data-testid="rail-state" className="font-mono text-sm">
        {open ? "rail:open" : "rail:closed"}
      </p>
      <p className="mt-2 text-muted-foreground text-sm">
        Drag in from the left edge — the rail should follow your finger.
      </p>
      <div className="mt-4 h-[200vh] rounded-md border border-border border-dashed" />

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          data-rail=""
          style={{ "--rail-width": `${PREVIEW_RAIL_WIDTH_PX}px` } as CSSProperties}
          className="w-72 bg-card p-0"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Threads</SheetTitle>
          </SheetHeader>
          <div className="p-4 font-medium text-sm">Threads</div>
          {/* Rows no longer own a swipe of their own, so a left swipe anywhere
              in the rail — including here — closes it. */}
          <div className="mx-2 rounded-md border border-border p-3 text-sm">A thread row</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ── Attachment row + tool-call overflow (screen=attachment-overflow) ───────
// The two regressions this screen pins: composer chips must scroll on their own
// row instead of painting over the model picker, and a tool-call header whose
// title is a raw command must truncate instead of shoving the badge off-row.
function AttachmentOverflowPreview() {
  const modelOnly = (
    <span className="rounded-md border border-border bg-card px-2 py-1 font-mono text-muted-foreground text-xs">
      deepseek-v4-flash
    </span>
  );
  const file = (filename: string): FileUIPart => ({
    type: "file",
    mediaType: "application/pdf",
    filename,
    url: "",
  });
  const execPart = (command: string): ToolUIPart =>
    ({
      type: "tool-exec",
      toolCallId: command.slice(0, 12),
      state: "output-available",
      input: { command },
      output: { exitCode: 0 },
    }) as unknown as ToolUIPart;
  const wget =
    // A presigned URL, only ever rendered — the point of the fixture is that it
    // is long enough to exercise wrapping. Values are fake on purpose.
    'wget -q -O /tmp/receipt.jpg "https://example-account.r2.cloudflarestorage.com/attachments/default/thr_d1549058-0220-4fff-bc6c-907bc74698bb2.jpg?X-Amz-Expires=518400&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=EXAMPLEACCESSKEYID0000000000000"';
  const panel = (title: string, children: ReactNode) => (
    <div className="w-full max-w-2xl space-y-2">
      <h2 className="font-medium text-foreground text-sm">{title}</h2>
      <div className="flex flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
        {children}
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen flex-col items-center gap-6 bg-muted/30 p-4 sm:p-8">
      <ToggleTheme />

      {panel(
        "Composer — one long filename (was overlapping the model picker)",
        <Composer
          onSend={() => undefined}
          disabled={false}
          previewFiles={[file("Quarterly Report 2026.pdf")]}
          footerTrailing={modelOnly}
        />,
      )}

      {panel(
        "Composer — six attachments (row scrolls, right edge fades)",
        <Composer
          onSend={() => undefined}
          disabled={false}
          previewFiles={[
            file("Quarterly Report 2026.pdf"),
            file("receipt-2026-07-09.jpg"),
            file("q3-forecast.xlsx"),
            file("an-extremely-long-attachment-filename-that-must-truncate.pdf"),
            file("notes.md"),
            file("architecture-diagram.png"),
          ]}
          footerTrailing={modelOnly}
        />,
      )}

      {panel(
        "Composer — no attachments (row absent, height unchanged)",
        <Composer onSend={() => undefined} disabled={false} footerTrailing={modelOnly} />,
      )}

      <div className="w-full max-w-2xl space-y-2">
        <h2 className="font-medium text-foreground text-sm">
          Tool calls — long command truncates, badge survives
        </h2>
        <ToolGroup
          servers={[]}
          items={[
            { key: "a", part: execPart(wget) },
            { key: "b", part: execPart("tesseract /tmp/receipt.jpg /tmp/receipt-text 2>&1") },
          ]}
        />
      </div>
    </div>
  );
}

// ── Thread history error, OFFLINE copy only (screen=history-error) ─────────
// The online copy and both header escapes are reachable in the mocked app now
// (`mock.html?scenario=history-error`: thr_001 from the list gives the rail
// toggle, thr_021 opened from the Nightly digest's run gives the Back arrow).
// What stays here is the offline wording, which is gated on `useOffline()` —
// the app derives that from a bootstrap probe failing, so no seeded scenario
// can produce it while MSW is answering every request.
function HistoryErrorPreview() {
  const header = (nav: ReactNode) => (
    <div className="flex h-14 shrink-0 items-center gap-2 border-border border-b bg-card px-3 text-sm">
      {nav}
      <div className="flex min-w-0 flex-1 items-baseline gap-2 text-muted-foreground">
        <span className="truncate text-foreground">Daily Reflections Setup</span>
        <span className="shrink-0 font-mono text-xs">thr_1a2b3c</span>
      </div>
    </div>
  );
  const railNav = (
    <ThreadNavButton backTo={null} onBack={() => undefined} onToggleThreads={() => undefined} />
  );
  return (
    <div className="flex min-h-screen flex-col items-center gap-6 bg-muted/30 p-4 sm:p-8">
      <ToggleTheme />
      <div className="w-full max-w-2xl space-y-2">
        <h2 className="font-medium text-foreground text-sm">
          Offline · opened from the list → rail toggle
        </h2>
        <div className="flex h-[340px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
          <OfflineProvider reachability="unreachable">
            <ThreadHistoryUnavailable header={header(railNav)} onRetry={() => undefined} />
          </OfflineProvider>
        </div>
      </div>
    </div>
  );
}

// ── Stale-bundle recovery states (screen=stale-bundle) ─────────────────────
// Unreachable in the mocked app: both states need a chunk of the running build
// to be missing, i.e. a deploy under an open tab. MSW serves whatever the
// current build asks for, so nothing there can fail this way.
function StaleBundlePreview() {
  const header = (
    <div className="flex h-14 shrink-0 items-center gap-2 border-border border-b bg-card px-3 text-sm">
      <ThreadNavButton backTo={null} onBack={() => undefined} onToggleThreads={() => undefined} />
      <div className="flex min-w-0 flex-1 items-baseline gap-2 text-muted-foreground">
        <span className="truncate text-foreground">Daily Reflections Setup</span>
        <span className="shrink-0 font-mono text-xs">thr_1a2b3c</span>
      </div>
    </div>
  );
  return (
    <div className="flex min-h-screen flex-col items-center gap-6 bg-muted/30 p-4 sm:p-8">
      <ToggleTheme />
      <div className="w-full max-w-2xl space-y-2">
        <h2 className="font-medium text-foreground text-sm">
          Chunk gone, inside a thread (was: “Couldn’t load this conversation”)
        </h2>
        <div className="flex h-[340px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
          <StaleBundleNotice header={header} />
        </div>
      </div>
      <div className="w-full max-w-2xl space-y-2">
        <h2 className="font-medium text-foreground text-sm">Chunk gone, full screen (root)</h2>
        <div className="flex h-[340px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
          <StaleBundleNotice />
        </div>
      </div>
      <div className="w-full max-w-2xl space-y-2">
        <h2 className="font-medium text-foreground text-sm">
          A real crash (no auto-reload — that would loop)
        </h2>
        {/* No fixed height: this fallback is `min-h-dvh` because at the root it
            owns the whole viewport, and a short box would push it out of view. */}
        <div className="flex flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
          <RootErrorBoundary>
            <CrashOnMount />
          </RootErrorBoundary>
        </div>
      </div>
    </div>
  );
}

function CrashOnMount(): never {
  throw new Error("Cannot read properties of undefined (reading 'map')");
}

// ── Tool cards — Direction A activity lines (screen=tool-cards) ────────────
// Drives the real MessageRow so the standalone/grouping logic runs end-to-end:
// the "important few" (web_search, apply_patch, exec, write_file, spawn_subagent)
// each split out to a rich two-line card; minor tools coalesce to a one-line
// "Ran N tools" run; a lone minor tool stays a single line.
function ToolCardsPreview() {
  let seq = 0;
  const t = (name: string, input: unknown, output?: unknown, errorText?: string) => {
    seq += 1;
    return [
      { type: "step-start" },
      {
        type: `tool-${name}`,
        toolCallId: `c${seq}`,
        state: errorText
          ? "output-error"
          : output === undefined
            ? "input-available"
            : "output-available",
        input,
        ...(errorText ? { errorText } : { output }),
      },
    ];
  };
  const patch = [
    "*** Begin Patch",
    "*** Update File: web/src/next.config.ts",
    "@@",
    " export default {",
    "-  cacheHandler: undefined,",
    "+  cacheHandler: './cache.ts',",
    "+  experimental: { staleTimes: { dynamic: 30 } },",
    "*** End Patch",
  ].join("\n");
  const message = {
    id: "preview-tool-cards",
    role: "assistant",
    parts: [
      { type: "text", text: "On it — pulling the current docs first." },
      ...t(
        "web_search",
        { query: "react 19 cache() dedupe 19.2" },
        {
          results: [
            { url: "https://react.dev/reference/react/cache" },
            { url: "https://github.com/facebook/react" },
            { url: "https://web.dev/articles/react-cache" },
          ],
        },
      ),
      ...t("web_fetch", { url: "https://react.dev/reference/react/cache" }, { preview: "…" }),
      ...t("read_file", { path: "next.config.ts" }, { ok: true, content: "…" }),
      ...t("read_file", { path: "package.json" }, { ok: true, content: "…" }),
      { type: "text", text: "The guidance changed in 19.2. Applying the config change:" },
      ...t("apply_patch", { patch }, { ok: true, operations: 1, written: 1, deleted: 0 }),
      ...t("exec", { command: "pnpm build", label: "Build" }),
      ...t("exec", { command: "pnpm test", label: "Run tests" }, { status: "exited", exitCode: 0 }),
      ...t("exec", { command: "pnpm typecheck" }, { status: "failed", exitCode: 1 }),
      ...t("write_file", { path: "web/src/cache.ts", content: "…" }, { ok: true, bytesWritten: 2048 }),
      ...t(
        "spawn_subagent",
        { task: "Audit the migrations for the cache change" },
        { runId: "r1", status: "started" },
      ),
      ...t("activate_skill", { name: "brainstorming" }, { ok: true }),
      { type: "text", text: "Done — config patched, tests green (typecheck needs a follow-up)." },
    ],
  } as unknown as UIMessage;

  return (
    <div className="flex min-h-screen flex-col items-center gap-6 bg-muted/30 p-4 sm:p-8">
      <ToggleTheme />
      <div className="w-full max-w-2xl rounded-2xl border border-border bg-background p-4 shadow-sm">
        <Message from="user">
          <MessageContent>
            <MessageResponse>
              Research the newest React 19 caching guidance and patch our config.
            </MessageResponse>
          </MessageContent>
        </Message>
        <MessageRow
          message={message}
          servers={[]}
          addToolApprovalResponse={() => undefined}
          busy={false}
        />
        {/* A collapsed run of background results shares the same activity-line look. */}
        <CompletionGroup
          runsById={{}}
          run={[
            watcherCard({ title: "build", command: "pnpm build", processId: "p1", outcome: "exited", exitCode: 0 }),
            watcherCard({ title: "tests", command: "pnpm test", processId: "p2", outcome: "exited", exitCode: 1, outputTail: "3 failing\n" }),
            watcherCard({ title: "slack digest", command: "node read.js", processId: "p3", outcome: "exited", exitCode: 0 }),
          ]}
        />
      </div>
    </div>
  );
}

function watcherCard(watcher: Record<string, unknown>): UIMessage {
  return {
    id: `sysrem_${watcher.processId as string}`,
    role: "user",
    parts: [{ type: "text", text: "<system-reminder>\nbody\n</system-reminder>" }],
    metadata: { nadiKind: "watcher-completion", watcher },
  } as unknown as UIMessage;
}

// ── Toast placement (screen=toast) ──────────────────────────────────────────
// The AppToaster reads --composer-clearance (published by the composer) so a
// toast lands right above the composer, not over it — and falls back to plain
// bottom-center on composer-less screens. Fires one toast on load; the button
// fires more for stacking.
function ToastPreview() {
  useEffect(() => {
    toast("Nadi didn't hear anything, so the mic is off. Tap the mic to try again.");
  }, []);
  return (
    <div className="flex h-dvh flex-col bg-background">
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <ToggleTheme />
        <Button variant="outline" onClick={() => toast("Another toast, stacked above the first.")}>
          Fire toast
        </Button>
      </div>
      <Composer onSend={() => undefined} disabled={false} safeAreaBottom />
      <AppToaster />
    </div>
  );
}

const MOCK_PROJECTS: ProjectSummary[] = [
  {
    id: "p_nadi",
    workspaceId: "ws",
    name: "Nadi",
    description: "Cloudflare Worker + React SPA",
    customInstructions: "",
    defaultWorkbenchId: "env_staging",
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "p_mkt",
    workspaceId: "ws",
    name: "Marketing site",
    description: "Astro landing pages",
    customInstructions: "",
    defaultWorkbenchId: null,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "p_infra",
    workspaceId: "ws",
    name: "Infra & deploys",
    description: "",
    customInstructions: "",
    defaultWorkbenchId: null,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
  },
];

// ── Composer readiness states (screen=composer-states) ─────────────────────
// Verifies the three additions in one view: the bottom-pinned new-chat empty
// state, the reconnect/reload send-gate (textarea editable, actions disabled,
// footer hint), and the disabled skeleton shell — the pieces that must line up
// on both desktop and a narrow mobile footer.
function ComposerStatesPreview() {
  // Every composer footer is just the model badge — the project picker now lives
  // in the new-chat header, not the composer.
  const modelOnly = (
    <span className="rounded-md border border-border bg-card px-2 py-1 font-mono text-muted-foreground text-xs">
      gpt-5.4-mini
    </span>
  );
  const attach = { uploadAttachments: async () => [], attachmentAccept: "image/*" } as const;
  const panel = (title: string, children: ReactNode) => (
    <div className="w-full max-w-2xl space-y-2">
      <h2 className="font-medium text-foreground text-sm">{title}</h2>
      <div className="flex h-[300px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
        {children}
      </div>
    </div>
  );
  return (
    <div className="flex min-h-screen flex-col items-center gap-6 bg-muted/30 p-4 sm:p-8">
      <ToggleTheme />

      {panel(
        "New chat — bottom-grounded empty state (project tab docks on the composer)",
        <>
          <div className="flex min-h-0 flex-1 flex-col items-center justify-end gap-4 px-4 pb-2">
            <h1 className="text-center font-display font-semibold text-2xl text-foreground">
              What can Nadi help you with?
            </h1>
          </div>
          <div className="mx-3 -mb-1 flex">
            <ProjectPicker
              value="none"
              projects={MOCK_PROJECTS}
              onValueChange={() => undefined}
              onCreateProject={async () => undefined}
              compact
            />
          </div>
          <Composer
            onSend={() => undefined}
            disabled={false}
            voiceEnabled
            {...attach}
            safeAreaBottom
            footerTrailing={modelOnly}
          />
        </>,
      )}

      {panel(
        "Active thread — reconnecting (send gated, textarea editable)",
        <>
          <div className="flex min-h-0 flex-1 items-end p-4 text-muted-foreground text-sm">
            …conversation…
          </div>
          <Composer
            onSend={() => undefined}
            onStop={() => undefined}
            disabled={false}
            sendBlocked
            statusHint="Reconnecting…"
            status="streaming"
            {...attach}
            safeAreaBottom
            footerTrailing={modelOnly}
          />
        </>,
      )}

      {panel(
        "Active thread — reloading history",
        <>
          <div className="flex min-h-0 flex-1 items-end p-4 text-muted-foreground text-sm">
            …conversation…
          </div>
          <Composer
            onSend={() => undefined}
            disabled={false}
            sendBlocked
            statusHint="Reloading…"
            {...attach}
            safeAreaBottom
            footerTrailing={modelOnly}
          />
        </>,
      )}

      {panel(
        "Initial load — disabled skeleton shell",
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
            <div className="h-3 w-2/3 rounded bg-muted" />
            <div className="h-3 w-1/2 rounded bg-muted" />
          </div>
          <Composer
            onSend={() => undefined}
            disabled
            sendBlocked
            statusHint="Connecting…"
            {...attach}
            safeAreaBottom
            footerTrailing={modelOnly}
          />
        </>,
      )}

      {/* The toolbar states, side by side: every button in the row must be the
          same size and speak the same visual language (ghost secondary, exactly
          one filled primary), idle or recording. */}
      {panel(
        "Active thread — streaming (send becomes stop)",
        <>
          <div className="flex min-h-0 flex-1 items-end p-4 text-muted-foreground text-sm">
            …streaming…
          </div>
          <Composer
            onSend={() => undefined}
            onStop={() => undefined}
            disabled={false}
            status="streaming"
            voiceEnabled
            {...attach}
            safeAreaBottom
            footerTrailing={modelOnly}
          />
        </>,
      )}

      {panel(
        "Active thread — steering available (split send: queue + caret)",
        <>
          <div className="flex min-h-0 flex-1 items-end p-4 text-muted-foreground text-sm">
            …streaming, with typed text…
          </div>
          <Composer
            onSend={() => undefined}
            onStop={() => undefined}
            disabled={false}
            status="streaming"
            allowSteer
            allowBusySend
            voiceEnabled
            defaultValue="also check the migration"
            {...attach}
            safeAreaBottom
            footerTrailing={modelOnly}
          />
        </>,
      )}

      {panel(
        "Dictating — the recording bar replaces the toolbar",
        <>
          <div className="flex min-h-0 flex-1 items-end p-4 text-muted-foreground text-sm">
            …conversation…
          </div>
          <div className="m-3 rounded-xl border border-border bg-card">
            <div className="px-3 pt-3 pb-1 text-muted-foreground text-sm">Message Nadi…</div>
            <div className="flex items-center gap-1 p-3 pt-1">
              <RecordingBar
                elapsedMs={8_000}
                audioLevel={0.6}
                interim="and then check the deploy"
                onCancel={() => undefined}
                onStop={() => undefined}
              />
            </div>
          </div>
        </>,
      )}
    </div>
  );
}

const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark") {
  // Seed storage so components using useTheme() resolve dark (their mount effect
  // would otherwise re-apply the stored/default light theme over a manual class).
  try {
    localStorage.setItem("nadi-theme", "dark");
  } catch {
    // ignore
  }
  document.documentElement.classList.add("dark");
}
const screen = params.get("screen");

// Data-driven screens and flows live in the mocked app (`mock.html?scenario=…`),
// which runs the real shell, routing, and components against MSW. What remains
// here is the set of transient component states no backend mock can drive:
//   composer-states, attachment-overflow, toast, edge-swipe, watcher-completion,
//   tool-cards, history-error (offline copy only), stale-bundle, landing, og.
// default → mock chat Phone.

// ── Watcher completion card (screen=watcher-completion) ────────────────────
// Every tone the transcript card can render, side by side, from real
// `watcher-completion` metadata. `fault` is the reaper's terminal — a failure,
// so it takes the `--reject` intent rather than the timeout's softer tone; both
// themes have to be looked at, since only the intent tokens flip with the theme.
function WatcherCompletionPreview() {
  const card = (watcher: Record<string, unknown>): UIMessage => ({
    id: `sysrem_${watcher.processId as string}`,
    role: "user",
    parts: [{ type: "text", text: "<system-reminder>\nbody\n</system-reminder>" }],
    metadata: { nadiKind: "watcher-completion", watcher },
  });
  return (
    <div className="flex min-h-screen flex-col gap-4 bg-background p-6">
      <ToggleTheme />
      <div className="mx-auto flex w-full max-w-xl flex-col">
        <CompletionGroup
          runsById={{}}
          run={[card({
            title: "build",
            command: "pnpm build",
            processId: "p1",
            outcome: "exited",
            exitCode: 0,
            outputTail: "compiled in 4.2s\n",
          })]}
        />
        <CompletionGroup
          runsById={{}}
          run={[card({
            title: "tests",
            command: "pnpm test",
            processId: "p2",
            outcome: "exited",
            exitCode: 1,
            outputTail: "3 failing\n",
          })]}
        />
        <CompletionGroup
          runsById={{}}
          run={[card({
            title: "slack digest",
            command: "node read.js",
            processId: "p3",
            outcome: "timeout",
            exitCode: null,
          })]}
        />
        <CompletionGroup
          runsById={{}}
          run={[card({
            title: "npm test",
            command: "npm test",
            processId: "p4",
            outcome: "stopped",
            exitCode: null,
          })]}
        />
        <CompletionGroup
          runsById={{}}
          run={[card({
            title: "read channels",
            command: "node read-channels.js",
            processId: "p5",
            outcome: "fault",
            reason: "no_liveness",
            exitCode: null,
          })]}
        />
        <CompletionGroup
          runsById={{}}
          run={[card({
            title: "index repo",
            command: "node index.js",
            processId: "p6",
            outcome: "fault",
            reason: "sandbox_reset",
            exitCode: null,
          })]}
        />
      </div>
    </div>
  );
}

/**
 * The 1200×630 link-unfurl card, rendered with the real tokens and typefaces so
 * it can't drift from the page it advertises. Screenshot it at that viewport and
 * write the result to web/public/og.png.
 */
function OgCard() {
  return (
    <div className="flex h-[630px] w-[1200px] flex-col justify-between bg-background p-16">
      <div className="flex items-center gap-3">
        <BrandMark className="size-10 rounded-[10px]" />
        <span className="font-display font-semibold text-3xl">nadi</span>
        <span className="rounded-full border border-border px-2.5 py-1 font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest">
          Beta
        </span>
      </div>

      <div className="flex flex-col gap-6">
        <p className="font-medium font-mono text-muted-foreground text-sm uppercase tracking-[0.2em]">
          On any model, on your own key
        </p>
        {/* The two lines are authored, not measured: each is nowrap so the break
            stays between "Your AI" and the noun no matter what the measure would
            do. Caps get tracking-normal — tracking-tight is set for lowercase and
            crowds them. */}
        <h1 className="font-display font-semibold leading-[0.98] tracking-tight">
          <span className="block whitespace-nowrap text-[72px] text-muted-foreground">Your AI</span>
          <span className="block whitespace-nowrap text-[150px] uppercase tracking-normal">
            coworker.
          </span>
        </h1>
      </div>

      <div className="flex items-center justify-between border-border border-t pt-6">
        {/* A sentence per line, so neither wraps to a one-word orphan. */}
        <p className="max-w-[52ch] text-lg text-muted-foreground">
          <span className="block">Delegate the work, schedule it to repeat.</span>
          <span className="block">It learns from every conversation.</span>
        </p>
        <span className="shrink-0 font-mono text-primary text-sm">nadiai.app</span>
      </div>
    </div>
  );
}

const node =
  screen === "landing" ? (
    <Landing onSignIn={() => undefined} signedIn={params.get("variant") === "signed-in"} />
  ) : screen === "og" ? (
    <OgCard />
  ) : screen === "edge-swipe" ? (
    <EdgeSwipePreview />
  ) : screen === "composer-states" ? (
    <ComposerStatesPreview />
  ) : screen === "toast" ? (
    <ToastPreview />
  ) : screen === "attachment-overflow" ? (
    <AttachmentOverflowPreview />
  ) : screen === "tool-cards" ? (
    <ToolCardsPreview />
  ) : screen === "history-error" ? (
    <HistoryErrorPreview />
  ) : screen === "stale-bundle" ? (
    <StaleBundlePreview />
  ) : screen === "watcher-completion" ? (
    <WatcherCompletionPreview />
  ) : (
    <div className="flex min-h-screen flex-col items-center gap-4 bg-muted/30 p-6">
      <ToggleTheme />
      <Phone />
    </div>
  );

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <IconContext.Provider value={{ weight: "bold", size: "1em" }}>{node}</IconContext.Provider>
  </StrictMode>,
);
