import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Resolve posthog-js from web/ so that vi.mock("posthog-js") and the import
// inside web/src/lib/posthog.ts both resolve to the same physical module.
const require = createRequire(fileURLToPath(new URL("./web/package.json", import.meta.url)));
const posthogJsEntry = require.resolve("posthog-js");

// cron-parser's own `require("luxon")` is a nested dependency (not hoisted to
// the root, and not a direct dependency of this package), so under
// @cloudflare/vitest-pool-workers's on-demand module-fallback loader that
// `require()` call is served as a raw CommonJS module with no cjs->esm
// interop shim (the shim is only applied to `import`-style resolution) and
// resolves to an object with no usable exports — every call into
// automata/schedule.ts's `computeNextDueAt` (which shells out to
// cron-parser, which shells out to luxon for tz-aware math) then throws
// "Cannot read properties of undefined (reading 'DateTime')" purely as an
// artifact of this test harness. `wrangler deploy --dry-run` confirms the
// real production bundle inlines luxon correctly via esbuild's `__commonJS`
// helper, so this alias only needs to exist for tests. Aliasing "luxon" here
// forces Vite's own resolver (which the module-fallback loader defers to) to
// hand back the same physical module either way, sidestepping the shim gap.
const luxonEntry = createRequire(require.resolve("cron-parser/package.json")).resolve("luxon");

const integrationGroupedIsolatedFiles = [
  "test/integration/archive-thread-core.integration.test.ts",
  "test/integration/attachment-chat.integration.test.ts",
  "test/integration/chat.integration.test.ts",
  "test/integration/export-history.integration.test.ts",
  "test/integration/injection-buffer.test.ts",
  "test/integration/injection-drain.test.ts",
  "test/integration/kv-oauth-provider.integration.test.ts",
  "test/integration/mcp-approval.integration.test.ts",
  "test/integration/sandbox-thread-store.test.ts",
  "test/integration/skill-script-runner-gating.integration.test.ts",
  "test/integration/subagent-detached-injection.test.ts",
  "test/integration/subagent.integration.test.ts",
  "test/integration/think-thread-agent.integration.test.ts",
  "test/integration/thread-draft.integration.test.ts",
  "test/integration/user-hub-broadcast.integration.test.ts",
  "test/integration/web-document-store.integration.test.ts",
  "test/integration/web-tools.integration.test.ts",
  "test/integration/work-ledger.integration.test.ts",
  "test/integration/workspace-mcp-agent.integration.test.ts",
];

const integrationIsolatedEntryFiles = [
  "test/integration/isolated-do-suite.integration.test.ts",
  "test/integration/thread-transcript-adapters.integration.test.ts",
  "test/integration/thread-knowledge-tools.integration.test.ts",
  "test/integration/thread-search-projector.integration.test.ts",
  "test/integration/thread-search-lifecycle.integration.test.ts",
  "test/integration/thread-search-repair.integration.test.ts",
  "test/integration/thread-knowledge-digest.integration.test.ts",
  "test/integration/user-hub-broadcast.integration.test.ts",
  // These source-level tests use `cloudflare:workers` but need Vitest's
  // default per-file module isolation for their mocks.
  "test/unit/agent/think-sdk-contract.test.ts",
  "test/unit/agent/think-model-messages-override.test.ts",
  "test/unit/agent/thread-compaction-wiring.test.ts",
  "test/unit/agent/turn-usage-wiring.test.ts",
  "test/unit/agent/cancel-stops-processes.test.ts",
  "test/unit/agent/work-ledger-store.test.ts",
  "test/unit/agent/tool-call-timing-store.test.ts",
  "test/unit/agent/work-delivery-ownership.test.ts",
  "test/unit/agent/alarm-rearm.test.ts",
  "test/unit/agent/work-terminal-funnel.test.ts",
  "test/unit/agent/subagent-ledger-wiring.test.ts",
  "test/unit/agent/workbench-switch-commit-wiring.test.ts",
];

const integrationFastExcludeFiles = [
  ...integrationGroupedIsolatedFiles,
  ...integrationIsolatedEntryFiles,
];

function integrationPlugins() {
  return [
    cloudflareTest({
      main: "./src/index.ts",
      remoteBindings: false,
      miniflare: {
        compatibilityDate: "2026-05-01",
        compatibilityFlags: ["nodejs_compat"],
        kvNamespaces: ["SECRETS_KV"],
        d1Databases: ["REGISTRY_DB"],
        r2Buckets: ["ATTACHMENTS_BUCKET"],
        durableObjects: {
          THREAD_AGENT: { className: "ThreadAgentV2", useSQLite: true },
          THINK_THREAD_AGENT: { className: "ThinkThreadAgent", useSQLite: true },
          WORKSPACE_MCP_AGENT: { className: "WorkspaceMcpAgent", useSQLite: true },
          USER_HUB: { className: "UserHub", useSQLite: true },
          VOICE_AGENT: { className: "VoiceAgent", useSQLite: true },
          // TEST-ONLY: SubAgent is a facet-only class (no wrangler.jsonc
          // binding — it's only ever reached via getSubAgentByName from a
          // parent ThinkThreadAgent). This binding lets integration tests
          // drive it directly in-pool without a real facet parent call.
          SUB_AGENT: { className: "SubAgent", useSQLite: true },
        },
        bindings: {
          LOG_LEVEL: "warn",
          APP_BASE_URL: "https://nadi.test",
          CANONICAL_HOST: "app.example.com",
          LEGACY_HOSTS: "legacy.example.com",
          DEFAULT_MODEL_PROVIDER: "mock",
          DEFAULT_MODEL: "mock",
          TOOL_APPROVAL_SECRET: "test-secret",
          R2_ACCOUNT_ID: "test-account",
          R2_BUCKET_NAME: "nadi-attachments",
          R2_ACCESS_KEY_ID: "test-access-key",
          R2_SECRET_ACCESS_KEY: "test-secret-key",
          BETTER_AUTH_SECRET: "test-better-auth-secret-with-enough-entropy",
          SECRETS_STORE_KEK_RAW_B64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          AUTH_EMAIL_FROM: "signin@nadi.test",
          EMAIL_DELIVERY_DISABLED: "true",
          BACKGROUND_WORK_ENABLED: "true",
          GITHUB_APP_ID: "123456",
          GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
          GITHUB_APP_CLIENT_ID: "Iv1.testclientid",
          GITHUB_APP_CLIENT_SECRET: "test-github-client-secret",
          GITHUB_APP_SLUG: "nadi-test",
        },
      },
    }),
  ];
}

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./web/src", import.meta.url)),
      luxon: luxonEntry,
    },
  },
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          exclude: [
            "**/node_modules/**",
            "**/.git/**",
            "test/unit/web/**/*.test.ts",
            // Imports @cloudflare/think, which pulls in a `cloudflare:workers`
            // specifier the plain-node unit environment can't load. Runs
            // under the isolated integration workers pool instead.
            "test/unit/agent/think-sdk-contract.test.ts",
            "test/unit/agent/think-model-messages-override.test.ts",
            "test/unit/agent/thread-compaction-wiring.test.ts",
            "test/unit/agent/turn-usage-wiring.test.ts",
            "test/unit/agent/cancel-stops-processes.test.ts",
            "test/unit/agent/work-ledger-store.test.ts",
            "test/unit/agent/tool-call-timing-store.test.ts",
            "test/unit/agent/work-delivery-ownership.test.ts",
            "test/unit/agent/alarm-rearm.test.ts",
            "test/unit/agent/work-terminal-funnel.test.ts",
            "test/unit/agent/subagent-ledger-wiring.test.ts",
            "test/unit/agent/workbench-switch-commit-wiring.test.ts",
          ],
          environment: "node",
          clearMocks: true,
          maxWorkers: 2,
          sequence: { groupOrder: 1 },
        },
      },
      {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./web/src", import.meta.url)),
            // Ensure posthog-js resolves to the same physical module from both
            // the test files (test/unit/web/) and web/src/lib/ so vi.mock
            // intercepts the import in the module-under-test correctly.
            "posthog-js": posthogJsEntry,
          },
        },
        test: {
          name: "web-unit",
          include: [
            "web/src/**/*.test.ts",
            "web/src/**/*.test.tsx",
            "test/unit/web/**/*.test.ts",
            "test/unit/web/**/*.test.tsx",
          ],
          environment: "node",
          clearMocks: true,
          maxWorkers: 2,
          sequence: { groupOrder: 1 },
        },
      },
      {
        plugins: integrationPlugins(),
        test: {
          name: "integration-fast",
          include: ["test/integration/**/*.test.ts"],
          exclude: integrationFastExcludeFiles,
          setupFiles: ["test/integration/setup.ts"],
          isolate: false,
          fileParallelism: false,
          sequence: { groupOrder: 3 },
        },
      },
      {
        plugins: integrationPlugins(),
        test: {
          name: "integration-isolated",
          include: integrationIsolatedEntryFiles,
          maxWorkers: 1,
          sequence: { groupOrder: 4 },
        },
      },
    ],
  },
});
