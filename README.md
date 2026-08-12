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

On Linux, prefer **chmod 600 files** and the systemd unit below. Other tools (age, sops, `pass`, Vault) still work: decrypt to a **file** or **env** at deploy time.

Disk encryption (`LUKS`, etc.) is the host’s job. Don’t commit the `secrets/` directory.

### Auth helper (laptop / first-time OAuth)

```bash
npm run auth -- --account personal
# writes data/secrets/gmail.personal.refreshToken (0600)
# and sets refreshToken: "file:./…" in config

npm run auth -- --account personal --out /etc/mailgopher/secrets/gmail.personal.refreshToken
```

On a headless server, run auth on a machine with a browser and copy the token file (see systemd section §5).

---

## Run as a systemd service (Linux)

This is the intended way to keep MailGopher running on a server. Two layouts ship under `deploy/`:

| Mode | Units | When to use |
| --- | --- | --- |
| **Always-on** | `mailgopher.service.example` | IMAP IDLE (near-realtime) or one long-lived process |
| **Timer** | `mailgopher-oneshot.service.example` + `mailgopher.timer.example` | Poll every N minutes; no IDLE needed |

Paths used below (change them consistently if you prefer others):

| Path | Role |
| --- | --- |
| `/opt/mailgopher` | App checkout + `node_modules` |
| `/opt/mailgopher/data` | Dedupe / cursor state (`settings.stateDir`) |
| `/etc/mailgopher/config.yaml` | Config (no passwords) |
| `/etc/mailgopher/secrets/` | Secret files (`chmod 600`) |

### 1. Prerequisites

- systemd (any current Debian/Ubuntu, Fedora, RHEL, Arch)
- Node.js 18+ on the **server** (`node -v`)
- A dedicated Unix user (do not run as root)

```bash
# Debian/Ubuntu example
sudo apt update
sudo apt install -y ca-certificates curl git

# Install Node 18+ from your distro, NodeSource, nvm, etc.
node -v           # must be v18 or newer
command -v node   # note the path — used in ExecStart=
```

If `node` is not `/usr/bin/node` (nvm, fnm, snap), put the real path in `ExecStart=`.

### 2. Dedicated user and directories

```bash
sudo useradd --system --home /opt/mailgopher --shell /usr/sbin/nologin mailgopher

sudo install -d -o mailgopher -g mailgopher -m 755 /opt/mailgopher
sudo install -d -o mailgopher -g mailgopher -m 750 /opt/mailgopher/data
sudo install -d -o root -g mailgopher -m 750 /etc/mailgopher
sudo install -d -o root -g mailgopher -m 750 /etc/mailgopher/secrets
```

The service user can read `/etc/mailgopher` (group) but does not own the secret files. systemd `LoadCredential=` still injects them into the process.

### 3. Install the app

```bash
sudo git clone https://YOUR-REPO-URL/mailGopher.git /opt/mailgopher
# or rsync / scp a release tree into /opt/mailgopher

cd /opt/mailgopher
sudo npm ci --omit=dev
# if you have no package-lock on the server: sudo npm install --omit=dev

sudo chown -R mailgopher:mailgopher /opt/mailgopher
```

### 4. Config and secrets

```bash
sudo cp /opt/mailgopher/deploy/config.systemd.example.yaml /etc/mailgopher/config.yaml
sudo chown root:mailgopher /etc/mailgopher/config.yaml
sudo chmod 640 /etc/mailgopher/config.yaml
```

Edit `/etc/mailgopher/config.yaml`:

- Set Gmail `clientId`, emails, job hosts/users, labels.
- Keep every password / token as `file:${CREDENTIALS_DIRECTORY}/<name>`.
- Set `settings.stateDir: /opt/mailgopher/data` (must match `ReadWritePaths=` in the unit).

Create one file per secret. File contents are the secret only (a trailing newline is stripped).

```bash
# OAuth client secret from Google Cloud
sudo tee /etc/mailgopher/secrets/gmail.personal.clientSecret >/dev/null
# paste, Enter, Ctrl-D

# Source mailbox app password
sudo tee /etc/mailgopher/secrets/yahoo.password >/dev/null
# paste, Enter, Ctrl-D

# Refresh token: obtain it first (step 5), then install the file
sudo chmod 600 /etc/mailgopher/secrets/*
sudo chown root:root /etc/mailgopher/secrets/*
```

**`LoadCredential=` name must match the config name:**

| Unit (`LoadCredential=`) | Config (`file:${CREDENTIALS_DIRECTORY}/…`) | Source file |
| --- | --- | --- |
| `yahoo_password` | `yahoo_password` | `/etc/mailgopher/secrets/yahoo.password` |
| `gmail_personal_client_secret` | `gmail_personal_client_secret` | `…/gmail.personal.clientSecret` |
| `gmail_personal_refresh` | `gmail_personal_refresh` | `…/gmail.personal.refreshToken` |

Add a `LoadCredential=` line in the unit for every extra secret (second Gmail account, more jobs).

Simpler alternative: skip `LoadCredential` and point config at the files:

```yaml
password: "file:/etc/mailgopher/secrets/yahoo.password"
```

Then the `mailgopher` group must be able to read them (`chown root:mailgopher` + `chmod 640`). `LoadCredential` is stricter: the process sees copies; sources can stay `root:root` `600`.

### 5. Gmail OAuth (usually not on the server)

The auth helper opens a browser and listens on `http://127.0.0.1:53682`. On a headless box that is awkward. Run it on a machine with a browser, then copy the token file.

On a laptop (same Google `clientId` / `clientSecret`):

```bash
npm run auth -- --account personal --out ./gmail.personal.refreshToken
```

Copy to the server:

```bash
sudo install -o root -g root -m 600 ./gmail.personal.refreshToken \
  /etc/mailgopher/secrets/gmail.personal.refreshToken
```

If you run auth on the server (SSH `-L 53682:127.0.0.1:53682` and open the printed URL locally), use a real `file:/etc/…` path for `clientSecret`. `$CREDENTIALS_DIRECTORY` exists only while systemd is running the service.

### 6. Install and start the unit

**Always-on** (IDLE + polling):

```bash
sudo cp /opt/mailgopher/deploy/mailgopher.service.example \
  /etc/systemd/system/mailgopher.service
sudo nano /etc/systemd/system/mailgopher.service
# fix ExecStart= if node is not /usr/bin/node
# add/remove LoadCredential= lines to match your secrets

sudo systemctl daemon-reload
sudo systemctl enable --now mailgopher.service
```

**Timer** (run `--once` every 15 minutes; you can turn `idle:` off):

```bash
sudo cp /opt/mailgopher/deploy/mailgopher-oneshot.service.example \
  /etc/systemd/system/mailgopher.service
sudo cp /opt/mailgopher/deploy/mailgopher.timer.example \
  /etc/systemd/system/mailgopher.timer
sudo nano /etc/systemd/system/mailgopher.timer   # change OnCalendar= if you want
sudo systemctl daemon-reload
sudo systemctl enable --now mailgopher.timer
```

Pick **one** mode. Do not enable both the always-on service and the timer against conflicting unit types.

### 7. Everyday commands

```bash
# Status
systemctl status mailgopher.service
systemctl status mailgopher.timer      # timer mode only
systemctl list-timers mailgopher.timer

# Logs (follow)
journalctl -u mailgopher -f
journalctl -u mailgopher --since "1 hour ago"

# Restart after config or secret changes
sudo systemctl restart mailgopher.service     # always-on
sudo systemctl start mailgopher.service       # timer: run once now

# Stop / disable
sudo systemctl stop mailgopher.service
sudo systemctl disable --now mailgopher.service
sudo systemctl disable --now mailgopher.timer
```

After **any** edit to the unit file: `sudo systemctl daemon-reload`, then restart.

After editing **only** `config.yaml` or secret file *contents*: `restart` (always-on) or wait for the next timer tick.

### 8. Update the app

```bash
cd /opt/mailgopher
sudo -u mailgopher git pull
sudo npm ci --omit=dev
sudo systemctl restart mailgopher.service
```

If `npm ci` must run as root, `chown` the tree back to `mailgopher` afterward.

### 9. Troubleshooting

| Symptom | What to check |
| --- | --- |
| `failed`, “secret file not found” | `LoadCredential=` name ≠ `${CREDENTIALS_DIRECTORY}/name`, or source path missing |
| `Environment variable "…" is missing` | `env:` ref but no `Environment=` / `EnvironmentFile=` |
| `EACCES` writing `./data` or `jobs/` | `settings.stateDir` not under `ReadWritePaths=` (`/opt/mailgopher/data`) |
| `config not found` | `MAILGOPHER_CONFIG` is wrong (use the absolute path in the unit) |
| Cannot read `~/…` | `ProtectHome=true` — don’t store config/secrets in a home directory |
| OAuth “no refresh_token” | Revoke the app at Google Account permissions; run `auth` again |
| Unit starts then exits 1 | `journalctl -u mailgopher -e` — missing secret, invalid YAML, or no refresh token |
| IMAP IDLE never fires | Provider/firewall; the process still polls on `intervalMinutes`. Timer mode does not use IDLE |
| Wrong Node path | `ExecStart=` must be the real `node` binary (`command -v node`) |

`$CREDENTIALS_DIRECTORY` is only set when systemd starts the unit. A dry-run as `mailgopher` with `file:${CREDENTIALS_DIRECTORY}/…` will fail; use `systemctl start` to test the real service.

### 10. What the unit options mean

See comments in `deploy/mailgopher.service.example`. Short version:

- `Type=simple` — process stays running (always-on).
- `Type=oneshot` — `--once`, then exit; the timer starts it again.
- `ProtectSystem=strict` — filesystem read-only except `ReadWritePaths=`.
- `ProtectHome=true` — `/home` is not readable.
- `LoadCredential=name:path` — copies `path` to `$CREDENTIALS_DIRECTORY/name` for that run only.

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
  credentials/resolve.js    # file: / env: refs
  cli/auth.js
  gmail/client.js
  fetchers/imap.js
  fetchers/pop3.js
  sync/
  store/
deploy/mailgopher.service.example
deploy/mailgopher-oneshot.service.example
deploy/mailgopher.timer.example
deploy/config.systemd.example.yaml
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
