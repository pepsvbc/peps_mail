<div align="center">

<img src="frontend/public/peps-vbc-logo.png" alt="PEPS VBC logo" width="180" />

# PEPS VBC Mail

**A self-hosted email client for PEPS VBC, built with React and Rust.**

Connects to any existing IMAP/SMTP mail server.

[![CI](https://github.com/pepsvbc/peps_mail/actions/workflows/ci.yml/badge.svg)](https://github.com/pepsvbc/peps_mail/actions/workflows/ci.yml)

[Club website](https://pepsvbc.ch/) · [Original project: oxi](https://github.com/c0h1b4/oxi)

</div>

## Features

- Multiple mailboxes, rich-text composing, attachments and full-text search.
- Live updates, address autocomplete, personal and shared distribution lists.
- English/French interface, light/dark themes and per-account preferences.
- Phone and desktop setup instructions at `/help`, including Apple Mail profiles.
- Optional FranklyMail administration for mailboxes, password recovery and server forwarding.

## Run with Docker

From the repository root:

```bash
[ -f .env ] || cp .env.example .env
# Fill in .env before starting.
docker compose up -d --build
```

Configure these in your private `.env`:

| Setting | Purpose |
| --- | --- |
| `IMAP_HOST`, `IMAP_PORT` | Incoming mail server |
| `SMTP_HOST`, `SMTP_PORT` | Outgoing mail server |
| `ALLOWED_EMAIL_DOMAINS` | Domains allowed to sign in, e.g. `pepsvbc.ch` |
| `LOGIN_DEFAULT_DOMAIN` | Optional domain for short logins such as `admin`; defaults to the sole allowed domain |
| `ADMIN_EMAILS` | Mailboxes allowed to manage shared lists and provider settings |

See [`.env.example`](.env.example) for all options. Keep `.env` private; it is excluded from Git and Docker builds. On shared mail providers, set `ALLOWED_EMAIL_DOMAINS` to prevent other customers from signing in.

For production, put an HTTPS reverse proxy in front of port **3001**, preserve the `Host` header, and configure `TRUSTED_PROXIES`. The included Compose file binds to localhost by default. Users sign in with their mailbox credentials.

Persistent data lives in `./data`; back it up. To update after pulling changes, rerun `docker compose up -d --build`.

## FranklyMail integration

This separate module is disabled by default. The standard mail client works without it.

1. Set `FRANKLYMAIL_ENABLED=true`, `FRANKLYMAIL_API_KEY` to a management key, and `FRANKLYMAIL_DOMAINS` to your managed domains.
2. For welcome/reset emails, set `FRANKLYMAIL_PUBLIC_URL` to the app’s public HTTPS URL, plus `FRANKLYMAIL_MAIL_FROM`, `FRANKLYMAIL_SMTP_USERNAME` and `FRANKLYMAIL_SMTP_PASSWORD`. Use an existing no-reply or admin mailbox. The module reuses the shared IMAP/SMTP servers; keep `TLS_ENABLED=true`.
3. Sign in with an address listed in `ADMIN_EMAILS` and open **Users** in the left bar (also linked from **Settings → Users**).

Admins can create a mailbox and register its owner’s personal email. The owner receives a one-time link to choose a password; links expire after **15 minutes**. Verify the personal address before entering it, since it grants password-reset access. Existing mailboxes can also receive reset links.

Admins can delete a user from **Users → Manage user → Delete user**, after typing the address to confirm. FranklyMail takes the address out of service and retains its mail.

Users can change their own password in **Settings → Change password** by confirming their current password. They must sign in again afterwards and update their other mail apps.

Forwarding runs on **FranklyMail’s server**, so it continues when this app is offline. Existing server rules are preserved and may affect delivery; avoid editing rules in multiple clients at once. Run one app instance for this integration.

Welcome/reset emails include styled HTML with a button and visible URL, plus plain text. Edit the [bundled templates](backend/src/integrations/franklymail/templates/), or mount custom files and set their `FRANKLYMAIL_*_TEMPLATE_PATH` options in `.env`. Keep `{{link}}` in each template; `{{mailbox}}` inserts the mailbox address.

## Development

For local HTTP testing with Docker:

```bash
./dev.sh
```

Open **http://localhost:3001**. This uses your `.env` and `./data`; rerun the script after changes.

For source development, use Node 22, Bun and Rust. Direct backend runs require configuration exported into the environment.

```bash
# Frontend dependencies and checks
(cd frontend && bun install && bun run lint && bun run test && bun run build)

# Backend checks
(cd backend && cargo test && cargo clippy -- -D warnings)
```

Branding: [name and logo](frontend/src/lib/brand.ts) · [colours](frontend/src/app/globals.css).
