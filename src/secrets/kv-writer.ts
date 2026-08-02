import { decrypt, encrypt, importRawKey, packB64, unpackB64 } from "./aead";
import { SecretsError, type SecretsErrorCode } from "./errors";
import {
  buildWorkspaceDekKey,
  buildWorkspaceSecretKey,
  buildWorkspaceSecretPrefix,
  parseSecretNameFromKey,
  parseWorkspaceDekRecord,
  parseWorkspaceSecretRecord,
  type StoredWorkspaceDek,
  type StoredWorkspaceSecret,
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
    return true;
  }

  async set(
    workspaceId: string,
    name: string,
    plaintext: string,
    input: { updatedAt?: string } = {},
  ): Promise<void> {
    const rawDek = await this.loadWorkspaceDek(workspaceId);
    const dek = await importRawKey(rawDek);
    const record: StoredWorkspaceSecret = {
      ciphertext: await encrypt(dek, plaintext, secretAad(workspaceId, name)),
      dek_version: 1,
      updated_at: input.updatedAt ?? new Date().toISOString(),
    };
    await this.putText(buildWorkspaceSecretKey(workspaceId, name), JSON.stringify(record));
  }

  async delete(workspaceId: string, name: string): Promise<boolean> {
    const key = buildWorkspaceSecretKey(workspaceId, name);
    if ((await this.getText(key)) === null) return false;
    try {
      await this.kv.delete(key);
      return true;
    } catch (error) {
      return this.fail("store_error", error);
    }
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
    let page: KVNamespaceListResult<unknown>;
    try {
      page = await this.kv.list({ prefix: buildWorkspaceSecretPrefix(workspaceId) });
    } catch (error) {
      return this.fail("store_error", error);
    }

    const metadata = await Promise.all(
      page.keys.map(async (key) => {
        const name = parseSecretNameFromKey(workspaceId, key.name);
        if (name === null) return null;
        const raw = await this.getText(key.name);
        if (raw === null) return null;
        const record = parseWorkspaceSecretRecord(raw, workspaceId, name);
        return { name, updated_at: record.updated_at };
      }),
    );

    return metadata
      .filter((item): item is { name: string; updated_at: string } => item !== null)
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
