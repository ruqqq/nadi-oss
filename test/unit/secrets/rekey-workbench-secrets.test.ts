import { describe, expect, it } from "vitest";
import {
  decrypt as workerDecrypt,
  encrypt as workerEncrypt,
  importRawKey as workerImportRawKey,
  packB64 as workerPackB64,
} from "../../../src/secrets/aead";
import { dekAad, secretAad } from "../../../src/secrets/kv-store";
import {
  buildWorkspaceDekKey,
  buildWorkspaceSecretIndexKey,
  buildWorkspaceSecretKey,
} from "../../../src/secrets/kv-records";
// @ts-expect-error - a Node CLI script with no type declarations; that is the point.
import * as rekey from "../../../scripts/rekey-workbench-secrets.mjs";

const WORKSPACE = "ws_1";

function randomKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** The KV surface the script talks to, backed by a Map. */
function memoryStore(seed: Map<string, string> = new Map()) {
  return {
    map: seed,
    async get(key: string) {
      return seed.get(key) ?? null;
    },
    async put(key: string, value: string) {
      seed.set(key, value);
    },
    async delete(key: string) {
      seed.delete(key);
    },
  };
}

/**
 * A workspace whose secrets were written by the WORKER's code path, so what the
 * script reads is byte-for-byte what production holds.
 */
async function seedWorkspace(entries: Array<{ name: string; value: string }>) {
  const kekRaw = randomKey();
  const kek = await workerImportRawKey(kekRaw);
  const dekRaw = randomKey();
  const dek = await workerImportRawKey(dekRaw);
  const store = memoryStore();
  await store.put(
    buildWorkspaceDekKey(WORKSPACE),
    JSON.stringify({
      wrapped_dek: await workerEncrypt(kek, workerPackB64(dekRaw), dekAad(WORKSPACE)),
      kek_version: 1,
      created_at: "2026-01-01T00:00:00.000Z",
    }),
  );
  const index: { version: 1; entries: Record<string, { updated_at: string }> } = {
    version: 1,
    entries: {},
  };
  for (const entry of entries) {
    await store.put(
      buildWorkspaceSecretKey(WORKSPACE, entry.name),
      JSON.stringify({
        ciphertext: await workerEncrypt(dek, entry.value, secretAad(WORKSPACE, entry.name)),
        dek_version: 1,
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
    );
    index.entries[entry.name] = { updated_at: "2026-01-01T00:00:00.000Z" };
  }
  await store.put(buildWorkspaceSecretIndexKey(WORKSPACE), JSON.stringify(index));
  return { store, kek, dek, kekRaw };
}

async function readValue(
  store: ReturnType<typeof memoryStore>,
  dek: CryptoKey,
  name: string,
): Promise<string> {
  const raw = await store.get(buildWorkspaceSecretKey(WORKSPACE, name));
  if (raw === null) throw new Error(`missing ${name}`);
  return workerDecrypt(dek, JSON.parse(raw).ciphertext, secretAad(WORKSPACE, name));
}

describe("rekey-workbench-secrets: the crypto duplication", () => {
  // The script cannot import the Worker's TypeScript, so it carries its own copy
  // of aead.ts. These two cases are what stop that copy from drifting into
  // something that writes secrets the Worker cannot read.
  it("decrypts, in each direction, what the other implementation encrypted", async () => {
    const raw = randomKey();
    const workerKey = await workerImportRawKey(raw);
    const scriptKey = await rekey.importRawKey(raw);

    const fromWorker = await workerEncrypt(workerKey, "hunter2", "aad");
    expect(await rekey.decrypt(scriptKey, fromWorker, "aad")).toBe("hunter2");

    const fromScript = await rekey.encrypt(scriptKey, "hunter2", "aad");
    expect(await workerDecrypt(workerKey, fromScript, "aad")).toBe("hunter2");
  });

  // This is the case that makes the whole task a crypto migration rather than a
  // rename. If it ever passes, `secretAad` has stopped authenticating the name
  // and moving a KV key would be enough.
  it("REFUSES a ciphertext moved to a different name — the AAD binds the name", async () => {
    const key = await workerImportRawKey(randomKey());
    const sealed = await workerEncrypt(key, "hunter2", secretAad(WORKSPACE, "sbxenv-env:w1:TOKEN"));
    await expect(
      workerDecrypt(key, sealed, secretAad(WORKSPACE, "sbxenv-ag:a1:TOKEN")),
    ).rejects.toThrow();
  });
});

describe("rekey-workbench-secrets: the mapping", () => {
  // Must agree with migration 0067's `__wb_agent_map`, statement for statement.
  const agents = [
    { id: "ag_late", workspace_id: "ws_1", created_at: 50 },
    { id: "ag_first", workspace_id: "ws_1", created_at: 10 },
    { id: "ag_other", workspace_id: "ws_2", created_at: 1 },
  ];

  it("gives the earliest ACTIVE workbench the legacy agent's id and derives the rest", () => {
    const mapping = rekey.deriveAgentIdForWorkbench(agents, [
      { id: "env_b", workspace_id: "ws_1", created_at: 30, archived_at: null },
      { id: "env_a", workspace_id: "ws_1", created_at: 20, archived_at: null },
      // Older than both, but archived — archived workbenches sort last, so it
      // does NOT get to adopt the legacy agent.
      { id: "env_old", workspace_id: "ws_1", created_at: 5, archived_at: 999 },
    ]);
    expect(mapping.get("env_a")).toMatchObject({ agentId: "ag_first", isPrimary: true });
    expect(mapping.get("env_b")).toMatchObject({ agentId: "agt_env_b", isPrimary: false });
    expect(mapping.get("env_old")).toMatchObject({ agentId: "agt_env_old", isPrimary: false });
  });

  it("breaks a created_at tie on id, so two runs cannot disagree", () => {
    const mapping = rekey.deriveAgentIdForWorkbench(agents, [
      { id: "env_z", workspace_id: "ws_1", created_at: 20, archived_at: null },
      { id: "env_a", workspace_id: "ws_1", created_at: 20, archived_at: null },
    ]);
    expect(mapping.get("env_a")?.isPrimary).toBe(true);
    expect(mapping.get("env_z")?.isPrimary).toBe(false);
  });
});

describe("rekey-workbench-secrets: the re-key", () => {
  const mapping = new Map([
    ["env_a", { workspaceId: WORKSPACE, agentId: "ag_1", isPrimary: true, legacyAgentId: "ag_1" }],
    [
      "env_b",
      { workspaceId: WORKSPACE, agentId: "agt_env_b", isPrimary: false, legacyAgentId: "ag_1" },
    ],
  ]);

  it("re-encrypts each value under its new name and removes the old key", async () => {
    const { store, dek, kekRaw } = await seedWorkspace([
      { name: "sbxenv-env:env_a:TOKEN", value: "a-token" },
      { name: "sbxenv-env:env_b:OTHER", value: "b-other" },
    ]);
    const report = await rekey.rekeyWorkspace({
      store,
      kek: await rekey.importRawKey(kekRaw),
      workspaceId: WORKSPACE,
      mapping,
      apply: true,
    });

    expect(report.failed).toEqual([]);
    // Decrypted with the WORKER's code, under the WORKER's AAD: this is the
    // assertion that the running app can read what the script wrote.
    expect(await readValue(store, dek, "sbxenv-ag:ag_1:TOKEN")).toBe("a-token");
    expect(await readValue(store, dek, "sbxenv-ag:agt_env_b:OTHER")).toBe("b-other");
    expect(
      await store.get(buildWorkspaceSecretKey(WORKSPACE, "sbxenv-env:env_a:TOKEN")),
    ).toBeNull();

    const index = JSON.parse((await store.get(buildWorkspaceSecretIndexKey(WORKSPACE)))!);
    expect(Object.keys(index.entries).sort()).toEqual([
      "sbxenv-ag:ag_1:TOKEN",
      "sbxenv-ag:agt_env_b:OTHER",
    ]);
  });

  it("copies the legacy agent's own secrets onto every agent it creates", async () => {
    // Agent secrets OUTRANKED environment secrets, so every thread saw
    // LEGACY_ONLY whatever workbench it was on. A new agent without it would
    // silently come up with a different environment.
    const { store, dek, kekRaw } = await seedWorkspace([
      { name: "sbxenv-ag:ag_1:LEGACY_ONLY", value: "from-agent" },
      { name: "sbxenv-env:env_b:OTHER", value: "b-other" },
    ]);
    await rekey.rekeyWorkspace({
      store,
      kek: await rekey.importRawKey(kekRaw),
      workspaceId: WORKSPACE,
      mapping,
      apply: true,
    });

    expect(await readValue(store, dek, "sbxenv-ag:agt_env_b:LEGACY_ONLY")).toBe("from-agent");
    expect(await readValue(store, dek, "sbxenv-ag:agt_env_b:OTHER")).toBe("b-other");
    // The legacy agent keeps its own copy under its own id, untouched.
    expect(await readValue(store, dek, "sbxenv-ag:ag_1:LEGACY_ONLY")).toBe("from-agent");
  });

  it("keeps the AGENT's value on a name collision and never overwrites it", async () => {
    const { store, dek, kekRaw } = await seedWorkspace([
      { name: "sbxenv-ag:ag_1:TOKEN", value: "agent-wins" },
      { name: "sbxenv-env:env_a:TOKEN", value: "workbench-loses" },
    ]);
    const report = await rekey.rekeyWorkspace({
      store,
      kek: await rekey.importRawKey(kekRaw),
      workspaceId: WORKSPACE,
      mapping,
      apply: true,
    });

    expect(report.collisions).toEqual([
      { workbenchId: "env_a", agentId: "ag_1", name: "TOKEN", kept: "agent" },
    ]);
    expect(await readValue(store, dek, "sbxenv-ag:ag_1:TOKEN")).toBe("agent-wins");
    // The losing value is LEFT IN PLACE rather than destroyed: nobody asked to
    // lose it, and it is the only copy.
    expect(await readValue(store, dek, "sbxenv-env:env_a:TOKEN")).toBe("workbench-loses");
  });

  it("reports a secret whose workbench has no mapping instead of guessing an owner", async () => {
    const { store, kekRaw } = await seedWorkspace([
      { name: "sbxenv-env:env_gone:TOKEN", value: "orphan" },
    ]);
    const report = await rekey.rekeyWorkspace({
      store,
      kek: await rekey.importRawKey(kekRaw),
      workspaceId: WORKSPACE,
      mapping,
      apply: true,
    });

    expect(report.unmappedWorkbenches).toEqual([{ workbenchId: "env_gone", names: ["TOKEN"] }]);
    expect(report.moved).toEqual([]);
    expect(
      await store.get(buildWorkspaceSecretKey(WORKSPACE, "sbxenv-env:env_gone:TOKEN")),
    ).not.toBeNull();
  });

  it("reports a value it cannot decrypt and leaves it exactly where it is", async () => {
    const { store, kekRaw } = await seedWorkspace([
      { name: "sbxenv-env:env_a:TOKEN", value: "fine" },
    ]);
    // Corrupt one record the way a wrong-AAD write would.
    await store.put(
      buildWorkspaceSecretKey(WORKSPACE, "sbxenv-env:env_a:TOKEN"),
      JSON.stringify({
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAA",
        dek_version: 1,
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
    );
    const report = await rekey.rekeyWorkspace({
      store,
      kek: await rekey.importRawKey(kekRaw),
      workspaceId: WORKSPACE,
      mapping,
      apply: true,
    });

    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({ name: "sbxenv-env:env_a:TOKEN", stage: "decrypt" });
    expect(
      await store.get(buildWorkspaceSecretKey(WORKSPACE, "sbxenv-env:env_a:TOKEN")),
    ).not.toBeNull();
  });

  it("--plan writes nothing", async () => {
    const { store, kekRaw } = await seedWorkspace([
      { name: "sbxenv-env:env_a:TOKEN", value: "a-token" },
    ]);
    const before = new Map(store.map);
    const report = await rekey.rekeyWorkspace({
      store,
      kek: await rekey.importRawKey(kekRaw),
      workspaceId: WORKSPACE,
      mapping,
      apply: false,
    });

    expect(report.moved).toEqual([{ from: "sbxenv-env:env_a:TOKEN", to: "sbxenv-ag:ag_1:TOKEN" }]);
    expect([...store.map.entries()]).toEqual([...before.entries()]);
  });

  it("refuses a workspace that has a DEK but no index rather than reading it as empty", async () => {
    const { store, kekRaw } = await seedWorkspace([
      { name: "sbxenv-env:env_a:TOKEN", value: "a-token" },
    ]);
    await store.delete(buildWorkspaceSecretIndexKey(WORKSPACE));
    const report = await rekey.rekeyWorkspace({
      store,
      kek: await rekey.importRawKey(kekRaw),
      workspaceId: WORKSPACE,
      mapping,
      apply: true,
    });
    expect(report.skipped).toBe("index_missing");
    expect(report.moved).toEqual([]);
  });
});

describe("rekey-workbench-secrets: verify", () => {
  it("passes only when every indexed name decrypts under its agent-scoped name", async () => {
    const { store, kekRaw } = await seedWorkspace([{ name: "sbxenv-ag:ag_1:TOKEN", value: "ok" }]);
    const kek = await rekey.importRawKey(kekRaw);
    await expect(
      rekey.verifyWorkspace({
        store,
        kek,
        workspaceId: WORKSPACE,
        secretNameRows: [{ agent_id: "ag_1", name: "TOKEN" }],
      }),
    ).resolves.toMatchObject({ verified: ["sbxenv-ag:ag_1:TOKEN"], failed: [], leftover: [] });

    await expect(
      rekey.verifyWorkspace({
        store,
        kek,
        workspaceId: WORKSPACE,
        secretNameRows: [{ agent_id: "ag_1", name: "MISSING" }],
      }),
    ).resolves.toMatchObject({ verified: [] });
  });

  it("reports a leftover sbxenv-env: key", async () => {
    const { store, kekRaw } = await seedWorkspace([
      { name: "sbxenv-env:env_a:TOKEN", value: "stale" },
    ]);
    const report = await rekey.verifyWorkspace({
      store,
      kek: await rekey.importRawKey(kekRaw),
      workspaceId: WORKSPACE,
      secretNameRows: [],
    });
    expect(report.leftover).toEqual(["sbxenv-env:env_a:TOKEN"]);
  });
});

describe("rekey-workbench-secrets: skill collisions", () => {
  it("names the oldest copy as the one the migration promotes", () => {
    expect(
      rekey.skillCollisions([
        {
          id: "sk_b",
          workspace_id: "ws_1",
          agent_id: "ag_2",
          name: "deploy",
          created_at: 20,
          archived_at: null,
        },
        {
          id: "sk_a",
          workspace_id: "ws_1",
          agent_id: "ag_1",
          name: "deploy",
          created_at: 10,
          archived_at: null,
        },
        {
          id: "sk_c",
          workspace_id: "ws_1",
          agent_id: "ag_1",
          name: "solo",
          created_at: 10,
          archived_at: null,
        },
      ]),
    ).toEqual([
      {
        workspaceId: "ws_1",
        name: "deploy",
        promoted: "sk_a",
        leftAgentPrivate: [{ id: "sk_b", agentId: "ag_2" }],
      },
    ]);
  });
});
