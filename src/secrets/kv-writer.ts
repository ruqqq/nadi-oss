import { decrypt, encrypt, importRawKey, packB64, unpackB64 } from "./aead";
import { SecretsError, type SecretsErrorCode } from "./errors";
import {
  buildWorkspaceDekKey,
  buildWorkspaceSecretIndexKey,
  buildWorkspaceSecretKey,
  parseWorkspaceDekRecord,
  parseWorkspaceSecretIndex,
  parseWorkspaceSecretRecord,
  type StoredWorkspaceDek,
  type StoredWorkspaceSecret,
  type StoredWorkspaceSecretIndex,
} from "./kv-records";
import { dekAad, secretAad } from "./kv-store";

export class KVWorkspaceSecretsWriter {
  constructor(
    private readonly kv: KVNamespace,
    private readonly kek: CryptoKey | Promise<CryptoKey>,
  ) {}

  async ensureWorkspaceDek(workspaceId: string): Promise<boolean> {
    const key = buildWorkspaceDekKey(workspaceId);
    const existing = await this.getText(key);
    if (existing !== null) {
      await this.unwrapWorkspaceDek(existing, workspaceId);
      return false;
    }

    const rawDek = crypto.getRandomValues(new Uint8Array(32));
    const record: StoredWorkspaceDek = {
      wrapped_dek: await encrypt(await this.kek, packB64(rawDek), dekAad(workspaceId)),
      kek_version: 1,
      created_at: new Date().toISOString(),
    };
    await this.putText(key, JSON.stringify(record));
    // Seed an empty index alongside the DEK. Every write path calls this first,
    // so from here on "index missing" can only mean "predates the index" —
    // which is what lets listMetadata tell that apart from "no secrets".
    await this.putText(
      buildWorkspaceSecretIndexKey(workspaceId),
      JSON.stringify({ version: 1, entries: {} } satisfies StoredWorkspaceSecretIndex),
    );
    return true;
  }

  async set(
    workspaceId: string,
    name: string,
    plaintext: string,
    input: { updatedAt?: string } = {},
  ): Promise<void> {
    const rawDek = await this.loadWorkspaceDek(workspaceId);
    // Probe the index BEFORE writing the value: a refused write (un-backfilled
    // workspace, index_missing) must leave nothing behind, not just the index.
    await this.readIndex(workspaceId);
    const dek = await importRawKey(rawDek);
    const record: StoredWorkspaceSecret = {
      ciphertext: await encrypt(dek, plaintext, secretAad(workspaceId, name)),
      dek_version: 1,
      updated_at: input.updatedAt ?? new Date().toISOString(),
    };
    await this.putText(buildWorkspaceSecretKey(workspaceId, name), JSON.stringify(record));
    await this.writeIndex(workspaceId, (index) => {
      index.entries[name] = { updated_at: record.updated_at };
    });
  }

  async delete(workspaceId: string, name: string): Promise<boolean> {
    const key = buildWorkspaceSecretKey(workspaceId, name);
    const existed = (await this.getText(key)) !== null;
    if (existed) {
      try {
        await this.kv.delete(key);
      } catch (error) {
        return this.fail("store_error", error);
      }
    }
    // Drop the index entry EVEN IF the value was already gone. A delete that
    // crashed between the two writes leaves a name in the listing pointing at
    // nothing; without this the UI's delete button reports "not found" and walks
    // away, making the ghost permanent.
    await this.writeIndex(workspaceId, (index) => {
      delete index.entries[name];
    });
    return existed;
  }

  async getMetadata(
    workspaceId: string,
    name: string,
  ): Promise<{ name: string; updated_at: string } | null> {
    const raw = await this.getText(buildWorkspaceSecretKey(workspaceId, name));
    if (raw === null) return null;
    const record = parseWorkspaceSecretRecord(raw, workspaceId, name);
    return { name, updated_at: record.updated_at };
  }

  async listMetadata(workspaceId: string): Promise<Array<{ name: string; updated_at: string }>> {
    const index = await this.readIndex(workspaceId);
    if (index === null) return [];

    return Object.entries(index.entries)
      .map(([name, entry]) => ({ name, updated_at: entry.updated_at }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private async loadWorkspaceDek(workspaceId: string): Promise<Uint8Array> {
    const raw = await this.getText(buildWorkspaceDekKey(workspaceId));
    if (raw === null) {
      throw new SecretsError("store_error", "workspace_dek_missing");
    }
    return this.unwrapWorkspaceDek(raw, workspaceId);
  }

  private async unwrapWorkspaceDek(raw: string, workspaceId: string): Promise<Uint8Array> {
    const record = parseWorkspaceDekRecord(raw, workspaceId);
    try {
      const decoded = await decrypt(await this.kek, record.wrapped_dek, dekAad(workspaceId));
      const unpacked = unpackB64(decoded);
      await importRawKey(unpacked);
      return unpacked;
    } catch (error) {
      return this.fail("dek_corrupt", error);
    }
  }

  /**
   * The index, or `null` for a workspace that has never held a secret.
   *
   * A workspace gets its DEK and its index together on the first write, so a
   * DEK with no index means the workspace predates the index and has NOT been
   * backfilled. That must not read as an empty list: an empty secrets store
   * looks exactly like a workspace with nothing configured, and a user who
   * believes that will re-add secrets that are already there.
   */
  private async readIndex(workspaceId: string): Promise<StoredWorkspaceSecretIndex | null> {
    const raw = await this.getText(buildWorkspaceSecretIndexKey(workspaceId));
    if (raw !== null) {
      try {
        return parseWorkspaceSecretIndex(raw, workspaceId);
      } catch (error) {
        return this.fail("store_error", error);
      }
    }
    if ((await this.getText(buildWorkspaceDekKey(workspaceId))) === null) return null;
    throw new SecretsError(
      "index_missing",
      `workspace ${workspaceId} has secrets but no secret index — run the backfill ` +
        `(scripts/backfill-secret-index.mjs, or deploy/celld/backfill-secret-index.sh)`,
    );
  }

  /**
   * Read-modify-write of the index.
   *
   * KV has no compare-and-swap, so two secrets written concurrently can race and
   * lose one INDEX entry — never a value. Contention here is a human in a
   * settings form, and re-running the backfill is the repair. Do not move a
   * high-frequency writer onto this path without revisiting that.
   */
  private async writeIndex(
    workspaceId: string,
    mutate: (index: StoredWorkspaceSecretIndex) => void,
  ): Promise<void> {
    const index = (await this.readIndex(workspaceId)) ?? { version: 1, entries: {} };
    mutate(index);
    await this.putText(buildWorkspaceSecretIndexKey(workspaceId), JSON.stringify(index));
  }

  private async getText(key: string): Promise<string | null> {
    try {
      return await this.kv.get(key);
    } catch (error) {
      return this.fail("store_error", error);
    }
  }

  private async putText(key: string, value: string): Promise<void> {
    try {
      await this.kv.put(key, value);
    } catch (error) {
      return this.fail("store_error", error);
    }
  }

  private fail(code: SecretsErrorCode, error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    throw new SecretsError(code, message);
  }
}
