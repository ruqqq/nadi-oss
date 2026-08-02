import type { Env } from "../env";
import { createWorkspaceSecretsServices } from "../secrets";
import type { ComputeResourceProfile, DaytonaProviderConfig, EnvironmentSource } from "./types";

export const SYSTEM_DAYTONA_PROFILES = Object.freeze({
  small: Object.freeze({ kind: "snapshot", value: "nadi-small" } as const),
  medium: Object.freeze({ kind: "snapshot", value: "nadi-medium" } as const),
}) satisfies Readonly<Record<ComputeResourceProfile, Readonly<EnvironmentSource>>>;

export type DaytonaConfigurationMode = "system" | "byok";

export interface ResolvedDaytonaConfiguration {
  mode: DaytonaConfigurationMode;
  apiKey: string | null;
  apiUrl: string | null;
  target: string | null;
  profiles: Record<ComputeResourceProfile, EnvironmentSource | null>;
}

function presentCredential(value: string | null | undefined): string | null {
  return value?.trim() ? value : null;
}

export async function resolveDaytonaConfiguration(input: {
  env: Env;
  workspaceId: string;
  providerConfig: DaytonaProviderConfig;
}): Promise<ResolvedDaytonaConfiguration> {
  const { store, writer } = createWorkspaceSecretsServices(input.env);
  const metadata = await writer.getMetadata(
    input.workspaceId,
    input.providerConfig.apiKeySecretName,
  );
  if (metadata === null) {
    return {
      mode: "system",
      apiKey: presentCredential(input.env.DAYTONA_API_KEY),
      apiUrl: null,
      target: null,
      profiles: SYSTEM_DAYTONA_PROFILES,
    };
  }

  return {
    mode: "byok",
    apiKey: presentCredential(
      await store.get(input.workspaceId, input.providerConfig.apiKeySecretName),
    ),
    apiUrl: input.providerConfig.apiUrl,
    target: input.providerConfig.target,
    profiles: input.providerConfig.profiles,
  };
}
