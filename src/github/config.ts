import type { Env } from "../env";

export interface GithubAppConfig {
  appId: string;
  privateKeyPkcs8Pem: string;
  clientId: string;
  clientSecret: string;
  slug: string;
}

/** Returns the App config only when every field is present, else null (feature gate). */
export function getGithubAppConfig(env: Env): GithubAppConfig | null {
  const appId = env.GITHUB_APP_ID;
  const privateKeyPkcs8Pem = env.GITHUB_APP_PRIVATE_KEY;
  const clientId = env.GITHUB_APP_CLIENT_ID;
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET;
  const slug = env.GITHUB_APP_SLUG;
  if (!appId || !privateKeyPkcs8Pem || !clientId || !clientSecret || !slug) return null;
  return { appId, privateKeyPkcs8Pem, clientId, clientSecret, slug };
}
