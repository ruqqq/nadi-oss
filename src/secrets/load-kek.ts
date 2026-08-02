import type { Env } from "../env";
import { importRawKey, unpackB64 } from "./aead";
import { SecretsError } from "./errors";

export async function loadKek(env: Env): Promise<CryptoKey> {
  const raw = env.SECRETS_STORE_KEK_RAW_B64;
  if (!raw) {
    throw new SecretsError("kek_unavailable", "SECRETS_STORE_KEK_RAW_B64 is not configured");
  }

  try {
    return await importRawKey(unpackB64(raw));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SecretsError("kek_unavailable", message);
  }
}
