import type { Env } from "../env";
import { loadKek } from "./load-kek";
import { KVWorkspaceSecretsStore } from "./kv-store";
import { KVWorkspaceSecretsWriter } from "./kv-writer";

export { importRawKey, packB64, unpackB64 } from "./aead";
export { SecretsError } from "./errors";
export {
  buildWorkspaceDekKey,
  buildWorkspaceSecretKey,
  buildWorkspaceSecretPrefix,
} from "./kv-records";
export { KVWorkspaceSecretsStore } from "./kv-store";
export { KVWorkspaceSecretsWriter } from "./kv-writer";

export function createWorkspaceSecretsServices(env: Env): {
  store: KVWorkspaceSecretsStore;
  writer: KVWorkspaceSecretsWriter;
} {
  if (!env.SECRETS_KV) {
    throw new Error("SECRETS_KV is not configured");
  }
  const kek = loadKek(env);
  return {
    store: new KVWorkspaceSecretsStore(env.SECRETS_KV, kek),
    writer: new KVWorkspaceSecretsWriter(env.SECRETS_KV, kek),
  };
}
