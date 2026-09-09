import { describe, expect, it } from "vitest";
import { decrypt, encrypt, importRawKey, packB64, unpackB64 } from "../../../src/secrets/aead";
import { honoursAdditionalData } from "../../../src/secrets/aad-conformance";
import { rewrapWorkspaceSecrets } from "../../../src/secrets/rewrap";
import { dekAad, secretAad } from "../../../src/secrets/kv-store";
import {
  buildWorkspaceDekKey,
  buildWorkspaceSecretIndexKey,
  buildWorkspaceSecretKey,
} from "../../../src/secrets";

/**
 * The migration that unpicks celld v0.4.0's dropped `additionalData`.
 *
 * The records under test are built here the way that node built them — with an
 * EMPTY aad — because that is the only way to reproduce the defect on a
 * runtime that implements AES-GCM correctly. Encrypting them normally would
 * test nothing: they would already be bound.
 */

class MemoryKV {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

const WORKSPACE = "ws_11111111-2222-3333-4444-555555555555";

async function seed(
  kv: MemoryKV,
  kek: CryptoKey,
  dekBytes: Uint8Array,
  secrets: Record<string, string>,
  { legacy }: { legacy: boolean },
): Promise<void> {
  const dekAadValue = legacy ? "" : dekAad(WORKSPACE);
  kv.values.set(
    buildWorkspaceDekKey(WORKSPACE),
    JSON.stringify({
      wrapped_dek: await encrypt(kek, packB64(dekBytes), dekAadValue),
      kek_version: 1,
      created_at: "2026-01-01T00:00:00.000Z",
    }),
  );

  const dek = await importRawKey(dekBytes);
  const entries: Record<string, { updated_at: string }> = {};
  for (const [name, plaintext] of Object.entries(secrets)) {
    kv.values.set(
      buildWorkspaceSecretKey(WORKSPACE, name),
      JSON.stringify({
        ciphertext: await encrypt(dek, plaintext, legacy ? "" : secretAad(WORKSPACE, name)),
        dek_version: 1,
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
    );
    entries[name] = { updated_at: "2026-01-01T00:00:00.000Z" };
  }
  kv.values.set(buildWorkspaceSecretIndexKey(WORKSPACE), JSON.stringify({ version: 1, entries }));
}

async function readBack(kv: MemoryKV, kek: CryptoKey, name: string): Promise<string> {
  const dekRecord = JSON.parse(kv.values.get(buildWorkspaceDekKey(WORKSPACE)) as string);
  const dek = await importRawKey(
    unpackB64(await decrypt(kek, dekRecord.wrapped_dek, dekAad(WORKSPACE))),
  );
  const record = JSON.parse(kv.values.get(buildWorkspaceSecretKey(WORKSPACE, name)) as string);
  return decrypt(dek, record.ciphertext, secretAad(WORKSPACE, name));
}

describe("workspace secret re-wrap", () => {
  it("this runtime authenticates additionalData, so the fixtures mean what they say", async () => {
    // The whole suite is meaningless on a runtime with celld v0.4.0's defect:
    // the "legacy" records would decrypt under any aad and every case would
    // pass for the wrong reason.
    await expect(honoursAdditionalData()).resolves.toBe(true);
  });

  it("binds records that were sealed with no aad, and keeps the plaintext", async () => {
    const kv = new MemoryKV();
    const kek = await importRawKey(new Uint8Array(32).fill(7));
    const dekBytes = new Uint8Array(32).fill(9);
    await seed(
      kv,
      kek,
      dekBytes,
      { "provider:openai": "sk-live", "provider:zen": "zk" },
      {
        legacy: true,
      },
    );

    const report = await rewrapWorkspaceSecrets(kv, kek, WORKSPACE, { dryRun: false });

    expect(report.dek).toBe("rewrapped");
    expect(report.secrets).toEqual([
      { name: "provider:openai", outcome: "rewrapped" },
      { name: "provider:zen", outcome: "rewrapped" },
    ]);
    await expect(readBack(kv, kek, "provider:openai")).resolves.toBe("sk-live");
    await expect(readBack(kv, kek, "provider:zen")).resolves.toBe("zk");
  });

  it("is idempotent — a second pass finds everything already bound", async () => {
    const kv = new MemoryKV();
    const kek = await importRawKey(new Uint8Array(32).fill(7));
    await seed(
      kv,
      kek,
      new Uint8Array(32).fill(9),
      { "provider:openai": "sk-live" },
      {
        legacy: true,
      },
    );

    await rewrapWorkspaceSecrets(kv, kek, WORKSPACE, { dryRun: false });
    const second = await rewrapWorkspaceSecrets(kv, kek, WORKSPACE, { dryRun: false });

    expect(second.dek).toBe("bound");
    expect(second.secrets).toEqual([{ name: "provider:openai", outcome: "bound" }]);
  });

  it("writes nothing on a dry run", async () => {
    const kv = new MemoryKV();
    const kek = await importRawKey(new Uint8Array(32).fill(7));
    await seed(
      kv,
      kek,
      new Uint8Array(32).fill(9),
      { "provider:openai": "sk-live" },
      {
        legacy: true,
      },
    );
    const before = new Map(kv.values);

    const report = await rewrapWorkspaceSecrets(kv, kek, WORKSPACE, { dryRun: true });

    expect(report.dek).toBe("rewrapped");
    expect([...kv.values]).toEqual([...before]);
  });

  it("leaves a record that opens under neither aad untouched", async () => {
    const kv = new MemoryKV();
    const kek = await importRawKey(new Uint8Array(32).fill(7));
    const dekBytes = new Uint8Array(32).fill(9);
    await seed(kv, kek, dekBytes, { "provider:openai": "sk-live" }, { legacy: true });

    // A secret encrypted under a DIFFERENT dek — genuinely corrupt, not merely
    // unbound. The migration must report it rather than destroy it.
    const foreign = await importRawKey(new Uint8Array(32).fill(4));
    const corrupt = JSON.stringify({
      ciphertext: await encrypt(foreign, "unreachable", ""),
      dek_version: 1,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    kv.values.set(buildWorkspaceSecretKey(WORKSPACE, "provider:openai"), corrupt);

    const report = await rewrapWorkspaceSecrets(kv, kek, WORKSPACE, { dryRun: false });

    expect(report.secrets).toEqual([{ name: "provider:openai", outcome: "unreadable" }]);
    expect(kv.values.get(buildWorkspaceSecretKey(WORKSPACE, "provider:openai"))).toBe(corrupt);
  });

  it("flags a workspace that has a DEK but no index instead of reporting zero secrets", async () => {
    const kv = new MemoryKV();
    const kek = await importRawKey(new Uint8Array(32).fill(7));
    await seed(
      kv,
      kek,
      new Uint8Array(32).fill(9),
      { "provider:openai": "sk-live" },
      {
        legacy: true,
      },
    );
    kv.values.delete(buildWorkspaceSecretIndexKey(WORKSPACE));

    const report = await rewrapWorkspaceSecrets(kv, kek, WORKSPACE, { dryRun: false });

    expect(report.indexMissing).toBe(true);
    expect(report.secrets).toEqual([]);
  });

  it("reports a workspace with no DEK as absent", async () => {
    const kv = new MemoryKV();
    const kek = await importRawKey(new Uint8Array(32).fill(7));

    const report = await rewrapWorkspaceSecrets(kv, kek, WORKSPACE, { dryRun: false });

    expect(report.dek).toBe("absent");
    expect(report.secrets).toEqual([]);
  });
});
