/**
 * Env extends the generated Cloudflare.Env with secrets that are set via
 * `wrangler secret put` (not declared in wrangler.jsonc vars, so not
 * included in the auto-generated type). These secrets are always available
 * at runtime but TypeScript must be told about them here.
 */
import type { ThinkThreadAgent } from "./agent/think-thread-agent";
import type { WorkspaceMcpAgent } from "./agent/workspace-mcp-agent";
import type { ComputeBackend } from "./compute/backend";
import type { NadiSandboxMedium, NadiSandboxSmall } from "./compute/cloudflare-sandbox-classes";

export interface Env extends Cloudflare.Env {
  THINK_THREAD_AGENT: DurableObjectNamespace<ThinkThreadAgent>;
  WORKSPACE_MCP_AGENT: DurableObjectNamespace<WorkspaceMcpAgent>;

  /**
   * Which edition this deploy is: `cloud` for the hosted service, anything else
   * (including unset) for a self-hosted instance. Read via `resolveEdition` /
   * `editionCapabilities` in `src/edition.ts`, never compared inline. Optional
   * because only the cloud deploy sets it.
   */
  NADI_EDITION?: string;

  /**
   * Host this deployment serves as its canonical origin, e.g. "app.example.com".
   * With LEGACY_HOSTS, requests to an old hostname 308 here. Unset (the
   * self-hosted default) disables the redirect entirely. See
   * `src/http/canonical-host.ts`.
   */
  CANONICAL_HOST?: string;

  /** Comma-separated hostnames this deployment has moved away from. */
  LEGACY_HOSTS?: string;

  /** Operator-managed Daytona credential. Workspace keys take precedence. */
  DAYTONA_API_KEY?: string;

  /**
   * Compute provider a NEW workspace's default sandbox is provisioned with.
   * Unset/blank → `cloudflare` (the production default). Set to `mock` in local
   * dev (`.dev.vars`) so the sandbox runs in-memory with no credentials,
   * containers, or R2. Resolved via `resolveDefaultSandboxProvider`.
   */
  DEFAULT_SANDBOX_PROVIDER?: string;

  /**
   * Voice dictation in the composer. Read with `isTruthyFlag`. When off, the mic
   * button does not render and VoiceAgent.beforeCallStart() refuses the call, so
   * no audio is billed even against a forged socket.
   */
  VOICE_INPUT_ENABLED: string;

  /**
   * Process watchers and subagent dispatch. Unset is disabled; resolve only
   * through `backgroundWorkEnabled` so runtime enforcement and bootstrap agree.
   */
  BACKGROUND_WORK_ENABLED?: string;

  /** Per-user dictation DO. Instance name is always the session user id. */
  VOICE_AGENT: DurableObjectNamespace<import("./agent/voice-agent").VoiceAgent>;

  /**
   * Cloudflare Sandbox compute backend: two container-backed Durable Object
   * namespaces, one per instance size (see wrangler.jsonc `containers`).
   * Optional here (not required) because `worker-configuration.d.ts` cannot be
   * regenerated from this checkout (no complete `.dev.vars`); these bindings
   * are real and always present once `pnpm run types` picks up the new
   * wrangler.jsonc entries in a complete environment. Drop the `?` once that
   * regeneration lands.
   */
  NADI_SANDBOX_SMALL?: DurableObjectNamespace<NadiSandboxSmall>;
  NADI_SANDBOX_MEDIUM?: DurableObjectNamespace<NadiSandboxMedium>;

  /**
   * R2 bucket the Cloudflare Sandbox SDK backs `createBackup`/`restoreBackup`
   * with when called with `localBucket: true` (required in local dev; resolved
   * directly by the DO instead of a presigned URL). Optional for the same
   * pending-regeneration reason as the sandbox namespaces above.
   */
  BACKUP_BUCKET?: R2Bucket;

  /**
   * Bucket name and account id used to presign Sandbox backup URLs in
   * production (paired with the R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY secrets
   * below). Set as wrangler `vars`, not secrets — not sensitive. Optional for
   * the same pending-regeneration reason as the sandbox namespaces above.
   */
  BACKUP_BUCKET_NAME?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;

  /**
   * HMAC signing secret for tool-approval requests.
   * Prevents client-forged tool approval payloads.
   * Set via `wrangler secret put TOOL_APPROVAL_SECRET`.
   * Required in vitest integration tests via miniflare `bindings`.
   */
  TOOL_APPROVAL_SECRET: string;

  /**
   * Session secret for Better Auth.
   * Prevents session token forgery.
   * Set via `wrangler secret put BETTER_AUTH_SECRET`.
   * Required in vitest integration tests via miniflare `bindings`.
   */
  BETTER_AUTH_SECRET: string;

  /**
   * Cloudflare Email Service binding for Better Auth OTP delivery.
   */
  EMAIL: SendEmail;
  AUTH_EMAIL_FROM: string;
  EMAIL_DELIVERY_DISABLED?: string;

  /** Exact comma-separated emails allowed to read the private feedback inbox. */
  FEEDBACK_ADMIN_EMAILS?: string;

  /**
   * KV-backed encrypted workspace secret storage.
   * The KEK is a base64-encoded 32-byte AES-GCM key set via Wrangler secret
   * or `.dev.vars`; secret payloads are stored in the SECRETS_KV namespace.
   */
  SECRETS_KV: KVNamespace;
  SECRETS_STORE_KEK_RAW_B64: string;

  /**
   * SigV4 credentials for presigning attachment URLs against the R2 S3 endpoint.
   * Set via `wrangler secret put R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`.
   */
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;

  /**
   * PostHog project key for backend instrumentation. When unset, PostHog
   * capture is a no-op. Set via `wrangler secret put POSTHOG_KEY`.
   */
  POSTHOG_KEY: string;

  /**
   * Fallback context window, in tokens, for a model that has no entry in the
   * static catalog (`src/providers/model-search.ts`). A catalog hit wins, so
   * this is ignored for known models. Every compaction number — the trigger,
   * the truncation caps, the overflow guards — is derived from the window, so
   * this changes the whole budget, not just one threshold.
   * Optional: invalid or absent falls back to DEFAULT_CONTEXT_WINDOW (128k).
   */
  THINK_COMPACT_AFTER_TOKENS?: string;

  /** GitHub App integration (feature gates off unless all five are set).
   * Secrets — set via `wrangler secret put`. PRIVATE_KEY must be PKCS#8
   * (BEGIN PRIVATE KEY). */
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  /** Non-secret — live in `wrangler.jsonc` vars (App id, OAuth client id, and
   * app slug are all public). Typed here because this checkout can't regenerate
   * `worker-configuration.d.ts`; drop these three once that regeneration lands
   * and Cloudflare.Env declares them. */
  GITHUB_APP_ID?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_SLUG?: string;

  /**
   * Optional clean-egress proxy token for the Codex (openai-oauth) provider.
   * Some providers refuse Cloudflare Worker egress — ChatGPT's backend 403s it
   * (Cloudflare Bot Management) and OpenCode Zen throttles free models per
   * egress IP. The proxy route is per-workspace
   * (`provider_configs.config_json.proxyUrl`). When that route and this token
   * are both set, the provider's requests go through the exe.dev VM proxy gated
   * by this VM bearer token. Set via `wrangler secret put EGRESS_PROXY_TOKEN`.
   * May be absent at runtime (the proxy is opt-in); resolveEgressProxy guards on
   * its presence before use.
   */
  EGRESS_PROXY_TOKEN: string;

  /**
   * Feature flag for testing direct Cloudflare Worker egress to ChatGPT's Codex
   * backend. False/unset keeps using the workspace proxy route with
   * EGRESS_PROXY_TOKEN when configured; true bypasses the proxy so failures can
   * be measured in logs.
   */
  CODEX_DIRECT_ENABLED: string;

  /**
   * Token gating the /api/debug/* endpoints. When set, a request must send a
   * matching `x-debug-token` header; when unset (e.g. in tests), every debug
   * route 404s. Set via `wrangler secret put DEBUG_TOKEN` and `.dev.vars`.
   */
  DEBUG_TOKEN: string;

  /**
   * Workspace the /api/debug/* endpoints act on when the request omits
   * `?workspaceId=`. Falls back to DEFAULT_WORKSPACE_ID ("default"), which is a
   * REAL live workspace — point this at a dedicated debug workspace so debug
   * runs stop touching tenant data.
   */
  DEBUG_WORKSPACE_ID?: string;

  /**
   * Max concurrently-live Cloudflare containers per workspace. Optional:
   * invalid, absent, or non-positive values fall back to
   * DEFAULT_MAX_ACTIVE_CONTAINERS (10).
   */
  MAX_ACTIVE_CONTAINERS_PER_WORKSPACE?: string;

  /**
   * Optional number of hours to retain an idle suspended coding sandbox before
   * expiry cleanup. Invalid or absent values are sanitized by sandbox config.
   */
  CODING_SANDBOX_SUSPEND_TTL_HOURS?: string;

  /**
   * Browser Web Push VAPID configuration. When absent, push delivery is
   * disabled while durable thread indicators still work.
   */
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;

  /**
   * Test-only hook: when set, `POST /api/settings/sandbox/test` uses this
   * factory to construct the ComputeBackend instead of a real
   * DaytonaComputeBackend, so integration tests can exercise the route
   * through `SELF.fetch` with a fake backend instead of hitting the real
   * Daytona API. Must never be set outside tests. Mirrors the
   * THREAD_RUNTIME_DEFAULT test-override pattern: mutate the
   * `cloudflare:test` `env` object directly before `SELF.fetch` and restore
   * it afterward.
   */
  COMPUTE_TEST_BACKEND_FACTORY?: (config: {
    apiKey: string;
    apiUrl: string | null;
    target: string | null;
    source: { image?: string; snapshot?: string };
  }) => ComputeBackend;

  /** Test-only hook for the Daytona reset's registry update. */
  COMPUTE_TEST_RESET_DAYTONA_SETTINGS?: (workspaceId: string) => Promise<void>;

  /**
   * Cloudflare Browser Rendering binding. Used by web_fetch's browser
   * fallback for JS-heavy pages via the binding's quickAction helper
   * (markdown/content). Optional: when unbound, web_fetch runs direct-only.
   */
  BROWSER: BrowserRun;

  /**
   * Workers AI. Attachment text extraction is gated on this binding's presence:
   * unbound → the extractor is never constructed and attachments a text-only
   * model cannot read fall back to the getAttachmentUrl stub. `Cloudflare.Env`
   * types it as required, so the runtime guard casts to `Ai | undefined`.
   */
}

export type BrowserRunBinding = BrowserRun;
