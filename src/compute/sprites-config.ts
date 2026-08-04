import type { Env } from "../env";
import { createWorkspaceSecretsServices } from "../secrets";
import type { SpritesProviderConfig } from "./types";

export type SpritesConfigurationMode = "system" | "byok";

export interface ResolvedSpritesConfiguration {
  mode: SpritesConfigurationMode;
  apiKey: string | null;
}

function presentCredential(value: string | null | undefined): string | null {
  return value?.trim() ? value : null;
}

export async function resolveSpritesConfiguration(input: {
  env: Env;
  workspaceId: string;
  providerConfig: SpritesProviderConfig;
}): Promise<ResolvedSpritesConfiguration> {
  const { store, writer } = createWorkspaceSecretsServices(input.env);
  const metadata = await writer.getMetadata(
    input.workspaceId,
    input.providerConfig.apiKeySecretName,
  );
  if (metadata === null) {
    return {
      mode: "system",
      apiKey: presentCredential(input.env.SPRITES_API_KEY),
    };
  }

  return {
    mode: "byok",
    apiKey: presentCredential(
      await store.get(input.workspaceId, input.providerConfig.apiKeySecretName),
    ),
  };
}
