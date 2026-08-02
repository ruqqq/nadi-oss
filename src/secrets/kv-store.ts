import { decrypt, importRawKey, unpackB64 } from "./aead";
import { SecretsError, type SecretsErrorCode } from "./errors";
import {
  buildWorkspaceDekKey,
  buildWorkspaceSecretKey,
  parseWorkspaceDekRecord,
  parseWorkspaceSecretRecord,
} from "./kv-records";

export class KVWorkspaceSecretsStore {
  private readonly dekCache = new Map<string, CryptoKey>();

  constructor(
    private readonly kv: KVNamespace,
    private readonly kek: CryptoKey | Promise<CryptoKey>,
  ) {}

  async get(workspaceId: string, name: string): Promise<string | null> {
    const dek = await this.loadDek(workspaceId);
    if (dek === null) return null;

    const raw = await this.getText(buildWorkspaceSecretKey(workspaceId, name), workspaceId, name);
    if (raw === null) return null;

    let record;
    try {
      record = parseWorkspaceSecretRecord(raw, workspaceId, name);
    } catch (error) {
      return this.fail("store_error", error);
    }

    try {
      return await decrypt(dek, record.ciphertext, secretAad(workspaceId, name));
    } catch (error) {
      return this.fail("secret_corrupt", error);
    }
  }

  private async loadDek(workspaceId: string): Promise<CryptoKey | null> {
    const cached = this.dekCache.get(workspaceId);
    if (cached) return cached;

    const raw = await this.getText(buildWorkspaceDekKey(workspaceId), workspaceId, null);
    if (raw === null) return null;

    let record;
    try {
      record = parseWorkspaceDekRecord(raw, workspaceId);
    } catch (error) {
      return this.fail("store_error", error);
    }

    try {
      const decoded = await decrypt(await this.kek, record.wrapped_dek, dekAad(workspaceId));
      const dek = await importRawKey(unpackB64(decoded));
      this.dekCache.set(workspaceId, dek);
      return dek;
    } catch (error) {
      return this.fail("dek_corrupt", error);
    }
  }

  private async getText(
    key: string,
    _workspaceId: string,
    _name: string | null,
  ): Promise<string | null> {
    try {
      return await this.kv.get(key);
    } catch (error) {
      return this.fail("store_error", error);
    }
  }

  private fail(code: SecretsErrorCode, error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    throw new SecretsError(code, message);
  }
}

export function dekAad(workspaceId: string): string {
  return `${workspaceId}:dek`;
}

export function secretAad(workspaceId: string, name: string): string {
  return `${workspaceId}:${name}`;
}
