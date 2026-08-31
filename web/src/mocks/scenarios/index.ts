/**
 * Named seeds for the mocked app, resolved from `mock.html?scenario=<name>`.
 *
 * Each entry is a FACTORY, not a value: every reload (and every `seedStore`
 * call) must get its own mutable object graph, or mutations from one session
 * leak into the next.
 */

import type { AutomatonSummary } from "../../automata-api";
import type {
  FeedbackDiagnostics,
  FeedbackDraftView,
  FeedbackReportDetail,
  FeedbackReportFields,
} from "../../feedback-api";
import type { ProjectSummary } from "../../projects-api";
import type {
  AgentSettingsResponse,
  ProviderSettingsView,
  SettingsProvider,
} from "../../settings-api";
import type { ThreadSummary } from "../../threads-api";
import type { WorkbenchSummary } from "../../workbenches-api";
import type { MockArtifact, MockAttachment, MockFaults, MockStore } from "../store";
import { TOOL_RUN_THREAD_ID, TOOL_WRITE_THREAD_ID } from "../chat/tool-run-transcript";
import { MID_TURN_THREAD_ID } from "../chat/mid-turn-transcript";
import { HERO_THREAD_ID } from "../chat/hero-transcript";
import {
  ASSISTANT_ARTIFACTS_THREAD_ID,
  MOCK_ARTIFACT_ID,
  liveArtifactExpiresAt,
} from "../chat/assistant-artifact-transcript";
import { ASSISTANT_DOWNLOAD_THREAD_ID } from "../chat/assistant-download-transcript";

/** Fixed clock so screenshots are byte-stable across runs. 2026-07-08T00:00:00Z. */
const NOW = 1_752_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const WORKSPACE_ID = "ws_mock";
const AGENT_ID = "agent_mock";

const USER = {
  id: "user_mock",
  email: "mock@nadi.dev",
  name: "Mock User",
};

/** `ThreadSummary` has ~28 required fields; scenarios stay readable only if
 *  they name the two or three that matter and inherit the rest. */
export function makeThread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    threadId: "thr_mock",
    kind: "regular",
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    modelInputModalities: ["text", "image"],
    reasoningEffort: "medium",
    modelSupportsReasoning: true,
    runtime: "think",
    title: "Untitled thread",
    source: "manual",
    lastMessagePreview: "",
    archivedAt: null,
    readOnly: false,
    status: "active",
    projectId: null,
    projectName: null,
    workbenchId: null,
    workbenchName: null,
    resourceProfile: "small",
    automatonId: null,
    automatonName: null,
    automatonNotifyMode: null,
    outcomeDismissedAt: null,
    recentDismissedAt: null,
    repositorySnapshotCount: 0,
    lastContextTokens: null,
    lastContextWindow: null,
    lastCompactAfterTokens: null,
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    ...overrides,
  };
}

export function makeProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: "prj_mock",
    workspaceId: WORKSPACE_ID,
    name: "Untitled project",
    description: "",
    customInstructions: "",
    defaultWorkbenchId: null,
    archivedAt: null,
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - DAY,
    ...overrides,
  };
}

export function makeWorkbench(overrides: Partial<WorkbenchSummary> = {}): WorkbenchSummary {
  return {
    id: "wb_mock",
    workspaceId: WORKSPACE_ID,
    name: "Untitled workbench",
    description: "",
    setupScript: "",
    resourceProfile: "small",
    repositories: [],
    envVars: {},
    secretEnvNames: [],
    networkDomainAllowlist: "",
    archivedAt: null,
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - DAY,
    ...overrides,
  };
}

export function makeAutomaton(overrides: Partial<AutomatonSummary> = {}): AutomatonSummary {
  return {
    id: "atm_mock",
    workspaceId: WORKSPACE_ID,
    ownerUserId: USER.id,
    agentId: AGENT_ID,
    projectId: null,
    // Per-automaton workbench override (ffccbb16). Null = inherit the project
    // default, which is the common case.
    workbenchId: null,
    name: "Untitled automaton",
    prompt: "Summarize what changed today.",
    modelProvider: null,
    model: null,
    modelInputModalities: null,
    // `AutomatonSchedule`'s cron variant is `{kind:"cron", expr}` — NOT
    // `expression`. AutomataPanel calls `.trim()` on it unguarded, so the wrong
    // field name crashes the whole panel.
    scheduleJson: JSON.stringify({ kind: "daily", hour: 9, minute: 0 }),
    timezone: "Asia/Singapore",
    enabled: true,
    disabledReason: null,
    nextDueAt: NOW + HOUR,
    lastFiredAt: NOW - DAY,
    archivedAt: null,
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - DAY,
    notifyMode: "all",
    lastRun: null,
    ...overrides,
  };
}

/** Every provider the settings screen lists. `secretPresent` drives the
 *  "Configured" chip and `usable` drives model selection. */
const PROVIDER_SEEDS: Array<{
  provider: SettingsProvider;
  displayName: string;
  defaultSecretName: string;
  configured: boolean;
}> = [
  {
    provider: "anthropic",
    displayName: "Anthropic",
    defaultSecretName: "ANTHROPIC_API_KEY",
    configured: true,
  },
  {
    provider: "openai",
    displayName: "OpenAI",
    defaultSecretName: "OPENAI_API_KEY",
    configured: false,
  },
  {
    provider: "openrouter",
    displayName: "OpenRouter",
    defaultSecretName: "OPENROUTER_API_KEY",
    configured: false,
  },
  {
    provider: "workers-ai",
    displayName: "Workers AI",
    defaultSecretName: "",
    configured: true,
  },
  {
    provider: "openai-oauth",
    displayName: "OpenAI OAuth",
    defaultSecretName: "provider:openai-oauth",
    configured: true,
  },
  // Carries a real endpoint of its own AND an optional proxy route, so the
  // Proxy endpoint card is drivable in its empty state (openai-oauth seeds the
  // filled one).
  {
    provider: "opencode-zen",
    displayName: "OpenCode Zen",
    defaultSecretName: "provider:opencode-zen",
    configured: true,
  },
  // Configured and usable, but deliberately absent from the mock MODEL_CATALOGUE
  // — a self-hosted endpoint that serves no `/models` route. Its models can only
  // be registered by hand, which is the whole reason the add-model form exists.
  {
    provider: "openai-compatible",
    displayName: "OpenAI Compatible",
    defaultSecretName: "provider:openai-compatible",
    configured: true,
  },
];

export function makeProviderViews({ anyConfigured = true }: { anyConfigured?: boolean } = {}): ProviderSettingsView[] {
  return PROVIDER_SEEDS.map((seed) => {
    const configured = anyConfigured && seed.configured;
    return {
      provider: seed.provider,
      displayName: seed.displayName,
      defaultSecretName: seed.defaultSecretName,
      configuredSecretName: seed.defaultSecretName,
      secretPresent: configured,
      secretUpdatedAt: configured ? "2026-07-01T09:00:00.000Z" : null,
      previewAvailable: configured,
      endpointConfig: {
        // openai-compatible is only `usable` with a baseUrl, so it needs one to
        // reach the picker at all.
        baseUrl: !configured
          ? ""
          : seed.provider === "openai-compatible"
            ? "https://llm.internal.example.com/v1"
            : seed.provider === "opencode-zen"
              ? "https://opencode.ai/zen/v1"
              : "",
        // openai-oauth is only `usable` with a proxy route; Zen is left direct
        // so the empty state of the shared card is reachable too.
        proxyUrl:
          configured && seed.provider === "openai-oauth"
            ? "https://proxy.example.com/openai-oauth"
            : "",
        auth: "bearer",
        body: {},
      },
      usable: configured,
      // Three curation states are seeded so every picker path is drivable:
      // Anthropic curated to one model (short list + the "Current" group, since
      // the seeded thread's model isn't in it), Workers AI curated to zero (must
      // be hidden from the picker), and everything else uncurated.
      whitelistModels:
        seed.provider === "anthropic"
          ? [
              {
                id: "claude-opus-4-8",
                name: "Claude Opus 4.8",
                contextLength: 200_000,
                inputModalities: ["text", "image"],
                // Matches this model's entry in the mock catalogue. A curated
                // list is rendered from these records rather than the catalog,
                // so omitting it here would show the model as capability-unknown
                // in the one place the picker reads with zero requests.
                reasoning: true,
                source: "static",
              },
            ]
          : seed.provider === "workers-ai"
            ? []
            : null,
    };
  });
}

function makeSettings({ anyConfigured = true }: { anyConfigured?: boolean } = {}): AgentSettingsResponse {
  return {
    workspace: { id: WORKSPACE_ID, name: "Mock Workspace" },
    agent: {
      id: AGENT_ID,
      name: "Nadi",
      systemPrompt: "You are Nadi, a calm and precise engineering assistant.",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      reasoningEffort: "medium",
      // Matches the mock catalogue: this model reasons, so the composer offers
      // the thinking dial by default in every scenario.
      modelSupportsReasoning: true,
      modelInputModalities: ["text", "image"],
    },
    providers: makeProviderViews({ anyConfigured }),
  };
}

/** No injected failures. Scenarios that want one override the single field. */
function noFaults(): MockFaults {
  return {
    historyUnreachableThreadIds: [],
    messageSendFailsAfterMs: null,
    feedbackModelFails: false,
    feedbackRateLimitedRetryAfterSeconds: null,
  };
}

function emptyFeedback(): MockStore["feedback"] {
  return {
    thread: null,
    drafts: [],
    reports: [],
    seenReportIds: [],
    messages: [],
    transcriptsByReportId: {},
  };
}

function noFeatures(): MockStore["features"] {
  return { feedbackAdmin: false, backgroundWork: false, workbenchNetworkAllowlist: false };
}

/** Workspace override explicitly enables background work. */
function backgroundWorkEnabledStore(): MockStore {
  const base = defaultStore();
  return { ...base, features: { ...base.features, backgroundWork: true } };
}

function workbenchNetworkAllowlistStore(): MockStore {
  const base = defaultStore();
  return {
    ...base,
    features: { ...base.features, workbenchNetworkAllowlist: true },
  };
}

/**
 * Compute settings.
 *
 * The Cloudflare option in the provider combobox is gated on
 * `readiness.cloudflare.unsupported` containing `network_restrictions`, and the
 * server derives that verdict from the workspace's effective allowlist —
 * `@cloudflare/sandbox` has no network-policy API, so a restricted workspace
 * cannot run there. The two travel together, which is why they are set from one
 * flag here: an unrestricted workspace with a still-`unsupported` Cloudflare (or
 * the reverse) is a state the real server cannot produce.
 */
function makeSandbox({
  provider = "daytona",
  networkRestricted = true,
  cloudflareMissingConfig = [],
  operatorManagedCompute = false,
}: {
  provider?: "daytona" | "cloudflare";
  networkRestricted?: boolean;
  cloudflareMissingConfig?: string[];
  /** Cloud edition: an operator provisioned compute, so the read-only
   *  deployment panel is hidden. Defaults to the self-hosted view. */
  operatorManagedCompute?: boolean;
} = {}): MockStore["sandbox"] {
  const daytonaConfig = {
    kind: "daytona" as const,
    apiKeySecretName: "DAYTONA_API_KEY",
    apiUrl: null,
    target: "eu",
    profiles: {
      small: { kind: "snapshot" as const, value: "nadi-small" },
      medium: { kind: "snapshot" as const, value: "nadi-medium" },
    },
  };
  const allowedHosts = networkRestricted ? ["github.com", "registry.npmjs.org"] : null;
  const cloudflareUnsupported: "network_restrictions"[] = networkRestricted
    ? ["network_restrictions"]
    : [];
  return {
    workspace: {
      enabled: true,
      provider,
      providerConfig: provider === "cloudflare" ? { kind: "cloudflare" } : daytonaConfig,
      idleTimeoutMs: 15 * MINUTE,
      recoveryTtlMs: 6 * HOUR,
      maxProcessRuntimeMs: 10 * MINUTE,
      networkRestrictionEnabled: networkRestricted,
      networkDomainAllowlist: networkRestricted ? "github.com\nregistry.npmjs.org" : "",
      envVars: { NADI_ENV: "mock" },
    },
    agent: {
      enabled: null,
      idleTimeoutMs: null,
      maxProcessRuntimeMs: null,
      networkDomainAllowlist: null,
      envVars: null,
    },
    readiness: {
      daytona: { provider: "daytona", ready: true, missingConfig: [], unsupported: [] },
      cloudflare: {
        provider: "cloudflare",
        ready: cloudflareUnsupported.length === 0 && cloudflareMissingConfig.length === 0,
        missingConfig: cloudflareMissingConfig,
        unsupported: cloudflareUnsupported,
      },
      sprites: { provider: "sprites", ready: true, missingConfig: [], unsupported: [] },
    },
    operatorManagedCompute,
    daytonaMode: "byok",
    daytonaAvailable: true,
    daytonaSecretPresent: true,
    spritesMode: "system",
    spritesAvailable: false,
    spritesSecretPresent: false,
    // The mocked app stands in for a Cloudflare deployment, so the container
    // provider is selectable. It is OPTIONAL on the wire and absent means
    // available, so without this line the mock would still render the same
    // panel — set explicitly so a celld-shaped scenario is a one-word edit
    // rather than a rediscovery of which default applies.
    cloudflareAvailable: true,
    workspaceSecretEnvVars: [{ name: "GH_TOKEN", updatedAt: "2026-07-01T09:00:00.000Z" }],
    agentSecretEnvVars: [],
    effective: {
      enabled: true,
      value: { resourceProfile: "medium", allowedHosts },
    },
  };
}

/** Domains with no interesting empty-vs-rich distinction, or whose empty shape
 *  is the same object with empty collections. */
function baseExtras(): Pick<
  MockStore,
  | "invites"
  | "github"
  | "githubRepositories"
  | "notifications"
  | "webTools"
  | "privacy"
  | "sandbox"
  | "daytonaSystemAvailable"
  | "voice"
  | "preferences"
> {
  return {
    invites: {
      invites: [],
      quota: { used: 0, limit: 5 },
      isSuperuser: false,
      waitingList: [],
    },
    github: { configured: true, installations: [] },
    githubRepositories: [],
    notifications: {
      browserPushEnabled: false,
      pushPreviewEnabled: true,
      vapidPublicKey: "mock-vapid-public-key",
    },
    webTools: { exaSecretPresent: false, exaSecretUpdatedAt: null, webSearchEnabled: false },
    privacy: { workspaceId: WORKSPACE_ID, telemetryEnabled: true },
    sandbox: makeSandbox(),
    daytonaSystemAvailable: true,
    voice: { language: "en", supported: ["en", "es", "fr", "de", "ja"] },
    preferences: { showReasoning: true },
  };
}

function richExtras(): Pick<
  MockStore,
  | "skills"
  | "memories"
  | "mcpServers"
  | "mcpTools"
  | "mcpNeedsAuth"
  | "invites"
  | "github"
  | "githubRepositories"
  | "notifications"
  | "webTools"
  | "privacy"
  | "sandbox"
  | "daytonaSystemAvailable"
  | "voice"
  | "preferences"
> {
  return {
    ...baseExtras(),
    skills: [
      {
        id: "skl_swe",
        name: "software_engineering",
        description: "Plan, edit, and verify code changes in a sandbox checkout.",
        body: "# Software engineering\n\nCommit often. Push early. Open a draft PR.",
        enabled: true,
        createdAt: NOW - 20 * DAY,
        updatedAt: NOW - 2 * DAY,
        archivedAt: null,
      },
      {
        id: "skl_review",
        name: "code_review",
        description: "Review a diff for correctness and simplification.",
        body: "# Code review\n\nName the bug class, not just the line.",
        enabled: false,
        createdAt: NOW - 12 * DAY,
        updatedAt: NOW - 3 * DAY,
        archivedAt: null,
      },
      {
        id: "skl_old",
        name: "legacy_deploy",
        description: "Superseded by the GitHub Actions deploy workflow.",
        body: "# Legacy deploy",
        enabled: false,
        createdAt: NOW - 60 * DAY,
        updatedAt: NOW - 40 * DAY,
        archivedAt: NOW - 40 * DAY,
      },
    ],
    memories: [
      {
        id: "mem_1",
        title: "Prefers squash merges",
        kind: "preference",
        content: "Squash-merge every branch; the branch name carries no history.",
        sourceThreadId: "thr_001",
        createdAt: NOW - 9 * DAY,
        updatedAt: NOW - 9 * DAY,
        archivedAt: null,
      },
      {
        id: "mem_2",
        title: "Deploys go through GitHub Actions",
        kind: "workflow",
        content: "`pnpm run deploy` fails locally — dispatch deploy.yml instead.",
        sourceThreadId: null,
        createdAt: NOW - 5 * DAY,
        updatedAt: NOW - 5 * DAY,
        archivedAt: null,
      },
      {
        id: "mem_3",
        title: "Old staging URL",
        kind: "fact",
        content: "staging.nadi.dev was retired.",
        sourceThreadId: null,
        createdAt: NOW - 50 * DAY,
        updatedAt: NOW - 45 * DAY,
        archivedAt: NOW - 45 * DAY,
      },
    ],
    mcpServers: [
      {
        id: "mcp_docs",
        name: "Cloudflare Docs",
        url: "https://docs.mcp.cloudflare.com/sse",
        enabled: true,
        createdAt: NOW - 14 * DAY,
      },
      {
        id: "mcp_notes",
        name: "Markdump",
        url: "https://mcp.example.com/mcp",
        enabled: false,
        createdAt: NOW - 6 * DAY,
      },
    ],
    mcpTools: {
      mcp_docs: [
        {
          name: "search_cloudflare_documentation",
          description: "Search the Cloudflare developer docs.",
          policy: "auto_allow",
        },
        { name: "migrate_pages_to_workers_guide", description: null, policy: "approval_required" },
      ],
      mcp_notes: [{ name: "read", description: "Read a note.", policy: "approval_required" }],
    },
    mcpNeedsAuth: {},
    invites: {
      invites: [
        {
          id: "inv_1",
          token: "mocktoken1",
          email: null,
          status: "pending",
          createdAt: NOW - 3 * DAY,
          claimedAt: null,
          acceptedAt: null,
        },
        {
          id: "inv_2",
          token: null,
          email: "friend@example.com",
          status: "accepted",
          createdAt: NOW - 20 * DAY,
          claimedAt: NOW - 19 * DAY,
          acceptedAt: NOW - 19 * DAY,
        },
      ],
      quota: { used: 2, limit: 5 },
      isSuperuser: false,
      waitingList: [],
    },
    github: {
      configured: true,
      installations: [
        {
          id: "ghi_1",
          installationId: 4820193,
          accountLogin: "nadi-labs",
          accountType: "org",
          repositorySelection: "selected",
          status: "active",
          connectedByUserId: USER.id,
          updatedAt: NOW - 7 * DAY,
        },
      ],
    },
    githubRepositories: [
      {
        id: 1,
        fullName: "nadi-labs/nadi",
        owner: "nadi-labs",
        name: "nadi",
        defaultBranch: "main",
        cloneUrl: "https://github.com/nadi-labs/nadi.git",
        private: true,
      },
      {
        id: 2,
        fullName: "nadi-labs/docs-site",
        owner: "nadi-labs",
        name: "docs-site",
        defaultBranch: "main",
        cloneUrl: "https://github.com/nadi-labs/docs-site.git",
        private: false,
      },
    ],
    webTools: {
      exaSecretPresent: true,
      exaSecretUpdatedAt: "2026-07-02T11:30:00.000Z",
      webSearchEnabled: true,
    },
  };
}

function signedIn(): MockStore["session"] {
  return { authenticated: true, user: USER };
}

function emptyStore(): MockStore {
  return {
    session: signedIn(),
    settings: makeSettings(),
    threads: [],
    projects: [],
    workbenches: [],
    automata: [],
    skills: [],
    memories: [],
    mcpServers: [],
    mcpTools: {},
    mcpNeedsAuth: {},
    ...baseExtras(),
    features: noFeatures(),
    feedback: emptyFeedback(),
    artifacts: {},
    attachments: {},
    faults: noFaults(),
  };
}

/**
 * A brand-new account: no threads AND no usable provider. Both halves are
 * required — `deriveNeedsOnboarding` routes to the normal app the moment either
 * one exists, which is why `empty-account` (zero threads, Anthropic configured)
 * renders the shell's "No chats yet" instead of the wizard.
 */
function freshAccountStore(): MockStore {
  return { ...emptyStore(), settings: makeSettings({ anyConfigured: false }) };
}

/**
 * The empower step's baseline: a fresh account (no provider, no threads) with
 * no MCP servers connected yet.
 */
function onboardingEmpowerStore(): MockStore {
  return { ...freshAccountStore(), mcpServers: [], mcpTools: {}, mcpNeedsAuth: {} };
}

/**
 * Same fresh account, but Markdump is already connected and fully authorized
 * with a couple of tools — the "already connected on first paint" case.
 */
function onboardingEmpowerConnectedStore(): MockStore {
  const base = freshAccountStore();
  const serverId = "mcp_markdump";
  return {
    ...base,
    mcpServers: [
      {
        id: serverId,
        name: "Markdump",
        url: "https://markdump.com/mcp",
        enabled: true,
        createdAt: NOW - DAY,
      },
    ],
    mcpTools: {
      [serverId]: [
        { name: "read", description: "Read a note.", policy: "approval_required" },
        { name: "write", description: "Write a note.", policy: "approval_required" },
      ],
    },
    mcpNeedsAuth: {},
  };
}

/**
 * The bug's exact shape: Composio has finished OAuth (the row is fully
 * authorized, no `needsAuth`) but only a Gmail tool resolved — no calendar
 * account was ever connected inside it. Drives the onboarding nudge test:
 * the seeded automaton prompt must not promise a calendar briefing here.
 */
function onboardingEmpowerComposioNoCalendarStore(): MockStore {
  const base = freshAccountStore();
  const serverId = "mcp_composio";
  return {
    ...base,
    mcpServers: [
      {
        id: serverId,
        name: "Composio",
        url: "https://connect.composio.dev/mcp",
        enabled: true,
        createdAt: NOW - DAY,
      },
    ],
    mcpTools: {
      [serverId]: [
        { name: "GMAIL_SEND_EMAIL", description: "Send an email from Gmail.", policy: "approval_required" },
      ],
    },
    mcpNeedsAuth: {},
  };
}

const PROJECT_TITLES: Record<string, string[]> = {
  prj_platform: [
    "Migrate D1 schema for workbenches",
    "Trace the cold-start latency regression",
    "Durable Object RPC bypasses onStart",
    "Token ledger drifts after compaction",
  ],
  prj_web: [
    "Two-column layout on landscape phones",
    "Toast position in the split shell",
    "Offline history rehydration",
    "Composer keeps focus after send",
  ],
  prj_ops: ["Rotate the GitHub App private key", "Daytona snapshot bakes too slowly"],
};

function defaultStore(): MockStore {
  const projects = [
    makeProject({ id: "prj_platform", name: "Platform", description: "Worker, DO, and D1 work." }),
    makeProject({ id: "prj_web", name: "Web", description: "The SPA and its design system." }),
    makeProject({ id: "prj_ops", name: "Ops", description: "Deploys, secrets, and sandboxes." }),
  ];

  const workbenches = [
    makeWorkbench({
      id: "wb_nadi",
      name: "nadi",
      description: "Main monorepo checkout.",
      setupScript: "pnpm install --frozen-lockfile",
      envVars: { NODE_ENV: "development" },
      secretEnvNames: ["GH_TOKEN"],
      repositories: [
        {
          id: "wbr_nadi",
          workbenchId: "wb_nadi",
          source: "github",
          name: "nadi-labs/nadi",
          url: "https://github.com/nadi-labs/nadi.git",
          githubRepoId: 1,
          sourceInstallationId: "ghi_1",
          accessStatus: "ok",
          checkoutPathName: "nadi",
          defaultBranch: "main",
          rootDirectory: "",
          setupCommand: "pnpm install",
          packageManager: "pnpm",
          createdAt: NOW - 30 * DAY,
        },
      ],
    }),
    makeWorkbench({ id: "wb_docs", name: "docs-site", description: "Marketing + docs." }),
  ];

  const threads: ThreadSummary[] = [];
  let index = 0;
  for (const [projectId, titles] of Object.entries(PROJECT_TITLES)) {
    const project = projects.find((p) => p.id === projectId);
    for (const title of titles) {
      index += 1;
      threads.push(
        makeThread({
          threadId: `thr_${String(index).padStart(3, "0")}`,
          title,
          projectId,
          projectName: project?.name ?? null,
          workbenchId: "wb_nadi",
          workbenchName: "nadi",
          lastMessagePreview: `Working through "${title}" — here is where it stands.`,
          lastContextTokens: 12_000 + index * 900,
          lastContextWindow: 200_000,
          lastCompactAfterTokens: 112_000,
          createdAt: NOW - (index + 2) * DAY,
          updatedAt: NOW - index * HOUR,
        }),
      );
    }
  }

  // A couple of unassigned threads so the "unassigned" filter is non-empty.
  threads.push(
    makeThread({
      threadId: "thr_020",
      title: "Scratch: rg patterns for the migration",
      lastMessagePreview: "Here are the ripgrep incantations you asked for.",
      updatedAt: NOW - 30 * MINUTE,
    }),
    makeThread({
      threadId: "thr_021",
      title: "Nightly deploy digest",
      source: "automaton",
      automatonId: "atm_digest",
      automatonName: "Nightly digest",
      automatonNotifyMode: "failures_only",
      lastMessagePreview: "Deploy 2f91ac succeeded; 3 migrations applied.",
      updatedAt: NOW - 2 * HOUR,
    }),
  );

  // One archived thread so the archived list is reachable.
  threads.push(
    makeThread({
      threadId: "thr_022",
      title: "Old spike: WebGPU renderer",
      status: "archived",
      archivedAt: NOW - 5 * DAY,
      readOnly: true,
      lastMessagePreview: "Parking this until the compute story settles.",
      updatedAt: NOW - 5 * DAY,
    }),
  );

  threads.sort((a, b) => b.updatedAt - a.updatedAt);

  return {
    session: signedIn(),
    settings: makeSettings(),
    threads,
    projects,
    workbenches,
    ...richExtras(),
    features: noFeatures(),
    feedback: emptyFeedback(),
    artifacts: {},
    attachments: {},
    faults: noFaults(),
    automata: [
      makeAutomaton({
        id: "atm_digest",
        name: "Nightly digest",
        notifyMode: "failures_only",
        lastRun: {
          id: "run_1",
          status: "completed",
          trigger: "scheduled",
          startedAt: NOW - 2 * HOUR,
          finishedAt: NOW - 2 * HOUR + 45_000,
          threadId: "thr_021",
          error: null,
        },
      }),
      makeAutomaton({
        id: "atm_triage",
        name: "Issue triage",
        projectId: "prj_platform",
        // Exercises the workbench override (ffccbb16): this one pins a
        // workbench instead of inheriting the project default, so the picker
        // renders a selected value rather than only the empty state.
        workbenchId: "wb_docs",
        // The custom-cron path, so the panel's advanced section is reachable.
        scheduleJson: JSON.stringify({ kind: "cron", expr: "*/30 9-18 * * 1-5" }),
        enabled: false,
        disabledReason: "Paused by owner",
        nextDueAt: null,
        lastRun: null,
      }),
    ],
  };
}

/**
 * Every state `ThreadIndicator` can render, one thread each, at the top of the
 * list so all five are on screen together. The component reads only
 * `activityStatus` and `unreadOutcome`, and it checks them in this order:
 * attention_required, running, unreadOutcome failed, unreadOutcome completed,
 * then nothing — so a thread that sets two would only ever show the first.
 */
const INDICATOR_THREADS: Array<Partial<ThreadSummary>> = [
  {
    threadId: "thr_ind_attention",
    title: "Deploy follow-up",
    lastMessagePreview: "The staging run needs a final approval step.",
    activityStatus: "attention_required",
    attentionRequiredAt: NOW - 30_000,
  },
  {
    threadId: "thr_ind_running",
    title: "Long-running migration",
    lastMessagePreview: "Checking row counts before the final copy.",
    activityStatus: "running",
    currentTurnStartedAt: NOW - 90_000,
  },
  {
    threadId: "thr_ind_failed",
    title: "Webhook retries",
    lastMessagePreview: "Failed — same unread dot, but the label still says so.",
    activityStatus: "idle",
    unreadOutcome: "failed",
    unreadOutcomeAt: NOW - 5 * MINUTE,
  },
  {
    threadId: "thr_ind_completed",
    title: "Sandbox audit",
    lastMessagePreview: "Finished and waiting for you to open the transcript.",
    activityStatus: "idle",
    unreadOutcome: "completed",
    unreadOutcomeAt: NOW - 8 * MINUTE,
  },
  {
    threadId: "thr_ind_quiet",
    title: "Weekly digest",
    lastMessagePreview: "Seen — no marker on a quiet, caught-up thread.",
    activityStatus: "idle",
    unreadOutcome: null,
    lastSeenAt: NOW - HOUR,
  },
];

function busyWorkspaceStore(): MockStore {
  const base = defaultStore();
  // Newest-first, and ahead of the batch rows below, so opening the scenario
  // puts all five indicator states in the first screenful.
  const indicators = INDICATOR_THREADS.map((fields, i) =>
    makeThread({ ...fields, updatedAt: NOW - i * MINUTE }),
  );
  const extra: ThreadSummary[] = [];
  for (let i = 0; i < 40; i += 1) {
    const running = i % 3 === 0;
    extra.push(
      makeThread({
        threadId: `thr_busy_${String(i).padStart(3, "0")}`,
        title: `Batch job ${i + 1}: reconcile workspace state`,
        projectId: "prj_platform",
        projectName: "Platform",
        lastMessagePreview: `Pass ${i + 1} is running against the staging workspace.`,
        ...(running ? { activityStatus: "running" as const } : {}),
        currentTurnStartedAt: running ? NOW - 90_000 : null,
        attentionRequiredAt: i % 7 === 0 ? NOW - 30_000 : null,
        updatedAt: NOW - (i + INDICATOR_THREADS.length) * MINUTE,
      }),
    );
  }
  return { ...base, threads: [...indicators, ...extra, ...base.threads] };
}

/**
 * Two threads whose history is unreachable, because the fallback's leading
 * control is context-dependent and only the entry path decides which one shows:
 * `thr_001` is opened from the list (rail toggle), `thr_021` is the nightly
 * digest's run thread and is opened from Automata (Back arrow).
 */
function historyErrorStore(): MockStore {
  const base = defaultStore();
  return {
    ...base,
    threads: base.threads.map((t) =>
      t.threadId === "thr_001" ? { ...t, title: "Thread whose history fails to load" } : t,
    ),
    faults: { ...noFaults(), historyUnreachableThreadIds: ["thr_001", "thr_021"] },
  };
}

/** Send the first message from the new-chat hero here and the delivery POST
 *  hangs, then fails: the optimistic bubble is visible as `sending` for a beat
 *  and then lands on `failed` with its Retry. */
/**
 * A thread whose history stops mid-turn, so opening it lands in the "a reply is
 * inbound but nothing is streaming yet" state. Drives the typing-dots hold that
 * used to blink out the moment the socket reported open.
 */
function midTurnResumeStore(): MockStore {
  const base = defaultStore();
  return {
    ...base,
    threads: [
      makeThread({
        threadId: MID_TURN_THREAD_ID,
        title: "Deploy config walkthrough",
        lastMessagePreview: "Now walk me through what changed in the workflow.",
        updatedAt: NOW - 1 * MINUTE,
      }),
      ...base.threads,
    ],
  };
}

/**
 * The documentation screenshot seed: a full two-exchange thread at the top of a
 * populated rail. Kept a named scenario rather than a one-off script so a
 * regenerated hero image is reproducible instead of a lucky capture.
 */
function heroStore(): MockStore {
  const base = defaultStore();
  return {
    ...base,
    threads: [
      makeThread({
        threadId: HERO_THREAD_ID,
        // The model Nadi leads with on the landing page, so the screenshots and
        // the pitch name the same thing.
        provider: "opencode-go",
        model: "deepseek-v4-flash",
        title: "Support volume doubled this week",
        lastMessagePreview: "The draft opens here Monday at 9:00.",
        projectName: "Customers",
        updatedAt: NOW - 3 * MINUTE,
      }),
      // A deliberately mixed rail. The default store's threads are all
      // platform work, which framed the whole screenshot as an engineering
      // tool; the product is not one.
      makeThread({
        threadId: "thr_hero_2",
        title: "Weekly revenue digest",
        projectName: "Finance",
        lastMessagePreview: "Net revenue retention is up 4 points.",
        updatedAt: NOW - 2 * HOUR,
      }),
      makeThread({
        threadId: "thr_hero_3",
        title: "Rewrite the onboarding email sequence",
        projectName: "Growth",
        lastMessagePreview: "Third email is doing the work of the first two.",
        updatedAt: NOW - 5 * HOUR,
      }),
      makeThread({
        threadId: "thr_hero_4",
        title: "Vendor contract review — renewal terms",
        projectName: "Ops",
        lastMessagePreview: "Auto-renew clause needs 60 days notice.",
        updatedAt: NOW - 1 * DAY,
      }),
      makeThread({
        threadId: "thr_hero_5",
        title: "Q3 board update outline",
        projectName: "Exec",
        lastMessagePreview: "Draft is in /drafts/q3-board.md.",
        updatedAt: NOW - 1 * DAY - 3 * HOUR,
      }),
      makeThread({
        threadId: "thr_hero_6",
        title: "Nightly deploy digest",
        source: "automaton",
        automatonName: "Nightly digest",
        lastMessagePreview: "3 deploys, no rollbacks.",
        updatedAt: NOW - 2 * DAY,
      }),
      makeThread({
        threadId: "thr_hero_7",
        title: "Migrate D1 schema for billing country",
        projectName: "Platform",
        lastMessagePreview: "Migration 0061 generated.",
        updatedAt: NOW - 2 * DAY - 4 * HOUR,
      }),
    ],
    // Server ids match the tool keys heroTranscript() uses, so the run log
    // renders "Zendesk"/"Linear"/"Markdump" instead of a raw namespaced key.
    mcpServers: [
      { id: "s4zen", name: "Zendesk", url: "https://mcp.zendesk.com/sse", enabled: true, createdAt: NOW - 9 * DAY },
      { id: "s1abc", name: "Linear", url: "https://mcp.linear.app/sse", enabled: true, createdAt: NOW - 9 * DAY },
      { id: "s3ghi", name: "Markdump", url: "https://mcp.example.com/mcp", enabled: true, createdAt: NOW - 9 * DAY },
    ],
  };
}

function firstMessageFailureStore(): MockStore {
  return { ...defaultStore(), faults: { ...noFaults(), messageSendFailsAfterMs: 2_000 } };
}

const FEEDBACK_THREAD_ID = "thr_feedback_mock";
const FEEDBACK_INTERVIEW_ID = "interview_feedback_mock";
const FEEDBACK_SCREENSHOT_ID = "att_feedback_screenshot";

function makeFeedbackThread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return makeThread({
    threadId: FEEDBACK_THREAD_ID,
    kind: "feedback",
    provider: "workers-ai",
    model: "@cf/moonshotai/kimi-k2.7-code",
    runtime: "think",
    title: "Feedback",
    lastMessagePreview: "I can draft that report now.",
    updatedAt: NOW - 5 * MINUTE,
    ...overrides,
  });
}

function bugFields(overrides: Partial<FeedbackReportFields> = {}): FeedbackReportFields {
  return {
    category: "bug",
    title: "Composer freezes after screenshot upload",
    narrative: "After attaching a screenshot, the feedback composer stopped accepting text.",
    reproductionSteps: ["Open Send feedback", "Attach a screenshot", "Try to keep typing"],
    expectedBehavior: "The composer stays editable after uploads finish.",
    actualBehavior: "The textarea is stuck until the page is reloaded.",
    frequency: "Every time with large PNGs",
    impact: "Blocks users from completing feedback reports.",
    ...overrides,
  };
}

function mockDiagnostics(route = "/feedback"): FeedbackDiagnostics {
  return {
    schemaVersion: 1,
    route,
    build: "mock-build",
    browser: "Chrome 130",
    os: "macOS",
    viewport: { width: 1280, height: 800 },
    theme: "light",
    online: true,
  };
}

function makeDraft(overrides: Partial<FeedbackDraftView> = {}): FeedbackDraftView {
  return {
    id: "draft_feedback_mock",
    interviewId: FEEDBACK_INTERVIEW_ID,
    fields: bugFields(),
    attachmentIds: [FEEDBACK_SCREENSHOT_ID],
    createdAt: NOW - 3 * MINUTE,
    ...overrides,
  };
}

function makeReport(
  id: string,
  fields: FeedbackReportFields,
  overrides: Partial<FeedbackReportDetail> = {},
): FeedbackReportDetail {
  return {
    id,
    reporterUserId: USER.id,
    workspaceId: WORKSPACE_ID,
    threadId: FEEDBACK_THREAD_ID,
    interviewId: FEEDBACK_INTERVIEW_ID,
    category: fields.category,
    title: fields.title,
    submittedAt: NOW - MINUTE,
    attachmentCount: 1,
    seen: false,
    fromMessageId: "msg_feedback_start",
    toMessageId: "msg_feedback_draft",
    fields,
    diagnostics: mockDiagnostics("/feedback"),
    attachmentIds: [FEEDBACK_SCREENSHOT_ID],
    ...overrides,
  };
}

function feedbackStore(): MockStore {
  const base = defaultStore();
  const thread = makeFeedbackThread();
  return {
    ...base,
    feedback: {
      thread,
      drafts: [makeDraft()],
      reports: [],
      seenReportIds: [],
      messages: [],
      transcriptsByReportId: {},
    },
  };
}

function feedbackModelErrorStore(): MockStore {
  const base = feedbackStore();
  return {
    ...base,
    faults: { ...base.faults, feedbackModelFails: true },
    feedback: { ...base.feedback, drafts: [] },
  };
}

function feedbackRateLimitedStore(): MockStore {
  const base = feedbackStore();
  return {
    ...base,
    faults: { ...base.faults, feedbackRateLimitedRetryAfterSeconds: 900 },
    feedback: { ...base.feedback, drafts: [] },
  };
}

function feedbackAdminStore(): MockStore {
  const base = feedbackStore();
  const reports = [
    makeReport("fbr_feedback_bug", bugFields(), { submittedAt: NOW - 10 * MINUTE }),
    makeReport(
      "fbr_feedback_feature",
      {
        category: "feature",
        title: "Add workspace-level feedback labels",
        narrative: "It would help admins route reports if users could choose an area.",
        reproductionSteps: [],
        expectedBehavior: "The feedback form offers lightweight labels for routing.",
        actualBehavior: null,
        frequency: null,
        impact: "Would speed triage for product and support work.",
      },
      {
        interviewId: "interview_feedback_feature",
        fromMessageId: "msg_feedback_feature_start",
        toMessageId: "msg_feedback_feature_draft",
        submittedAt: NOW - 20 * MINUTE,
        attachmentIds: [],
        attachmentCount: 0,
      },
    ),
    makeReport(
      "fbr_feedback_general",
      {
        category: "general",
        title: "The new feedback flow feels calmer",
        narrative: "The guided questions made it easier to explain what happened.",
        reproductionSteps: [],
        expectedBehavior: null,
        actualBehavior: null,
        frequency: null,
        impact: "Positive signal for the interview-style flow.",
      },
      {
        interviewId: "interview_feedback_general",
        fromMessageId: "msg_feedback_general_start",
        toMessageId: "msg_feedback_general_draft",
        submittedAt: NOW - 30 * MINUTE,
        attachmentIds: ["att_feedback_general"],
        attachmentCount: 1,
        diagnostics: mockDiagnostics("/settings/repositories"),
      },
    ),
  ];
  return {
    ...base,
    features: { ...base.features, feedbackAdmin: true },
    feedback: {
      thread: base.feedback.thread,
      drafts: [],
      reports,
      seenReportIds: ["fbr_feedback_feature", "fbr_feedback_general"],
      messages: [],
      transcriptsByReportId: {},
    },
  };
}

/** Cloudflare compute selected and ready. Unrestricted, which is exactly what
 *  makes the Cloudflare option selectable at all. */
function cloudflareComputeStore(): MockStore {
  return {
    ...defaultStore(),
    sandbox: makeSandbox({ provider: "cloudflare", networkRestricted: false }),
  };
}

/** Hosted Daytona credentials and sources, with no tenant override. */
function daytonaSystemStore(): MockStore {
  const base = defaultStore();
  const sandbox = makeSandbox();
  if (sandbox.workspace) {
    sandbox.workspace.providerConfig = {
      kind: "daytona",
      apiKeySecretName: "sandbox:daytona",
      apiUrl: null,
      target: null,
      profiles: { small: null, medium: null },
    };
    sandbox.workspace.idleTimeoutMs = 900_000;
  }
  sandbox.daytonaMode = "system";
  sandbox.daytonaAvailable = true;
  sandbox.daytonaSecretPresent = false;
  return { ...base, sandbox, daytonaSystemAvailable: true };
}

/** Tenant-provided Daytona credentials and sources. */
function daytonaByokStore(): MockStore {
  return { ...defaultStore(), sandbox: makeSandbox() };
}

/** The hosted cloud edition: an operator provisioned compute, so the read-only
 *  "Cloudflare deployment" panel is hidden. Everything a tenant can actually
 *  change stays put — this is the only difference from `cloudflare-compute`. */
function cloudflareManagedStore(): MockStore {
  return {
    ...defaultStore(),
    sandbox: makeSandbox({
      provider: "cloudflare",
      networkRestricted: false,
      operatorManagedCompute: true,
    }),
  };
}

/** Cloudflare selected but not ready for BOTH reasons at once — missing bindings
 *  and a restricted network. Neither cause may hide the other. */
function cloudflareBlockedStore(): MockStore {
  return {
    ...defaultStore(),
    sandbox: makeSandbox({
      provider: "cloudflare",
      networkRestricted: true,
      cloudflareMissingConfig: ["BACKUP_BUCKET", "BACKUP_BUCKET_NAME", "R2_ACCESS_KEY_ID"],
    }),
  };
}

/**
 * The rail's dismissal states, at the top of the list so all three are on one
 * screen. The rule under test is `recentDismissedAt >= updatedAt`: a stamp
 * older than the thread's last activity is spent, which is what brings a
 * dismissed thread back without anything having to un-dismiss it.
 *
 * All three stay in All chats — that is the point of the feature, and it is
 * only visible by opening All chats and finding the hidden one still there.
 */
function dismissedThreadsStore(): MockStore {
  const base = defaultStore();
  const threads: ThreadSummary[] = [
    makeThread({
      threadId: "thr_dismiss_hidden",
      title: "Dismissed: one-off shell question",
      lastMessagePreview: "Hidden from the rail. Still in All chats.",
      updatedAt: NOW - MINUTE,
      recentDismissedAt: NOW,
    }),
    makeThread({
      threadId: "thr_dismiss_returned",
      title: "Dismissed, then replied to",
      lastMessagePreview: "Back in the rail: new activity outran the dismissal.",
      updatedAt: NOW - 2 * MINUTE,
      recentDismissedAt: NOW - 30 * MINUTE,
    }),
    makeThread({
      threadId: "thr_dismiss_unread",
      title: "Unread — has Mark as read",
      lastMessagePreview: "The only row whose menu shows Mark as read.",
      activityStatus: "idle",
      unreadOutcome: "completed",
      unreadOutcomeAt: NOW - 3 * MINUTE,
      updatedAt: NOW - 3 * MINUTE,
    }),
  ];
  return { ...base, threads: [...threads, ...base.threads] };
}

/**
 * One assistant turn that touches every branch of the run log — a passing and a
 * failing command, a read, a patch, a search, an MCP text result, an MCP
 * `isError`, a denied call, a plain-string memory return, and a call still
 * running. The transcript lives in mocks/chat/tool-run-transcript.ts; the two
 * MCP server ids match the `tool_<serverId>_<tool>` keys it uses, so
 * resolveToolName can name them instead of falling back to the raw key.
 */
function toolRunStore(): MockStore {
  const base = defaultStore();
  return {
    ...base,
    threads: [
      makeThread({
        threadId: TOOL_RUN_THREAD_ID,
        title: "Archive column for threads",
        lastMessagePreview: "The typecheck is failing on the new column.",
        updatedAt: NOW - 5 * MINUTE,
      }),
      makeThread({
        threadId: TOOL_WRITE_THREAD_ID,
        title: "Daily Reddit Curation — Manual run",
        lastMessagePreview: "Writing the remaining clusters.",
        updatedAt: NOW - 9 * MINUTE,
      }),
      ...base.threads,
    ],
    mcpServers: [
      { id: "s1abc", name: "Linear", url: "https://mcp.linear.app/sse", enabled: true, createdAt: NOW - 3 * DAY },
      { id: "s2def", name: "Sentry", url: "https://mcp.sentry.dev/sse", enabled: true, createdAt: NOW - 3 * DAY },
      { id: "s3ghi", name: "Markdump", url: "https://mcp.example.com/mcp", enabled: true, createdAt: NOW - 3 * DAY },
      ...base.mcpServers,
    ],
  };
}

export function makeArtifact(overrides: Partial<MockArtifact> = {}): MockArtifact {
  return {
    id: MOCK_ARTIFACT_ID,
    threadId: ASSISTANT_ARTIFACTS_THREAD_ID,
    title: "Usage dashboard",
    entryPath: "index.html",
    fileCount: 3,
    byteSize: 28_400,
    expiresAt: liveArtifactExpiresAt(),
    status: "active",
    createdAt: NOW - 2 * MINUTE,
    ...overrides,
  };
}

export function makeAttachment(overrides: Partial<MockAttachment> = {}): MockAttachment {
  return {
    id: "att_adl_chart",
    threadId: ASSISTANT_DOWNLOAD_THREAD_ID,
    filename: "churn_by_segment.png",
    mimeType: "image/png",
    byteSize: 48_210,
    status: "committed",
    createdAt: NOW - 2 * MINUTE,
    ...overrides,
  };
}

/** Assistant published an HTML artifact — chip + preview in the timeline. */
function assistantArtifactsStore(): MockStore {
  const base = defaultStore();
  const artifact = makeArtifact();
  return {
    ...base,
    artifacts: { [artifact.id]: artifact },
    threads: [
      makeThread({
        threadId: ASSISTANT_ARTIFACTS_THREAD_ID,
        title: "Usage dashboard preview",
        lastMessagePreview: "The preview link expires in 24 hours.",
        updatedAt: NOW - 2 * MINUTE,
      }),
      ...base.threads,
    ],
  };
}

/** Same published artifact, already past expiresAt — drives the Republish chip. */
function assistantArtifactsExpiredStore(): MockStore {
  const base = assistantArtifactsStore();
  const artifact = makeArtifact({
    expiresAt: Date.now() - 60_000,
    status: "expired",
  });
  return {
    ...base,
    artifacts: { [artifact.id]: artifact },
  };
}

/** Assistant sent an image via exec_download_file — chip + lightbox in the timeline. */
function assistantAttachmentsStore(): MockStore {
  const base = defaultStore();
  const attachment = makeAttachment();
  return {
    ...base,
    attachments: { [attachment.id]: attachment },
    threads: [
      makeThread({
        threadId: ASSISTANT_DOWNLOAD_THREAD_ID,
        title: "Churn chart for last week",
        lastMessagePreview: "Chart attached — open it for a closer look or download.",
        updatedAt: NOW - 2 * MINUTE,
      }),
      ...base.threads,
    ],
  };
}

export const SCENARIOS: Record<string, () => MockStore> = {
  default: defaultStore,
  "tool-run": toolRunStore,
  "assistant-attachments": assistantAttachmentsStore,
  "assistant-artifacts": assistantArtifactsStore,
  "assistant-artifacts-expired": assistantArtifactsExpiredStore,
  "empty-account": emptyStore,
  "fresh-account": freshAccountStore,
  "onboarding-empower": onboardingEmpowerStore,
  "onboarding-empower-connected": onboardingEmpowerConnectedStore,
  "onboarding-empower-composio-no-calendar": onboardingEmpowerComposioNoCalendarStore,
  "busy-workspace": busyWorkspaceStore,
  "dismissed-threads": dismissedThreadsStore,
  // Seeded like `default`; the interesting part is the live traffic that
  // mocks/thread-activity-demo.ts pushes at it a couple of seconds in.
  "thread-activity": defaultStore,
  "history-error": historyErrorStore,
  "first-message-failure": firstMessageFailureStore,
  "mid-turn-resume": midTurnResumeStore,
  hero: heroStore,
  feedback: feedbackStore,
  "feedback-model-error": feedbackModelErrorStore,
  "feedback-rate-limited": feedbackRateLimitedStore,
  "feedback-admin": feedbackAdminStore,
  "daytona-system": daytonaSystemStore,
  "daytona-byok": daytonaByokStore,
  "cloudflare-compute": cloudflareComputeStore,
  "cloudflare-managed": cloudflareManagedStore,
  "cloudflare-blocked": cloudflareBlockedStore,
  "background-work-enabled": backgroundWorkEnabledStore,
  "workbench-network-allowlist": workbenchNetworkAllowlistStore,
};
