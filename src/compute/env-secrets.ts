import type { KVWorkspaceSecretsStore, KVWorkspaceSecretsWriter } from "../secrets";
import { validateEnvVarName } from "./env-vars";

const WS_PREFIX = "sbxenv-ws:";
const AG_PREFIX = "sbxenv-ag:";
const ENV_PREFIX = "sbxenv-env:";

export function buildWorkspaceSecretVarName(name: string): string {
  return `${WS_PREFIX}${name}`;
}

export function buildAgentSecretVarName(agentId: string, name: string): string {
  return `${AG_PREFIX}${agentId}:${name}`;
}

export function buildEnvironmentSecretVarName(environmentId: string, name: string): string {
  return `${ENV_PREFIX}${environmentId}:${name}`;
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

  async listEnvironmentNames(
    workspaceId: string,
    environmentId: string,
  ): Promise<Array<{ name: string; updatedAt: string }>> {
    return this.listByPrefix(workspaceId, `${ENV_PREFIX}${environmentId}:`);
  }

  async setEnvironment(
    workspaceId: string,
    environmentId: string,
    name: string,
    value: string,
  ): Promise<void> {
    await this.writer.ensureWorkspaceDek(workspaceId);
    await this.writer.set(
      workspaceId,
      buildEnvironmentSecretVarName(environmentId, validateEnvVarName(name)),
      value,
    );
  }

  async deleteEnvironment(
    workspaceId: string,
    environmentId: string,
    name: string,
  ): Promise<boolean> {
    return this.writer.delete(workspaceId, buildEnvironmentSecretVarName(environmentId, name));
  }

  async getEnvironmentValues(
    workspaceId: string,
    environmentId: string,
    names: string[],
  ): Promise<Record<string, string>> {
    return this.getValues(workspaceId, names, (n) =>
      buildEnvironmentSecretVarName(environmentId, n),
    );
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
