const IV_BYTES = 12;

export async function importRawKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== 32) {
    throw new Error("AES-GCM key must be 32 bytes");
  }

  return crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encrypt(key: CryptoKey, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const additionalData = new TextEncoder().encode(aad);
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, encoded),
  );

  const payload = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  payload.set(iv, 0);
  payload.set(ciphertext, iv.byteLength);
  return packB64(payload);
}

export async function decrypt(key: CryptoKey, packed: string, aad: string): Promise<string> {
  const payload = unpackB64(packed);
  if (payload.byteLength <= IV_BYTES) {
    throw new Error("ciphertext too short");
  }

  const iv = payload.slice(0, IV_BYTES);
  const ciphertext = payload.slice(IV_BYTES);
  const additionalData = new TextEncoder().encode(aad);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}

export function packB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function unpackB64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
