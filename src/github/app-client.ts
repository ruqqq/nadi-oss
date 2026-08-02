import type { GithubAppConfig } from "./config";
import { createAppJwt } from "./jwt";

const API = "https://api.github.com";
const GH_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "nadi",
} as const;

export interface InstallationRepo {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  cloneUrl: string;
  private: boolean;
}

export class GithubInstallationGoneError extends Error {
  constructor(
    readonly installationId: number,
    readonly status: number,
  ) {
    super(`github_installation_gone_${installationId}_${status}`);
    this.name = "GithubInstallationGoneError";
  }
}

interface Deps {
  config: GithubAppConfig;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

export class GithubAppClient {
  private readonly config: GithubAppConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;

  constructor(deps: Deps) {
    this.config = deps.config;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  private async appJwt(): Promise<string> {
    return createAppJwt(this.config, this.nowMs());
  }

  private async doFetch(input: string, init?: RequestInit): Promise<Response> {
    const fetchImpl = this.fetchImpl; // detach: call as a plain function, never a method
    return fetchImpl(input, init);
  }

  async mintInstallationToken(
    installationId: number,
    opts: { repositories: string[]; permissions: Record<string, string> },
  ): Promise<{ token: string; expiresAt: string }> {
    const jwt = await this.appJwt();
    const res = await this.doFetch(`${API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: { ...GH_HEADERS, Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ repositories: opts.repositories, permissions: opts.permissions }),
    });
    if (res.status === 403 || res.status === 404 || res.status === 410) {
      throw new GithubInstallationGoneError(installationId, res.status);
    }
    if (!res.ok) throw new Error(`github_mint_failed_${res.status}`);
    const body = (await res.json()) as { token: string; expires_at: string };
    return { token: body.token, expiresAt: body.expires_at };
  }

  async getInstallation(installationId: number): Promise<{
    accountLogin: string;
    accountType: "org" | "user";
    repositorySelection: "all" | "selected";
  }> {
    const jwt = await this.appJwt();
    const res = await this.doFetch(`${API}/app/installations/${installationId}`, {
      headers: { ...GH_HEADERS, Authorization: `Bearer ${jwt}` },
    });
    if (res.status === 403 || res.status === 404 || res.status === 410) {
      throw new GithubInstallationGoneError(installationId, res.status);
    }
    if (!res.ok) throw new Error(`github_get_installation_failed_${res.status}`);
    const body = (await res.json()) as {
      account: { login: string; type: string };
      repository_selection: "all" | "selected";
    };
    return {
      accountLogin: body.account.login,
      accountType: body.account.type === "Organization" ? "org" : "user",
      repositorySelection: body.repository_selection,
    };
  }

  async exchangeOAuthCode(code: string): Promise<{ accessToken: string }> {
    const res = await this.doFetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { ...GH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
      }),
    });
    if (!res.ok) throw new Error(`github_oauth_exchange_failed_${res.status}`);
    const body = (await res.json()) as { access_token?: string; error?: string };
    if (!body.access_token)
      throw new Error(`github_oauth_exchange_failed_${body.error ?? "no_token"}`);
    return { accessToken: body.access_token };
  }

  async listInstallationRepositories(
    installationId: number,
    opts?: { page?: number; perPage?: number },
  ): Promise<{ repositories: InstallationRepo[]; hasNextPage: boolean }> {
    const { token } = await this.mintInstallationToken(installationId, {
      repositories: [],
      permissions: { metadata: "read" },
    });
    const page = opts?.page ?? 1;
    const perPage = opts?.perPage ?? 100;
    const res = await this.doFetch(
      `${API}/installation/repositories?per_page=${perPage}&page=${page}`,
      { headers: { ...GH_HEADERS, Authorization: `Bearer ${token}` } },
    );
    if (res.status === 403 || res.status === 404 || res.status === 410) {
      throw new GithubInstallationGoneError(installationId, res.status);
    }
    if (!res.ok) throw new Error(`github_list_repositories_failed_${res.status}`);
    const body = (await res.json()) as {
      repositories: Array<{
        id: number;
        name: string;
        full_name: string;
        owner: { login: string };
        default_branch: string;
        clone_url: string;
        private: boolean;
      }>;
    };
    const link = res.headers.get("Link") ?? "";
    return {
      repositories: body.repositories.map((r) => ({
        id: r.id,
        fullName: r.full_name,
        owner: r.owner.login,
        name: r.name,
        defaultBranch: r.default_branch,
        cloneUrl: r.clone_url,
        private: r.private,
      })),
      hasNextPage: /rel="next"/.test(link),
    };
  }

  async getAuthenticatedUser(userToken: string): Promise<{ login: string; id: number }> {
    const res = await this.doFetch(`${API}/user`, {
      headers: { ...GH_HEADERS, Authorization: `Bearer ${userToken}` },
    });
    if (!res.ok) throw new Error(`github_get_user_failed_${res.status}`);
    const body = (await res.json()) as { login: string; id: number };
    return { login: body.login, id: body.id };
  }
}
