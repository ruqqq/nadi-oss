import { describe, expect, it } from "vitest";
import {
  KVWorkspaceSecretsStore,
  KVWorkspaceSecretsWriter,
  importRawKey,
} from "../../../src/secrets";
import { ComputeEnvSecretsStore } from "../../../src/compute/env-secrets";

// Minimal in-memory KVNamespace stand-in.
function fakeKv(): KVNamespace {
  const map = new Map<string, string>();
  return {
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: string) => void map.set(k, v),
    delete: async (k: string) => void map.delete(k),
    list: async ({ prefix }: { prefix?: string } = {}) => ({
      keys: [...map.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace;
}

async function makeStore() {
  const kek = await importRawKey(new Uint8Array(32));
  const kv = fakeKv();
  const store = new KVWorkspaceSecretsStore(kv, kek);
  const writer = new KVWorkspaceSecretsWriter(kv, kek);
  await writer.ensureWorkspaceDek("ws1");
  // The Daytona key must be ignored by our listing.
  await writer.set("ws1", "sandbox:daytona", "dt-key");
  return new ComputeEnvSecretsStore({ store, writer });
}

describe("ComputeEnvSecretsStore", () => {
  it("sets, lists (excluding daytona + agent), and reads workspace secrets", async () => {
    const s = await makeStore();
    await s.setWorkspace("ws1", "GH_TOKEN", "tok");
    await s.setAgent("ws1", "agent-1", "NPM_TOKEN", "npm");
    const wsNames = await s.listWorkspaceNames("ws1");
    expect(wsNames.map((n) => n.name)).toEqual(["GH_TOKEN"]);
    expect(await s.getWorkspaceValues("ws1", ["GH_TOKEN"])).toEqual({ GH_TOKEN: "tok" });
  });
  it("scopes agent secrets by agentId", async () => {
    const s = await makeStore();
    await s.setAgent("ws1", "agent-1", "A", "1");
    await s.setAgent("ws1", "agent-2", "B", "2");
    expect((await s.listAgentNames("ws1", "agent-1")).map((n) => n.name)).toEqual(["A"]);
    expect(await s.getAgentValues("ws1", "agent-1", ["A"])).toEqual({ A: "1" });
  });
  it("deletes a workspace secret", async () => {
    const s = await makeStore();
    await s.setWorkspace("ws1", "GH_TOKEN", "tok");
    expect(await s.deleteWorkspace("ws1", "GH_TOKEN")).toBe(true);
    expect(await s.listWorkspaceNames("ws1")).toEqual([]);
  });
  it("isolates environment secrets by environmentId and from workspace scope", async () => {
    const s = await makeStore();
    await s.setEnvironment("ws1", "env_a", "TOKEN", "aaa");
    expect((await s.listEnvironmentNames("ws1", "env_a")).map((n) => n.name)).toEqual(["TOKEN"]);
    expect(await s.listEnvironmentNames("ws1", "env_b")).toEqual([]);
    expect(await s.listWorkspaceNames("ws1")).toEqual([]);
    expect(await s.getEnvironmentValues("ws1", "env_a", ["TOKEN"])).toEqual({ TOKEN: "aaa" });
  });

  it("deletes an environment secret", async () => {
    const s = await makeStore();
    await s.setEnvironment("ws1", "env_a", "TOKEN", "aaa");
    expect(await s.deleteEnvironment("ws1", "env_a", "TOKEN")).toBe(true);
    expect(await s.listEnvironmentNames("ws1", "env_a")).toEqual([]);
  });
});
