/**
 * Does this runtime's AES-GCM actually authenticate `additionalData`?
 *
 * celld v0.4.0 silently discards it — measured on the beta, where the same
 * known-answer vector produced the AAD-length-ZERO ciphertext at every AAD
 * length, and a ciphertext encrypted under one AAD opened happily under
 * another. v0.4.1 implements it correctly. workerd always has.
 *
 * That divergence is invisible to a round trip, because an implementation
 * that ignores the AAD in both directions decrypts its own output perfectly
 * well. It only shows up when the two halves are done by different runtimes:
 * everything a v0.4.0 node sealed carries a tag computed WITHOUT its AAD, so
 * a correct implementation refuses to open it.
 *
 * This is the interlock for the re-wrap migration: re-wrapping on a runtime
 * that ignores AAD would report every record as correctly bound and write
 * nothing, quietly declaring the job done.
 */
export async function honoursAdditionalData(): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const iv = new Uint8Array(new ArrayBuffer(12));
  crypto.getRandomValues(iv);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode("conformance:a") },
    key,
    encoder.encode("nadi-aad-conformance"),
  );

  try {
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode("conformance:b") },
      key,
      ciphertext,
    );
    // Opened under the wrong AAD — the runtime is not authenticating it.
    return false;
  } catch {
    return true;
  }
}
