# Security policy

## Reporting a vulnerability

**Do not open a public issue.** Report privately through
[GitHub Security Advisories](https://github.com/ruqqq/nadi-oss/security/advisories/new),
which opens a channel visible only to you and the maintainers.

Include what you need to make the problem reproducible: the version or commit,
the steps, and what an attacker gains. A proof of concept helps; a working
exploit is not required.

You will get an acknowledgement within a few days. Please give us a reasonable
window to ship a fix before disclosing publicly.

## Scope

Nadi is self-hosted: you deploy it to your own Cloudflare account, holding your
own keys. That shapes what counts as a vulnerability here.

**In scope** — anything in this repository that lets one workspace or user reach
another's data, escapes the sandbox boundary, defeats the tool-approval
mechanism, exposes stored secrets, or bypasses the invite gate.

**Out of scope** — issues in a deployment's own configuration (a leaked
`.dev.vars`, an over-permissive MCP server you attached, a provider key you
committed), vulnerabilities in Cloudflare, Daytona or model providers
themselves, and anything requiring an already-compromised Worker environment.

## Notes for self-hosters

Some defaults are deliberately conservative and worth understanding before you
loosen them:

- **Tool approvals are signed** with `TOOL_APPROVAL_SECRET`. If that secret is
  weak or shared, approvals can be forged. Generate it randomly, per deployment.
- **Sign-in is invite-only.** Removing that gate makes your deployment — and the
  model spend behind it — open to anyone who finds the URL.
- **`deny` beats convenience.** An MCP tool set to `auto_allow` runs without a
  human in the loop, on data the agent can already reach.
- **Sandbox egress is restricted by the provider**, not by Nadi alone. Read the
  Known issues in [`README.md`](./README.md) before assuming a sandbox cannot
  reach the internet.
