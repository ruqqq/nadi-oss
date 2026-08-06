import type { Env } from "../env";
import { RegistryKV } from "../db/registry-kv";
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
export { RegistryKV } from "../db/registry-kv";

/**
 * The KV namespace workspace secrets live in. Cloudflare binds the real
 * `SECRETS_KV`; celld has no KV, so it hands every consumer a `RegistryKV`
 * facade over the registry DO instead — the rest of the secrets stack
 * (store/writer) never needs to know which platform it is on.
 */
export function secretsBinding(env: Env): KVNamespace {
  if (env.SECRETS_KV) return env.SECRETS_KV;
  if (!env.REGISTRY_DO) {
    throw new Error(
      "secretsBinding: neither SECRETS_KV nor REGISTRY_DO is bound — workspace secrets have no backing store",
    );
  }
  return new RegistryKV(env.REGISTRY_DO);
}

export function createWorkspaceSecretsServices(env: Env): {
  store: KVWorkspaceSecretsStore;
  writer: KVWorkspaceSecretsWriter;
} {
  const kv = secretsBinding(env);
  const kek = loadKek(env);
  return {
    store: new KVWorkspaceSecretsStore(kv, kek),
    writer: new KVWorkspaceSecretsWriter(kv, kek),
  };
}
