import { existsSync, globSync } from "node:fs";
import { join } from "node:path";
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
  "test/integration/chat.integration.test.ts",
  "test/integration/export-history.integration.test.ts",
  "test/integration/injection-buffer.test.ts",
  "test/integration/injection-drain.test.ts",
  "test/integration/kv-oauth-provider.integration.test.ts",
  "test/integration/model-switch-commit.integration.test.ts",
  "test/integration/model-switch-send-path.integration.test.ts",
  "test/integration/queued-model-switch.integration.test.ts",
  "test/integration/skill-script-runner-gating.integration.test.ts",
  "test/integration/subagent-detached-injection.test.ts",
  "test/integration/subagent-model-pin.integration.test.ts",
  "test/integration/subagent.integration.test.ts",
  "test/integration/think-thread-agent.integration.test.ts",
  "test/integration/thread-draft.integration.test.ts",
  "test/integration/web-document-store.integration.test.ts",
  "test/integration/web-tools.integration.test.ts",
  "test/integration/work-ledger.integration.test.ts",
  "test/integration/workspace-mcp-agent.integration.test.ts",
];

// Under the workers pool, per-file isolation means a fresh workerd isolate that
// re-imports the whole `src/index.ts` module graph — roughly 9s of import per
// file, dwarfing the tests themselves. So a file earns its own isolate only if
// it needs a pristine module registry, which is true in exactly two cases:
//
//   1. it calls `vi.mock` — a shared registry leaks the mock into later files;
//   2. it asserts on shared module identity (e.g. `Think.prototype` method
//      arity), which a shared registry can resolve to a different instance.
//
// Everything else shares one isolate (integration-shared) and pays the import
// cost exactly once instead of once per file.
const integrationPristineRegistryFiles = [
  "test/integration/thread-search-repair.integration.test.ts",
  // Source-level tests that use `cloudflare:workers` AND call vi.mock.
  "test/unit/agent/turn-usage-wiring.test.ts",
  "test/unit/agent/cancel-stops-processes.test.ts",
  "test/unit/agent/alarm-rearm.test.ts",
  "test/unit/agent/work-terminal-funnel.test.ts",
  "test/unit/agent/subagent-ledger-wiring.test.ts",
  "test/unit/agent/subagent-stop-attribution.test.ts",
  // Pins SDK prototype methods, so it must observe an unshared module graph.
  "test/unit/agent/think-sdk-contract.test.ts",
];

// Mock-free, but still need the workers pool — either for Durable Object /
// storage semantics or for a `cloudflare:workers` specifier that the plain-node
// `unit` environment cannot load. These all share a single isolate.
const integrationSharedIsolateFiles = [
  "test/integration/isolated-do-suite.integration.test.ts",
  "test/integration/thread-transcript-adapters.integration.test.ts",
  "test/integration/thread-knowledge-tools.integration.test.ts",
  "test/integration/thread-search-projector.integration.test.ts",
  "test/integration/thread-search-lifecycle.integration.test.ts",
  "test/integration/thread-knowledge-digest.integration.test.ts",
  "test/integration/user-hub-broadcast.integration.test.ts",
  "test/unit/agent/think-model-messages-override.test.ts",
  "test/unit/agent/thread-compaction-wiring.test.ts",
  "test/unit/agent/work-ledger-store.test.ts",
  "test/unit/agent/list-background-work.test.ts",
  "test/unit/agent/tool-call-timing-store.test.ts",
  "test/unit/agent/work-delivery-ownership.test.ts",
  "test/unit/agent/model-switch-commit.test.ts",
];

// Every `test/unit/**` file above runs under the workers pool instead of the
// plain-node `unit` project, so `unit` has to skip exactly these.
const unitFilesRunByWorkersPool = [
  ...integrationPristineRegistryFiles,
  ...integrationSharedIsolateFiles,
].filter((file) => file.startsWith("test/unit/"));

const integrationFastExcludeFiles = [
  ...integrationGroupedIsolatedFiles,
  ...integrationPristineRegistryFiles,
  ...integrationSharedIsolateFiles,
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
          THINK_THREAD_AGENT: { className: "ThinkThreadAgent", useSQLite: true },
          WORKSPACE_MCP_AGENT: { className: "WorkspaceMcpAgent", useSQLite: true },
          USER_HUB: { className: "UserHub", useSQLite: true },
          VOICE_AGENT: { className: "VoiceAgent", useSQLite: true },
          AGENT_SANDBOX: { className: "AgentSandbox", useSQLite: true },
          // TEST-ONLY: SubAgent is a facet-only class (no wrangler.jsonc
          // binding — it's only ever reached via getSubAgentByName from a
          // parent ThinkThreadAgent). This binding lets integration tests
          // drive it directly in-pool without a real facet parent call.
          SUB_AGENT: { className: "SubAgent", useSQLite: true },
        },
        bindings: {
          LOG_LEVEL: "warn",
          APP_NAME: "Nadi",
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

/**
 * Every `test/**` file must be matched by exactly one project.
 *
 * `integrationGroupedIsolatedFiles` was excluded from `integration-fast` and
 * included by no project from the initial commit onward, so 15 files and 108
 * tests never ran — and nothing said so, because tests that never execute do
 * not fail. This runs at config load, so any vitest invocation enforces it.
 *
 * It also rejects a literal include entry naming a file that does not exist:
 * the same list carried `sandbox-thread-store.test.ts`, a path no commit ever
 * contained, and vitest skips a missing path silently.
 */
function assertTestFileProjectCoverage(
  projects: { test?: { name?: string; include?: string[]; exclude?: string[] } }[],
) {
  const problems: string[] = [];
  const testFiles = globSync("test/**/*.test.ts", { cwd: import.meta.dirname }).concat(
    globSync("test/**/*.test.tsx", { cwd: import.meta.dirname }),
  );

  const toRegExp = (pattern: string) =>
    new RegExp(
      "^" +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          // `**/` first, via a placeholder no glob can contain, so the
          // single-star rule below cannot eat it.
          .split("**/")
          .map((part) => part.replace(/\*/g, "[^/]*"))
          .join("(?:.*/)?") +
        "$",
    );

  for (const project of projects) {
    for (const entry of project.test?.include ?? []) {
      if (entry.includes("*")) continue;
      if (!entry.startsWith("test/")) continue;
      if (!existsSync(join(import.meta.dirname, entry))) {
        problems.push(`${entry} is listed by project "${project.test?.name}" but does not exist`);
      }
    }
  }

  for (const file of testFiles) {
    const matches = projects.filter((project) => {
      const include = project.test?.include ?? [];
      const exclude = project.test?.exclude ?? [];
      const included = include.some((pattern) => toRegExp(pattern).test(file));
      const excluded = exclude.some((pattern) => toRegExp(pattern).test(file));
      return included && !excluded;
    });
    if (matches.length === 0) {
      problems.push(`${file} matches NO project and will never run`);
    } else if (matches.length > 1) {
      problems.push(
        `${file} matches ${matches.length} projects (${matches.map((m) => m.test?.name).join(", ")})`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error("vitest project coverage guard failed:\n  - " + problems.join("\n  - "));
  }
}

function assertedProjects<
  T extends { test?: { name?: string; include?: string[]; exclude?: string[] } }[],
>(...projects: T): T {
  assertTestFileProjectCoverage(projects);
  return projects;
}

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./web/src", import.meta.url)),
      luxon: luxonEntry,
    },
  },
  test: {
    projects: assertedProjects(
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          exclude: [
            "**/node_modules/**",
            "**/.git/**",
            "test/unit/web/**/*.test.ts",
            // Import @cloudflare/think, which pulls in a `cloudflare:workers`
            // specifier the plain-node unit environment can't load. These run
            // under the integration workers pool instead.
            ...unitFilesRunByWorkersPool,
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
          name: "integration-grouped",
          include: integrationGroupedIsolatedFiles,
          // Deliberately NO setupFiles. These suites seed the registry once in
          // `beforeAll` and run many tests against that state; the shared
          // setup's per-test registry reset runs after that seeding and wipes
          // the rows out from under them (50 failures, all
          // `think_thread_not_registered`). integration-fast's suites seed
          // per-test instead, which is why they tolerate it.
          isolate: false,
          fileParallelism: false,
          sequence: { groupOrder: 4 },
        },
      },
      {
        plugins: integrationPlugins(),
        test: {
          name: "integration-shared",
          include: integrationSharedIsolateFiles,
          isolate: false,
          fileParallelism: false,
          sequence: { groupOrder: 5 },
        },
      },
      {
        plugins: integrationPlugins(),
        test: {
          name: "integration-isolated",
          include: integrationPristineRegistryFiles,
          maxWorkers: 1,
          sequence: { groupOrder: 6 },
        },
      },
    ),
  },
});
