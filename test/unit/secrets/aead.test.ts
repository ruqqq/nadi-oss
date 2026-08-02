import { describe, expect, it } from "vitest";
import { decrypt, encrypt, importRawKey } from "../../../src/secrets/aead";

describe("AEAD helpers", () => {
  it("round-trips plaintext with matching associated data", async () => {
    const key = await importRawKey(new Uint8Array(32).fill(7));

    const packed = await encrypt(key, "secret-value", "workspace-1:provider");

    await expect(decrypt(key, packed, "workspace-1:provider")).resolves.toBe("secret-value");
    expect(packed).not.toContain("secret-value");
  });

  it("rejects ciphertext when associated data does not match", async () => {
    const key = await importRawKey(new Uint8Array(32).fill(7));
    const packed = await encrypt(key, "secret-value", "workspace-1:provider");

    await expect(decrypt(key, packed, "workspace-2:provider")).rejects.toThrow();
  });
});
