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
  buildWorkspaceSecretIndexKey,
  parseWorkspaceSecretIndex,
} from "./kv-records";
export type { StoredWorkspaceSecretIndex } from "./kv-records";
export { KVWorkspaceSecretsStore } from "./kv-store";
export { KVWorkspaceSecretsWriter } from "./kv-writer";

/**
 * The KV namespace workspace secrets live in.
 *
 * Both platforms bind a real `SECRETS_KV` now. celld gained native KV in
 * v0.4.0 — a namespace is a cell, with one writer and the same durability as
 * the registry — which retired `RegistryKV`, the facade that used to fake this
 * binding over a table in the registry D1.
 *
 * Kept as a function rather than inlined at every call site: it is the one
 * place that states which store secrets live in, and it fails loudly when the
 * binding is absent instead of letting a missing namespace read as an empty
 * one — an empty secrets store looks exactly like a workspace that has no
 * secrets configured.
 */
export function secretsBinding(env: Env): KVNamespace {
  if (!env.SECRETS_KV) {
    throw new Error("secretsBinding: SECRETS_KV is not bound — workspace secrets have no store");
  }
  return env.SECRETS_KV;
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
