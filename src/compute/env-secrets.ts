import type { KVWorkspaceSecretsStore, KVWorkspaceSecretsWriter } from "../secrets";
import { validateEnvVarName } from "./env-vars";

const WS_PREFIX = "sbxenv-ws:";
const AG_PREFIX = "sbxenv-ag:";
// `sbxenv-env:<workbenchId>:` is GONE. Its values were re-encrypted under
// `sbxenv-ag:<agentId>:` by scripts/rekey-workbench-secrets.mjs — a decrypt and
// re-encrypt, not a rename, because `secretAad(workspaceId, name)` authenticates
// the variable NAME and the name embeds the scope id. Nothing reads the old
// prefix any more; the script's --verify mode is what proves nothing needs to.

export function buildWorkspaceSecretVarName(name: string): string {
  return `${WS_PREFIX}${name}`;
}

export function buildAgentSecretVarName(agentId: string, name: string): string {
  return `${AG_PREFIX}${agentId}:${name}`;
}

export class ComputeEnvSecretsStore {
  private readonly store: KVWorkspaceSecretsStore;
  private readonly writer: KVWorkspaceSecretsWriter;

  constructor(deps: { store: KVWorkspaceSecretsStore; writer: KVWorkspaceSecretsWriter }) {
    this.store = deps.store;
    this.writer = deps.writer;
  }

  async listWorkspaceNames(
    workspaceId: string,
  ): Promise<Array<{ name: string; updatedAt: string }>> {
    return this.listByPrefix(workspaceId, WS_PREFIX);
  }

  async listAgentNames(
    workspaceId: string,
    agentId: string,
  ): Promise<Array<{ name: string; updatedAt: string }>> {
    return this.listByPrefix(workspaceId, `${AG_PREFIX}${agentId}:`);
  }

  async setWorkspace(workspaceId: string, name: string, value: string): Promise<void> {
    await this.writer.ensureWorkspaceDek(workspaceId);
    await this.writer.set(
      workspaceId,
      buildWorkspaceSecretVarName(validateEnvVarName(name)),
      value,
    );
  }

  async deleteWorkspace(workspaceId: string, name: string): Promise<boolean> {
    return this.writer.delete(workspaceId, buildWorkspaceSecretVarName(name));
  }

  async setAgent(workspaceId: string, agentId: string, name: string, value: string): Promise<void> {
    await this.writer.ensureWorkspaceDek(workspaceId);
    await this.writer.set(
      workspaceId,
      buildAgentSecretVarName(agentId, validateEnvVarName(name)),
      value,
    );
  }

  async deleteAgent(workspaceId: string, agentId: string, name: string): Promise<boolean> {
    return this.writer.delete(workspaceId, buildAgentSecretVarName(agentId, name));
  }

  async getWorkspaceValues(workspaceId: string, names: string[]): Promise<Record<string, string>> {
    return this.getValues(workspaceId, names, (n) => buildWorkspaceSecretVarName(n));
  }

  async getAgentValues(
    workspaceId: string,
    agentId: string,
    names: string[],
  ): Promise<Record<string, string>> {
    return this.getValues(workspaceId, names, (n) => buildAgentSecretVarName(agentId, n));
  }

  private async listByPrefix(
    workspaceId: string,
    prefix: string,
  ): Promise<Array<{ name: string; updatedAt: string }>> {
    const all = await this.writer.listMetadata(workspaceId);
    return all
      .filter((item) => item.name.startsWith(prefix))
      .map((item) => ({ name: item.name.slice(prefix.length), updatedAt: item.updated_at }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private async getValues(
    workspaceId: string,
    names: string[],
    keyFor: (name: string) => string,
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const name of names) {
      const value = await this.store.get(workspaceId, keyFor(name));
      if (value !== null) out[name] = value;
    }
    return out;
  }
}
