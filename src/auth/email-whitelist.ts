/**
 * Email allowlist for sign-in gating.
 *
 * The allowlist is a comma-separated string (the `WHITELISTED_EMAILS` env var).
 * Each entry is one of:
 *   - an exact email (contains `@`), e.g. `you@example.com`
 *   - a whole domain (no `@`), e.g. `example.org` — matches any address at that
 *     exact domain (not subdomains).
 *
 * Matching is case-insensitive and trims surrounding whitespace. When the
 * allowlist is unset or empty, all emails are allowed (gate disabled) so the
 * default single-owner/dev setup keeps working.
 */
export function isEmailAllowed(email: string, raw: string | undefined): boolean {
  const rules = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  if (rules.length === 0) {
    return true;
  }

  const candidate = email.trim().toLowerCase();
  const domain = candidate.includes("@") ? candidate.slice(candidate.indexOf("@") + 1) : "";

  for (const rule of rules) {
    if (rule.includes("@")) {
      if (candidate === rule) {
        return true;
      }
    } else if (domain !== "" && domain === rule) {
      return true;
    }
  }

  return false;
}
