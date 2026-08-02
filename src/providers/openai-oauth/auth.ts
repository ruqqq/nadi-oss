const REFRESH_URL = "https://auth.openai.com/oauth/token";
const REFRESH_SKEW_MS = 60_000;
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

type FetchLike = typeof fetch;

export interface OpenAIOAuthTokens {
  accessToken: string | undefined;
  refreshToken: string | undefined;
  accountId: string | undefined;
  clientId: string | undefined;
  expiresAt: number | undefined;
  raw: Record<string, unknown>;
}

export interface OpenAIOAuthAuthManagerOptions {
  load: () => Promise<string | null>;
  save: (value: string) => Promise<void>;
  fetch?: FetchLike;
}

export class OpenAIOAuthAuthManager {
  private tokens?: OpenAIOAuthTokens;
  private refreshInFlight: Promise<OpenAIOAuthTokens> | undefined;

  constructor(private readonly options: OpenAIOAuthAuthManagerOptions) {}

  async getAuthHeaders(): Promise<Record<string, string>> {
    const tokens = await this.getFreshTokens();
    if (!tokens.accessToken) {
      throw new Error("openai_oauth_access_token_missing");
    }
    if (!tokens.accountId) {
      throw new Error("openai_oauth_account_id_missing");
    }

    return {
      Authorization: `Bearer ${tokens.accessToken}`,
      "chatgpt-account-id": tokens.accountId,
      "OpenAI-Beta": "responses=experimental",
    };
  }

  private async getFreshTokens(): Promise<OpenAIOAuthTokens> {
    const tokens = this.tokens ?? (await this.loadTokens());
    if (!shouldRefresh(tokens)) {
      this.tokens = tokens;
      return tokens;
    }
    if (!tokens.refreshToken) {
      this.tokens = tokens;
      return tokens;
    }

    // Single-flight: collapse concurrent refreshes onto one network call so we
    // never POST the same rotating refresh token twice (the second replay would
    // be rejected with openai_oauth_refresh_failed:401). The assignment below is
    // synchronous relative to the event loop, so the check-then-set is atomic.
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.runRefresh(tokens);
    }
    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = undefined;
    }
  }

  private async runRefresh(tokens: OpenAIOAuthTokens): Promise<OpenAIOAuthTokens> {
    const refreshed = await refreshTokens(tokens, this.options.fetch ?? fetch);
    this.tokens = refreshed;
    await this.options.save(stringifyOpenAIOAuthTokens(refreshed));
    return refreshed;
  }

  private async loadTokens(): Promise<OpenAIOAuthTokens> {
    const raw = await this.options.load();
    if (!raw) {
      throw new Error("openai_oauth_secret_missing");
    }
    return parseOpenAIOAuthTokens(raw);
  }
}

export function parseOpenAIOAuthTokens(raw: string): OpenAIOAuthTokens {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("openai_oauth_token_json_invalid");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("openai_oauth_token_json_invalid");
  }

  const obj = parsed as Record<string, unknown>;
  // A persisted secret can carry the rotated values at the top level AND a stale
  // copy under a nested `tokens` block (the shape produced after refreshing a
  // pasted Codex auth.json). Top-level always wins so we never replay a stale,
  // already-rotated refresh token.
  const nested =
    typeof obj.tokens === "object" && obj.tokens !== null
      ? (obj.tokens as Record<string, unknown>)
      : {};
  const str = (key: string): string | undefined => readString(obj, key) ?? readString(nested, key);
  const num = (key: string): number | undefined => readNumber(obj, key) ?? readNumber(nested, key);

  const accessToken = str("access_token") ?? str("accessToken");
  const refreshToken = str("refresh_token") ?? str("refreshToken");
  const accountId =
    str("account_id") ?? str("accountId") ?? str("chatgpt_account_id") ?? str("chatgptAccountId");
  const clientId = str("client_id") ?? str("clientId");
  const expiresAt = num("expires_at") ?? num("expiresAt") ?? parseLastRefresh(obj);

  return { accessToken, refreshToken, accountId, clientId, expiresAt, raw: obj };
}

export function stringifyOpenAIOAuthTokens(tokens: OpenAIOAuthTokens): string {
  const raw = { ...tokens.raw };
  // Keep a nested `tokens` block (Codex auth.json shape) in sync so storage never
  // holds a stale, rotated-away refresh token alongside the fresh top-level copy.
  if (typeof raw.tokens === "object" && raw.tokens !== null) {
    raw.tokens = {
      ...(raw.tokens as Record<string, unknown>),
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      account_id: tokens.accountId,
    };
  }
  return JSON.stringify({
    ...raw,
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    account_id: tokens.accountId,
    client_id: tokens.clientId,
    expires_at: tokens.expiresAt,
    last_refresh: new Date().toISOString(),
  });
}

function shouldRefresh(tokens: OpenAIOAuthTokens): boolean {
  if (!tokens.accessToken) return true;
  if (!tokens.expiresAt) return false;
  return tokens.expiresAt <= Date.now() + REFRESH_SKEW_MS;
}

async function refreshTokens(tokens: OpenAIOAuthTokens, fetchImpl: FetchLike) {
  const response = await fetchImpl(REFRESH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: tokens.clientId ?? DEFAULT_CLIENT_ID,
      scope: "openid profile email offline_access",
    }),
  });
  if (!response.ok) {
    throw new Error(`openai_oauth_refresh_failed:${response.status}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  return {
    ...tokens,
    accessToken: readString(body, "access_token") ?? tokens.accessToken,
    refreshToken: readString(body, "refresh_token") ?? tokens.refreshToken,
    accountId:
      readString(body, "account_id") ??
      readString(body, "accountId") ??
      readString(body, "chatgpt_account_id") ??
      tokens.accountId,
    clientId: readString(body, "client_id") ?? readString(body, "clientId") ?? tokens.clientId,
    expiresAt:
      typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : tokens.expiresAt,
    raw: {
      ...tokens.raw,
      ...body,
    },
  };
}

function parseLastRefresh(obj: Record<string, unknown>): number | undefined {
  const lastRefresh = readString(obj, "last_refresh");
  if (!lastRefresh) return undefined;
  const parsed = Date.parse(lastRefresh);
  if (Number.isNaN(parsed)) return undefined;
  return parsed + 50 * 60 * 1000;
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  return typeof value === "number" ? value : undefined;
}
