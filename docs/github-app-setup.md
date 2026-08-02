# GitHub App Setup

This guide covers setting up the Nadi GitHub App for automated repository cloning and file operations via GitHub App authentication.

## Overview

Nadi integrates with GitHub via a GitHub App, allowing users to authorize private repository access without sharing personal access tokens. The App uses OAuth to obtain user authorization during installation and mints short-lived installation tokens for each repository operation, following GitHub's least-privilege token model.

## Registering the GitHub App

1. **Create a new GitHub App** at https://github.com/settings/apps (for a user) or your organization's settings.
   - Give it a descriptive name (e.g., "Nadi Dev" for local testing, or "Nadi" for production).
   - Set **Homepage URL** to your deployment URL (e.g., `https://legacy.example.com`).
   - Set **Setup URL** to `https://<your-host>/api/github/callback` — this is where GitHub redirects after the user authorizes the App.
   - Also set the **User authorization callback URL** (shown once "Request user authorization (OAuth) during installation" is enabled below) to the same `https://<your-host>/api/github/callback`. The OAuth `code` for the user-authorization leg is delivered to this URL specifically, not the Setup URL — the callback needs both set to work.
   - Set **Webhook URL** to `https://<your-host>/api/github/webhooks` (deferred for a future release).
   - Leave **Webhook secret** empty for now.

2. **Grant repository permissions.**
   Navigate to the **Permissions → Repository permissions** section. Two of these
   are used by the shipped code today; the rest are granted now so a later
   CI/deploy release does not force every installation to re-consent (see
   [`github-app-scopes-ci-deploy.md`](../../projects/nadi/backlog/open/github-app-scopes-ci-deploy.md)
   in the backlog). GitHub caps every minted token at the *lesser* of what the App
   is granted and what Nadi requests, so the extra grants are inert until that
   follow-up widens the mint request — checking them now changes no behavior.

   **Used by the current release:**
   - **Contents:** Read & write — clone and push.
   - **Metadata:** Read-only — required by GitHub; repo name/owner/description.
   - **Pull requests:** Read & write — open and update PRs.
   - **Workflows:** Read & write — required (separately from Contents) to push
     changes to `.github/workflows/*` files.
   - **Checks:** Read-only — read check-run results when debugging CI.
   - **Commit statuses:** Read-only — read CI pass/fail signal on commits.
   - **Actions:** Read-only — read workflow run logs to debug a failing run.

   **Granted now, activated by the CI/deploy follow-up:**
   - **Actions:** Read & write — trigger and re-run workflows. Nadi requests
     only read access today; granting write now avoids a re-consent later.

   Leave everything else at its default (no access). In particular do **not**
   grant Secrets/Variables/Environments write — managing a repo's Actions secrets
   is not something the agent needs, and the deploy step itself uses the deploy
   target's own credentials (stored as Nadi sandbox secrets), not GitHub App
   permissions.

3. **Enable user authorization:**
   - Under **User authorization (OAuth)**, check **"Request user authorization (OAuth) during installation"**.
   - This enforces that each installation is explicitly granted by the user, preventing installation on repositories without user consent.

4. **Generate and download credentials:**
   - Generate a **Client ID** and **Client Secret** on the App settings page. Store these safely.
   - Generate a new **Private Key** (GitHub issues these in PKCS#1 format). Download and keep it safe.

## Setting Up Secrets

The GitHub App requires five secrets, each set via `wrangler secret put` (for local dev, they live in `.dev.vars`):

### Convert the Private Key to PKCS#8

GitHub's private key is issued in PKCS#1 format, but Nadi's WebCrypto signer requires PKCS#8. Convert it:

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.private-key.pem -out app.pkcs8.pem
```

Keep both files safe; you'll only need the `.pkcs8.pem` version for Nadi.

### Set the Five Secrets

For **local development**, add these to your `.dev.vars` file:

```
GITHUB_APP_ID=<your-app-id>
GITHUB_APP_PRIVATE_KEY=<contents-of-app.pkcs8.pem>
GITHUB_APP_CLIENT_ID=<your-client-id>
GITHUB_APP_CLIENT_SECRET=<your-client-secret>
GITHUB_APP_SLUG=<your-app-slug>
```

For **production** (via Wrangler), set them as secrets:

```bash
wrangler secret put GITHUB_APP_ID
# Paste the App ID (a number), then Ctrl+D to save.

wrangler secret put GITHUB_APP_PRIVATE_KEY
# Paste the full PKCS#8 PEM (including -----BEGIN PRIVATE KEY----- and -----END PRIVATE KEY-----), then Ctrl+D to save.

wrangler secret put GITHUB_APP_CLIENT_ID
# Paste the Client ID string.

wrangler secret put GITHUB_APP_CLIENT_SECRET
# Paste the Client Secret string.

wrangler secret put GITHUB_APP_SLUG
# Paste the App's slug (lowercase, e.g., "your-app-slug").
```

### Finding Your App's Slug

The App slug is the URL-safe version of your App's name. Navigate to your App's settings page; the URL will be something like:
```
https://github.com/apps/your-app-slug
```

The slug is the last part: `your-app-slug`.

## Secret Management in Code

These five secrets are **hand-maintained** in `src/env.ts` — they are NOT auto-generated from `worker-configuration.d.ts`. This keeps the types close to the actual secret usage and avoids accidental regen-on-deploy.

If you add or rename a secret, update `src/env.ts` to match, then deploy. No migration step is needed.

## Revocation and Disconnection

### GitHub Level
Uninstalling the GitHub App on GitHub immediately revokes access for that installation.

### Nadi Level (Lazy Validation)
When an installation token mint fails (e.g., because the App was uninstalled on GitHub), Nadi marks that installation as `disconnected` on the next operation attempt. The user is then prompted to reconnect.

There is no explicit revocation endpoint; uninstalling on GitHub is sufficient.

## Testing the Setup Locally

1. **Start the dev server:**
   ```bash
   pnpm run dev
   ```

2. **In the app, open Settings → GitHub** and click **Connect**.

3. **GitHub redirects to the callback URL.** If the connection succeeds, you'll land on `/settings/github?connected=1` and the GitHub installation card will appear. The credentials are saved to your session.

4. **Verify the installation** by adding the repository to a project and cloning it from a thread. The clone should succeed without prompting for a personal access token.

## Deferred: Multi-Session Management & Webhooks

Two features are deferred to follow-up tasks:

1. **Mid-session token refresh** (`github-installation-token-refresh.md`): Currently, tokens obtained at install time are reused for the session. Future versions will refresh expired tokens mid-session.

2. **Installation webhooks** (`github-app-installation-webhooks.md`): Future versions will listen for installation/uninstallation webhooks to immediately sync installation state, rather than relying on lazy validation.

## Troubleshooting

### "Installation not found" or "token could not be created"
- Confirm the App is still installed on the target repository (GitHub → Settings → Installed GitHub Apps).
- Check that the repository is private or the user has push access (read permissions alone are insufficient for the write token).

### "Client authentication failed"
- Verify `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` are correct.
- Confirm they're set in `.dev.vars` or via `wrangler secret` for production.

### "Invalid private key"
- Ensure the private key is in PKCS#8 format (use the conversion command above).
- Verify the key includes the full `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines.
- Check there are no extra blank lines or formatting issues when pasting into `wrangler secret put`.

### Callback not redirecting to `/settings/github`
- Verify the **Setup URL** in your GitHub App settings matches exactly: `https://<your-host>/api/github/callback`.
- If using a local dev setup with a tunnel (e.g., `ngrok`), update the Setup URL to match your tunnel URL.

### Cloning works but `gh pr create` fails
- The installation predates the Pull requests grant. Nadi detects the failed mint
  and falls back to a clone-only token, logging `could not mint the full permission set`
  in the session log. Fix it by reviewing the App's permissions on the installation
  and accepting the new request in GitHub's settings.

## Glossary

- **PKCS#1**: RSA private key format (GitHub's default; not directly compatible with WebCrypto).
- **PKCS#8**: Standardized private key format (required by WebCrypto for RSA signatures).
- **Installation token**: Short-lived token scoped to a single repository and a set of permissions, minted by Nadi at request time.
- **User authorization**: OAuth flow where the user explicitly approves the App's installation on their repository.
