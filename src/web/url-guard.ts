export class UrlGuardError extends Error {
  constructor(
    public readonly reason: string,
    public readonly raw: string,
  ) {
    super(`unsafe url (${reason}): ${raw}`);
  }
}

const LOCAL_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlGuardError("malformed", raw);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlGuardError("scheme", raw);
  }

  const host = url.hostname.toLowerCase();
  if (LOCAL_HOSTNAMES.has(host)) {
    throw new UrlGuardError("local_hostname", raw);
  }

  if (isIPv4Literal(host)) {
    const octets = host.split(".").map(Number);
    if (octets[0] === 0) throw new UrlGuardError("loopback", raw);
    if (octets[0] === 127) throw new UrlGuardError("loopback", raw);
    if (octets[0] === 10) throw new UrlGuardError("private", raw);
    if (octets[0] === 192 && octets[1] === 168) throw new UrlGuardError("private", raw);
    if (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) {
      throw new UrlGuardError("private", raw);
    }
    if (octets[0] === 169 && octets[1] === 254) {
      throw new UrlGuardError("link_local", raw);
    }
  } else if (isIPv6Literal(url.hostname)) {
    const inner = url.hostname.startsWith("[")
      ? url.hostname.slice(1, -1).toLowerCase()
      : url.hostname.toLowerCase();
    if (inner === "::1") throw new UrlGuardError("loopback", raw);
    if (inner.startsWith("::ffff:")) throw new UrlGuardError("private", raw);
    if (inner.startsWith("fc") || inner.startsWith("fd")) {
      throw new UrlGuardError("private", raw);
    }
    if (inner.startsWith("fe80")) {
      throw new UrlGuardError("link_local", raw);
    }
  }

  return url;
}

function isIPv4Literal(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255);
}

function isIPv6Literal(rawHostname: string): boolean {
  return rawHostname.includes(":");
}
