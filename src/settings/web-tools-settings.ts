import type { Env } from "../env";
import { createWorkspaceSecretsServices } from "../secrets";

const EXA_API_KEY_SECRET_NAME = "exa_api_key";

export interface WebToolsSettingsView {
  exaSecretPresent: boolean;
  exaSecretUpdatedAt: string | null;
  webSearchEnabled: boolean;
}

export async function getWebToolsSettingsView(
  env: Env,
  workspaceId: string,
): Promise<WebToolsSettingsView> {
  const { writer } = createWorkspaceSecretsServices(env);
  const metadata = await writer.getMetadata(workspaceId, EXA_API_KEY_SECRET_NAME);
  const exaSecretPresent = metadata !== null;
  return {
    exaSecretPresent,
    exaSecretUpdatedAt: metadata?.updated_at ?? null,
    webSearchEnabled: exaSecretPresent,
  };
}

export async function saveExaApiKey(
  env: Env,
  workspaceId: string,
  value: string,
): Promise<WebToolsSettingsView> {
  if (!value.trim()) {
    throw new Error("secret_value_required");
  }

  const { writer } = createWorkspaceSecretsServices(env);
  await writer.ensureWorkspaceDek(workspaceId);
  await writer.set(workspaceId, EXA_API_KEY_SECRET_NAME, value);
  return getWebToolsSettingsView(env, workspaceId);
}

export async function deleteExaApiKey(
  env: Env,
  workspaceId: string,
): Promise<WebToolsSettingsView> {
  const { writer } = createWorkspaceSecretsServices(env);
  await writer.delete(workspaceId, EXA_API_KEY_SECRET_NAME);
  return getWebToolsSettingsView(env, workspaceId);
}
