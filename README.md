# MailGopher

Personal emails importer: pull mail from **POP3** / **IMAP** and insert it into one or more **Gmail** accounts via the Gmail API.

## Features

- Multiple Gmail destinations (OAuth per account)
- Multiple source mailboxes (IMAP + POP3)
- IMAP IDLE (optional) + polling
- Message-ID dedupe; Gmail labels; leave-on-server / delete / mark-read
- Secrets via **`file:`** and **`env:`**

## Requirements

- Node.js 18+
- Google Cloud project with **Gmail API** + OAuth client
- Source mailbox credentials

## Quick start

```bash
npm install
cp config.example.yaml config.yaml

# Put each secret in its own file (example layout)
mkdir -p secrets
chmod 700 secrets
printf '%s' 'your-app-password' > secrets/job.yahoo-imap-to-personal.password
printf '%s' 'your-oauth-client-secret' > secrets/gmail.personal.clientSecret
chmod 600 secrets/*

# Point config at those files (see config.example.yaml), then:
npm run auth -- --account personal
npm start
```

## Secrets (simple)

MailGopher does **not** implement its own password manager. Config only holds **pointers**:

```yaml
password: "file:./secrets/job.yahoo-imap-to-personal.password"
clientSecret: "file:./secrets/gmail.personal.clientSecret"
refreshToken: "file:./secrets/gmail.personal.refreshToken"

# or from the environment:
# password: "env:YAHOO_IMAP_PASSWORD"
```

| Ref | Meaning |
| --- | --- |
| `file:/absolute/or/relative/path` | Read file contents (trailing newline stripped). Relative paths are from the config file’s directory. |
| `file:${CREDENTIALS_DIRECTORY}/name` | Same, with env expansion — used with **systemd** `LoadCredential=` |
| `env:VAR_NAME` | Read `process.env.VAR_NAME` |

By default, inline `password` / `clientSecret` / `refreshToken` values in config are **rejected**. Override only for debugging:

```yaml
settings:
  allowPlaintextSecrets: true
```

### Recommended on Linux: files + systemd

**Option A — chmod 600 files** (simplest)

```bash
sudo install -d -m 700 /etc/mailgopher/secrets
sudoedit /etc/mailgopher/secrets/yahoo.password   # paste secret, save
sudo chmod 600 /etc/mailgopher/secrets/*
```

```yaml
password: "file:/etc/mailgopher/secrets/yahoo.password"
```

**Option B — systemd credentials** (service only sees secrets)

```ini
# /etc/systemd/system/mailgopher.service  (see deploy/mailgopher.service.example)
LoadCredential=yahoo:/etc/mailgopher/secrets/yahoo.password
```

```yaml
password: "file:${CREDENTIALS_DIRECTORY}/yahoo"
```

**Option C — env from a restricted EnvironmentFile**

```ini
EnvironmentFile=/etc/mailgopher/env   # chmod 600, owned by service user
```

```yaml
password: "env:YAHOO_IMAP_PASSWORD"
```

**Other tools you already trust** (age, sops, `pass`, Vault, …) fit the same pattern: decrypt/export to a **file** or **env** at deploy time, then point config at that. MailGopher does not need to speak those formats.

Encryption at rest for the whole disk is still the host’s job (`LUKS`, etc.). Restrict who can read secret files; don’t commit the `secrets/` directory.

### Auth helper

```bash
npm run auth -- --account personal
# writes data/secrets/gmail.personal.refreshToken (0600)
# and sets refreshToken: "file:./…" in config

npm run auth -- --account personal --out /etc/mailgopher/secrets/personal.refresh
```

## Configure jobs

```yaml
gmailAccounts:
  personal:
    email: you@gmail.com
    clientId: ....apps.googleusercontent.com
    clientSecret: "file:./secrets/gmail.personal.clientSecret"
    refreshToken: "file:./secrets/gmail.personal.refreshToken"

jobs:
  - id: yahoo-imap-to-personal
    enabled: true
    source:
      protocol: imap   # or pop3
      host: imap.mail.yahoo.com
      port: 993
      secure: true
      user: you@yahoo.com
      password: "file:./secrets/job.yahoo-imap-to-personal.password"
      folder: INBOX
      idle: true
    destination:
      gmailAccount: personal
      labels: [Imported/Yahoo]
    options:
      intervalMinutes: 15
      leaveOnServer: true
      deleteAfterImport: false
      maxMessagesPerRun: 100
```

```bash
npm start                 # continuous
npm run sync-once         # once (cron / timer)
node src/index.js --once --job yahoo-imap-to-personal
```

State (dedupe cursors) defaults to `./data/jobs/`.

## Provider endpoints

| Provider | POP3 | IMAP |
| --- | --- | --- |
| Gmail | `pop.gmail.com:995` | `imap.gmail.com:993` |
| Yahoo | `pop.mail.yahoo.com:995` | `imap.mail.yahoo.com:993` |
| Outlook | `outlook.office365.com:995` | `outlook.office365.com:993` |

Gmail as **source** usually needs an [App Password](https://myaccount.google.com/apppasswords). Destination uses OAuth (`gmail.insert` + `gmail.labels` only).

## Layout

```text
src/
  index.js
  config.js
  secrets/resolve.js    # file: / env: only
  cli/auth.js
  gmail/client.js
  fetchers/imap.js
  fetchers/pop3.js
  sync/
  store/
deploy/mailgopher.service.example
config.example.yaml
```

## Google OAuth

1. Enable Gmail API; create OAuth client (Desktop, or Web redirect `http://127.0.0.1:53682/oauth2callback`).
2. Store client secret in a file; reference with `file:`.
3. `npm run auth -- --account <name>` per destination Gmail account.

If no `refresh_token` is returned, revoke the app at [Google Account permissions](https://myaccount.google.com/permissions) and auth again.

## License

**Personal / noncommercial use:** free under the
[PolyForm Noncommercial License 1.0.0](https://spdx.org/licenses/PolyForm-Noncommercial-1.0.0.html)
(see [`LICENSE`](./LICENSE)).

That includes hobby use, personal study, and many noncommercial organizations
(e.g. schools, charities, government) as defined in the license.

**Commercial use** (companies, paid products/services, internal business use
that is not noncommercial under the license) is **not** included. Contact the
copyright holder to obtain a commercial license — email is listed at the top
of [`LICENSE`](./LICENSE).

This is *source-available*, not OSI “Open Source,” because commercial use is
restricted.
