import type { Env } from "../env";
import { createWorkspaceSecretsServices } from "../secrets";
import { ComputeEnvSecretsStore } from "./env-secrets";
import { mergeComputeEnv } from "./env-vars";
import type { EffectiveComputeConfig } from "./types";

/**
 * Pure merge with the design's four-layer precedence (low to high):
 * workspace editable < agent editable < workspace secrets < agent secrets.
 *
 * The `environment` layer between them is GONE, not defaulted to empty. It used
 * to be the workbench, and the agent carries what the workbench carried now:
 * keeping both would have carried the same values in two slots, and the one
 * place they could differ — a name set in both — would have silently flipped
 * which one wins.
 */
export function mergeSecretValuesIntoEnv(input: {
  workspaceEditable: Record<string, string>;
  agentEditable: Record<string, string>;
  workspaceSecrets: Record<string, string>;
  agentSecrets: Record<string, string>;
}): Record<string, string> {
  return mergeComputeEnv(
    input.workspaceEditable,
    input.agentEditable,
    input.workspaceSecrets,
    input.agentSecrets,
  );
}

/**
 * Decrypts the workspace + agent secret env-var values and merges them with the
 * already-resolved editable vars from `config.editableEnv`. Fetched fresh at
 * compute-acquisition time so secret values never live in the cached config.
 */
export async function resolveComputeEnvVars(input: {
  env: Env;
  workspaceId: string;
  agentId: string;
  config: EffectiveComputeConfig;
}): Promise<Record<string, string>> {
  const { store, writer } = createWorkspaceSecretsServices(input.env);
  const secretStore = new ComputeEnvSecretsStore({ store, writer });
  const [wsNames, agNames] = await Promise.all([
    secretStore.listWorkspaceNames(input.workspaceId),
    secretStore.listAgentNames(input.workspaceId, input.agentId),
  ]);
  const [workspaceSecrets, agentSecrets] = await Promise.all([
    secretStore.getWorkspaceValues(
      input.workspaceId,
      wsNames.map((n) => n.name),
    ),
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
    // re-applied here in its own (higher) slot so it still beats the workspace
    // layer explicitly, even though it is also present in `editableEnv`.
    workspaceEditable: input.config.editableEnv,
    agentEditable: input.config.agentEditableEnv,
    workspaceSecrets,
    agentSecrets,
  });
}
