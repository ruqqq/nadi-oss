import type { Env } from "../env";
import { createWorkspaceSecretsServices } from "../secrets";
import { ComputeEnvSecretsStore } from "./env-secrets";
import { mergeComputeEnv } from "./env-vars";
import type { EffectiveComputeConfig } from "./types";

/**
 * Pure merge with the design's six-layer precedence (low to high):
 * workspace editable < environment editable < agent editable <
 * workspace secrets < environment secrets < agent secrets.
 */
export function mergeSecretValuesIntoEnv(input: {
  workspaceEditable: Record<string, string>;
  environmentEditable: Record<string, string>;
  agentEditable: Record<string, string>;
  workspaceSecrets: Record<string, string>;
  environmentSecrets: Record<string, string>;
  agentSecrets: Record<string, string>;
}): Record<string, string> {
  return mergeComputeEnv(
    input.workspaceEditable,
    input.environmentEditable,
    input.agentEditable,
    input.workspaceSecrets,
    input.environmentSecrets,
    input.agentSecrets,
  );
}

/**
 * Decrypts the workspace + environment + agent secret env-var values and merges
 * them with the already-resolved editable vars from `config.editableEnv` /
 * `config.environmentEditableEnv`. Fetched fresh at compute-acquisition time so
 * secret values never live in the cached config.
 */
export async function resolveComputeEnvVars(input: {
  env: Env;
  workspaceId: string;
  agentId: string;
  environmentId: string | null;
  config: EffectiveComputeConfig;
}): Promise<Record<string, string>> {
  const { store, writer } = createWorkspaceSecretsServices(input.env);
  const secretStore = new ComputeEnvSecretsStore({ store, writer });
  const envId = input.environmentId;
  const [wsNames, envNames, agNames] = await Promise.all([
    secretStore.listWorkspaceNames(input.workspaceId),
    envId ? secretStore.listEnvironmentNames(input.workspaceId, envId) : Promise.resolve([]),
    secretStore.listAgentNames(input.workspaceId, input.agentId),
  ]);
  const [workspaceSecrets, environmentSecrets, agentSecrets] = await Promise.all([
    secretStore.getWorkspaceValues(
      input.workspaceId,
      wsNames.map((n) => n.name),
    ),
    envId
      ? secretStore.getEnvironmentValues(
          input.workspaceId,
          envId,
          envNames.map((n) => n.name),
        )
      : Promise.resolve({}),
    secretStore.getAgentValues(
      input.workspaceId,
      input.agentId,
      agNames.map((n) => n.name),
    ),
  ]);
  return mergeSecretValuesIntoEnv({
    // `editableEnv` is workspace+agent pre-collapsed (agent wins within it) —
    // that combined map is needed elsewhere (compute-tools.ts) as the full
    // editable-name list, so it stays in the lowest slot. Agent editable is
    // re-applied here in its own (higher) slot so it correctly beats
    // environment-editable, even though it's also present in `editableEnv`.
    // Net effect: workspace < environment < agent.
    workspaceEditable: input.config.editableEnv,
    environmentEditable: input.config.environmentEditableEnv,
    agentEditable: input.config.agentEditableEnv,
    workspaceSecrets,
    environmentSecrets,
    agentSecrets,
  });
}
