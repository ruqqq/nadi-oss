import { DurableObjectOAuthClientProvider } from "agents";
import type { Env } from "../env";
import {
  getMcpOAuthClient,
  getMcpOAuthTokens,
  putMcpOAuthClient,
  putMcpOAuthTokens,
} from "./oauth-store";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthTokens,
} from "./oauth-types";

/**
 * KV-backed OAuth provider for MCP servers. Subclasses the SDK's
 * DurableObjectOAuthClientProvider (which already implements PKCE/state/redirect
 * + per-DO storage) and overrides ONLY the credential accessors so that tokens
 * and client registrations are also mirrored into the central, encrypted
 * workspace KV store.
 *
 * Read path: KV first (the shared, cross-thread source of truth), falling back
 * to the base DO storage. Write path: base DO storage first, then KV.
 *
 * This is the single injection point used by BOTH:
 *   - WorkspaceMcpAgent (consent flow): saveClientInformation/saveTokens mirror
 *     the just-exchanged credentials to KV after the callback.
 *   - ThreadAgentV2 (live path): tokens() supplies the stored bearer so
 *     addMcpServer short-circuits to READY without re-consent; saveTokens()
 *     keeps KV current on the 401→refresh writeback.
 *
 * `serverId` is assigned by the SDK immediately after construction
 * (Agent.addMcpServer); the base getter THROWS before it is set, so every
 * accessor guards via currentServerId() and returns undefined when unset.
 * `workspaceId` is resolved lazily (the resolver may legitimately return
 * undefined during the pre-onStart storage-restore pass, in which case we fall
 * back to base DO storage and behave exactly as a non-mirroring provider).
 */
export class KvMcpOAuthProvider extends DurableObjectOAuthClientProvider {
  constructor(
    storage: DurableObjectStorage,
    clientName: string,
    baseRedirectUrl: string,
    private readonly env: Env,
    private readonly resolveWorkspaceId: () => Promise<string | undefined>,
  ) {
    super(storage, clientName, baseRedirectUrl);
  }

  private currentServerId(): string | undefined {
    try {
      return this.serverId;
    } catch {
      return undefined;
    }
  }

  override async tokens(): Promise<OAuthTokens | undefined> {
    const serverId = this.currentServerId();
    if (serverId) {
      const workspaceId = await this.resolveWorkspaceId();
      if (workspaceId) {
        try {
          const fromKv = await getMcpOAuthTokens(this.env, workspaceId, serverId);
          if (fromKv) return fromKv;
        } catch {
          return super.tokens();
        }
      }
    }
    return super.tokens();
  }

  override async saveTokens(tokens: OAuthTokens): Promise<void> {
    await super.saveTokens(tokens);
    const serverId = this.currentServerId();
    if (!serverId) return;
    const workspaceId = await this.resolveWorkspaceId();
    if (!workspaceId) return;
    try {
      await putMcpOAuthTokens(this.env, workspaceId, serverId, tokens);
    } catch {
      /* best-effort KV mirror — DO storage already persisted */
    }
  }

  override async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const serverId = this.currentServerId();
    if (serverId) {
      const workspaceId = await this.resolveWorkspaceId();
      if (workspaceId) {
        try {
          const fromKv = await getMcpOAuthClient(this.env, workspaceId, serverId);
          if (fromKv) {
            // Keep the base provider's clientId in sync. The base sets it inside
            // saveClientInformation; returning a KV client bypasses that, so the
            // SDK's later this.clientId access (PKCE verifier key, token storage)
            // would otherwise throw "Trying to access clientId before it was set".
            this.clientId = fromKv.client_id;
            return fromKv;
          }
        } catch {
          return super.clientInformation();
        }
      }
    }
    return super.clientInformation();
  }

  override async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await super.saveClientInformation(info);
    const serverId = this.currentServerId();
    if (!serverId) return;
    const workspaceId = await this.resolveWorkspaceId();
    if (!workspaceId) return;
    try {
      await putMcpOAuthClient(this.env, workspaceId, serverId, info);
    } catch {
      /* best-effort KV mirror — DO storage already persisted */
    }
  }
}
