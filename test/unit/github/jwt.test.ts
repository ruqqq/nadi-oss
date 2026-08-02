import { describe, expect, it } from "vitest";
import { createAppJwt, importPkcs8 } from "../../../src/github/jwt";

function pemFromDer(der: ArrayBuffer, label: string): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----`;
}

async function genKeyPair() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = pemFromDer(await crypto.subtle.exportKey("pkcs8", pair.privateKey), "PRIVATE KEY");
  return { pkcs8, publicKey: pair.publicKey };
}

const b64urlToBytes = (s: string) => {
  const p = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(p), (c) => c.charCodeAt(0));
};

describe("createAppJwt", () => {
  it("produces a verifiable RS256 JWT with iss/iat/exp", async () => {
    const { pkcs8, publicKey } = await genKeyPair();
    const config = {
      appId: "555",
      privateKeyPkcs8Pem: pkcs8,
      clientId: "c",
      clientSecret: "s",
      slug: "nadi",
    };
    const now = 1_700_000_000_000;
    const jwt = await createAppJwt(config, now);
    const [h, p, sig] = jwt.split(".") as [string, string, string];
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload.iss).toBe("555");
    expect(payload.iat).toBe(Math.floor(now / 1000) - 60);
    expect(payload.exp).toBe(Math.floor(now / 1000) + 540);
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      b64urlToBytes(sig),
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });

  it("rejects a PKCS#1 private key with a clear error", async () => {
    await expect(
      importPkcs8("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"),
    ).rejects.toThrow("github_private_key_not_pkcs8");
  });
});
