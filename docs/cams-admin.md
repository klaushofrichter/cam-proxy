# cams-admin: reporting to the fleet registry

[cams-admin](https://github.com/klaushofrichter/cams-admin) keeps a registry
of cam-proxies and shows their health on one dashboard. A proxy reports to it
over one **outbound** WebSocket: cams-admin can't connect to a proxy. Over
that channel it may send **signed commands**, and the proxy runs only the ones
allowed **on this proxy** (none by default; see [Commands](#commands-from-cams-admin)).
The protocol and the design are cams-admin's specs
`docs/superpowers/specs/2026-10-06-cams-admin-phase1-design.md` (§8 protocol,
§9 this proxy's side) and `…/2026-10-06-cams-admin-migration-design.md`
(commands and managed tokens, M §7, §10); the wire format is cams-admin's
`contract/v1/`, vendored here in `test/contract/cams-admin-v1/`.

**Off unless configured.** Without `camsAdmin.url` the proxy opens no
connection, starts no timer, writes no `data/admin/` file (it reads
`tokens.json` only if one exists: managed tokens outlive the channel) and has
no new health item or metric. The Pi runs exactly as before until it is
enrolled (`test/pi-compat.test.ts`).

## Enrolling

1. In cams-admin: create the proxy record, then **Create enrollment code**.
   The code (`CAE1-XXXX-XXXX-XXXX-XXXX-XXXX`) is shown once, valid 24 h, and
   works once.
2. On the proxy, either
   - the **Status page → cams-admin card**: the cams-admin URL and the code
     (a password field), **Enroll**; or
   - the CLI, with the code on stdin (a prompt, or a pipe):

     ```sh
     docker compose exec cam-proxy node dist/src/cli.js admin-enroll --url https://cams-admin.skylar.technology
     # Enrollment code from cams-admin: CAE1-…
     ```

     The code is **never** an argument (shell history, the process list); the
     CLI refuses one. With the proxy running, the CLI asks it to enroll
     through its control API (the card's code path, with the admin token
     from the environment), so it connects at once. With the proxy stopped,
     the CLI writes the key file and the override itself; the next start
     connects.
3. The proxy generates an Ed25519 key pair, redeems the code
   (`POST <url>/proxy/v1/enroll` with a proof of the key), pins cams-admin's
   public key from the answer, writes `data/admin/key.json` and sets
   `camsAdmin.url` in `overrides.json`. It shows (and the CLI prints) the
   proxy id, the account and the key fingerprint; cams-admin shows the same
   fingerprint on the proxy's page.

Enrolling again (a lost key file, a rotation) replaces the key file
atomically; a failed redemption leaves the old one untouched. **Unenroll**
(card or `admin-unenroll`) says `bye unenrolled` (cams-admin revokes the key),
deletes the key file and clears the override. Both are audited
(`admin-enroll`, `admin-unenroll`) with the outcome, the URL, the proxy id and
the fingerprint, never the code.

## Settings

| setting | default | |
|---|---|---|
| `camsAdmin.url` | unset (off) | `https://…`; plain `http://` only for loopback and `*.svc.cluster.local` (the cluster's proxy reaches cams-admin over its Service). Anything else is a config error |
| `camsAdmin.keyFile` | `admin/key.json` | `admin/<name>.json` in `server.dataDir` (letters, digits, `-`, `_`); nothing else, so the data folder and `overrides.json` are never touched |
| `camsAdmin.enabled` | `true` | `false` keeps the key and stays off |
| `camsAdmin.allowCommands` | `[]` | the commands cams-admin may send (deploy-time base; `data/admin/policy.json`, written by the Status card and `admin-commands`, replaces it). `config.json` only: never in `overrides.json`, refused by `PUT /control/config` (`not_a_setting`). An unknown or never-remote entry is a config error |
| `camsAdmin.commandsPaused` | `false` | refuse every command (`paused`); `config.json` only |

All apply at once: a change restarts only the client (the old connection says
`bye` first; never two connections).

## The key file

`<dataDir>/admin/key.json`, mode 600 in a 700 folder, written atomically
(random temp file, fsync, rename). It holds the proxy's private key: never
print, copy, log or serve it, and keep it out of backups you share. The proxy
refuses a key file that others can read or that belongs to another user
(state `key-unsafe`, e.g. a restored backup with mode 644: `chmod 600` it, or
enroll again). Losing it means enrolling again.

## What is sent

- After the signed handshake (cams-admin's challenge is checked against the
  pinned key; the proxy's `hello` is signed with its key), a **heartbeat**
  right away, then every 30 s (cams-admin's `ack` may slow it, never below
  10 s), and early when the summary's `ok`, its problem count or a camera's
  online flag changes (at most one per 10 s).
- The heartbeat is the health summary exactly as `GET /api/local/health`
  serves it, plus `startedAt`, uptime, the config schema version
  (`CONFIG_SCHEMA` in `src/config/schema.ts`), the site name and CA
  fingerprint (with `tls.site`) and `server.publicUrl`. Texts are cut to 200
  characters; a heartbeat over 192 KiB sends only the items and each camera's
  id block and items (`truncated: true`).
- Never: tokens, passwords (camera, FTP, PoE switch), private keys, the
  Vision key, overrides, clips, stills or event payloads. `test/fleet-config.test.ts`
  sets every secret to a marker and checks nothing marked leaves.

## Connection states

The Status page's cams-admin card (`GET /control/admin`) and
`camproxy_cams_admin_state{state}` show:

| state | meaning |
|---|---|
| not enrolled | no `camsAdmin.url` (off), no key file, or a key file made for another URL |
| off | `camsAdmin.enabled` is false |
| connecting / connected | |
| disconnected, retrying | backoff: full jitter up to 5 min, reset after 60 s connected |
| rejected | cams-admin refused the key (4401/4403, a revoked key) or its challenge didn't verify: re-enroll. Retried every 15 min, logged once |
| incompatible | cams-admin doesn't speak `cams-admin.v1` (an HTTP 426): update one side. Retried every 6 h |
| key file unsafe / unreadable | see above; the key is never used |

Close codes: 4409 (another connection with the same key) waits 30 s first;
4429 waits cams-admin's `retryAfterS`; 1001/1011 and network errors back off
normally. Three heartbeats without an `ack` (a half-open link) close and
reconnect. Logs: `admin_connected`, `admin_disconnected`, `admin_rejected`,
`admin_incompatible` at info once per change; `admin_client_error` and
`admin_server_untrusted` at warn; the rest at debug.

## Never in the way

The client is a leaf (`src/fleet/`): one socket, one timer, one heartbeat in
flight, nothing queued, every handler wrapped (a failure is logged and becomes
a reconnect). Connect and handshake time out after 10 s; a socket whose close
cams-admin never answers counts as closed after 2 s. Node's WebSocket can't
drop such a socket, so at most 4 may linger before the client stops opening
new ones. On shutdown it says `bye` and closes within 1 s, before the HTTP
server, inside the 15 s budget. `test/fleet-isolation.test.ts` runs events,
FTP clips, stills and the API against a cams-admin that never answers, sends
garbage, closes every second, answers 4401, never acknowledges, and a
blackholed link.

## Commands from cams-admin

cams-admin may send a **command** over the channel (contract `command`,
signed with its key over the canonical JSON of the envelope, RFC 8785). The
proxy checks it in this order; the first refusal wins (contract "Check order"):

| step | check | refusal |
|---|---|---|
| 1 | the body has a `cmdId` | `error bad_message` (no result) |
| 2 | the signature verifies against a pinned cams-admin key | `bad_signature` |
| 3 | `proxyId` is this proxy's and `connId` this connection's | `wrong_target` |
| 4 | the envelope id was not seen on this connection | `replayed` |
| 5 | `exp` is 1 ms to 60 s after `ts`, and not older than 120 s on cams-admin's clock as measured at the handshake (the Pi has no RTC: its own clock never decides). A handshake whose signed time is more than 5 minutes older than the newest one seen is not answered (a replay) | `expired` |
| 6 | the `cmdId` is in the journal: its stored answer again, `duplicate: true`; nothing runs | |
| 6b | the `cmdId` was seen before (another connection, before a restart) and is not in the journal | `replayed` |
| 7 | `CAMPROXY_ADMIN_COMMANDS` is on and commands are not paused | `paused` |
| 8 | this version runs the command and it is allowed here | `not_allowed` |
| 9 | 30 commands a minute, 300 a day, `tokens.apply` 6 an hour | `rate_limited` (with `retryAfterS`) |
| 10 | `args.v` is 1 and the args pass the command's strict check (at most 16384 bytes) | `unsupported_version`, `invalid_args` |
| 11 | a token set with an admin token also needs `tokens.apply.admin` | `not_allowed` |
| 12 | no other command runs | `busy` |

Then a signed `result` `received`, the command, the journal entry, and a
signed `result` `done` (`ok`, `failed`, `conflict`). A `done` that could not
be sent goes out as a signed `command.done` event after the next handshake.
Refusals are signed results too (at most 60 a minute; the rest are dropped
and counted) and are not journaled. A connection that sends more than 20
unsigned or malformed commands is closed.

### Allowed commands

Nothing is allowed until someone allows it **here**: on the Status page's
cams-admin card (**Commands from cams-admin**), with
`cam-proxy admin-commands allow <entry…>`, or in `config.json`
(`camsAdmin.allowCommands`). The entries:

| entry | lets cams-admin |
|---|---|
| `tokens.apply` | add, rotate and revoke managed **client** tokens for cams (`CAMPROXY_TOKENS` keeps working) |
| `tokens.apply.admin` | also manage **admin** tokens (sign-in links, camera rename); the local admin token is never affected |
| `config.get`, `config.set`, `config.unset`, `config.rollback`, `camera.name.set`, `proxy.restart`, `camera.action:<action>` | not in this version (known names, so a later `config.json` loads; allowing them does nothing yet) |

Camera actions that change trust, delete data or need someone at the
hardware (`find-camera`, `camera-address`, `camera-trust-clear`,
`tls-ca-rotate`, `tls-ca-drop-previous`, `archive-clear`, `inventory-repair`,
`camera-poe-on`) can never be allowed. Settings under `camsAdmin`, `server`,
`go2rtc`, `tls`, `poeSwitch`, the FTP ports and files, `ntp.server`,
`composition.font` and each camera's address, user, ports and TLS name can
never be changed by cams-admin (`isDeniedPath` in `src/fleet/policy.ts`).

**Widening is local only.** Adding an entry, resuming and unblocking a token
need the proxy's own `CAMPROXY_ADMIN_TOKEN` (or a session signed in with it,
or a sign-in link it minted). A cams-admin-managed admin token, and a session
or link it started, can only **narrow**: untick, pause, block (403
`local_admin_only` otherwise). So a compromised cams-admin can't allow itself
more.

### Pause and the kill switch

- **Pause** (card, `admin-commands pause [reason]`, `camsAdmin.commandsPaused`):
  every command is refused `paused`; the heartbeat says so. Any admin can
  pause; only local admin rights resume.
- **`CAMPROXY_ADMIN_COMMANDS`** in the process environment or the `.env` file
  (`CAMPROXY_ENV_FILE`): unset or `on` = commands possible; `off`, empty or
  anything else = off (fail closed; either source not saying `on` wins).
  **Read only at start: a change takes a proxy restart** (`docker compose up -d`
  on the Pi after editing `.env`, a rollout in the cluster). While it is off
  the hello doesn't announce `commands` (cams-admin then sends none and shows
  the proxy as not supporting commands), and any command that arrives anyway
  is refused `paused`. cams-admin can't change it; the card shows the banner.

### Managed tokens

`tokens.apply` installs cams-admin's full set of managed tokens: only their
**hashes** (`sha256:` + hex) with an id, a kind (`client` or `admin`), a label
and an optional `retireAt` (a rotation: the old token keeps working until
then). They work **beside** `CAMPROXY_TOKENS` and `CAMPROXY_ADMIN_TOKEN`
(access order: local admin, managed admin, local client, managed client,
audit). A set whose revision is not newer is answered `stale` with the
proxy's revision and changes nothing (a cams-admin restored from an older
backup can't bring a revoked token back). A hash equal to a local token's is
refused (`shadows_local_token`). The tokens keep working when cams-admin is
down or the proxy is unenrolled; `CAMPROXY_TOKENS` may be left unset while a
managed client token is live.

**Local block:** the card's **Block** (or `cam-proxy admin-tokens block <id>`)
stops a managed token at once. The block holds the token's hash as well as its
id: `tokens.apply` never brings it back, under the same id or a new one, and
never removes a block. At most 64 blocks; at the cap a new one is refused (409
`too_many_blocks`), none is ever evicted. Managed admin rights block only
tokens that exist in the set (404 `unknown_token` otherwise).
**Unblock** (local admin rights) drops the entry; cams-admin's next
`tokens.apply` installs it again if it still lists it.

### The files in `data/admin/`

All mode 600 in the 700 folder, written atomically, refused when others can
read them or they belong to another user; never printed, logged or served.

| file | holds | written by |
|---|---|---|
| `key.json` | the proxy's private key | enrollment |
| `tokens.json` | the managed token hashes, their revision, the local block list | `tokens.apply`, Block/Unblock |
| `commands.json` | the journal: the final result of the last 1000 commands (and all of the last 7 days, at most 2500) | each command that ran |
| `policy.json` | the allowed commands and the pause | the card, `admin-commands` |
| `replay.json` | the newest signed challenge time seen and the command ids seen (accepted or refused) until they expire: a recorded session replayed later (e.g. on the plain-http in-cluster path) is refused, also after a restart | each handshake and command |
| `replay-mark.json` | the same newest challenge time again: if `replay.json` is unusable this one holds; if both are unusable no handshake is answered (fail closed) until they are fixed or removed (removing both = a fresh start) | each handshake |

An unusable `policy.json` pauses every command until it is fixed; an
unusable `tokens.json` makes no managed token match (local tokens are
unaffected) and refuses `tokens.apply` (`store_error`), Block and Unblock
until it is fixed or removed; an unusable `commands.json` is set aside
(`commands.json.bad-<ms>`) on the next command.

### Audit

`admin-command` (each command that ran; refusals at most one per code per
10 minutes), `admin-policy` (allowed commands, pause, resume) and
`admin-token` (block, unblock); `docs/audit-log.md`. Managed tokens appear
by id and label, never by hash.

### Cut-over (M §11.4, steps 1-2)

1. On this proxy's card, signed in with its **own** admin token, allow
   `tokens.apply` (and `tokens.apply.admin` if cams should get a managed
   admin token).
2. cams-admin issues the tokens; Klaus (through the kube-setup session) puts
   them into cams's configuration; check cams.
3. Rollback at any step: remove the managed token from cams (its
   `CAMPROXY_TOKENS` value never stopped working), or Pause on the card.

### Recovery: cams-admin compromised

1. Set `CAMPROXY_ADMIN_COMMANDS=off` in the `.env` file (the Pi) or the
   environment and restart the proxy: no command runs, whatever cams-admin
   sends.
2. Block every managed token on the card (or `admin-tokens block <id>`).
3. If a UI session may have leaked, rotate `CAMPROXY_ADMIN_TOKEN` (a restart
   signs every session out).

## Threat notes (accepted risks)

- **Large messages from cams-admin.** Node's built-in WebSocket has no
  payload option (`maxPayloadSize` is ignored, measured on Node 26.8.1 /
  undici 8.10.0): it buffers a whole message, up to its own limit of 128 MiB,
  before the client sees it and refuses anything over 256 KiB. Measured on
  the Mac: a 100 MiB message peaks at ~150 MB RSS, a 127 MiB one at ~190 MB,
  briefly; a 200 MiB one is closed by Node (1006) at ~55 MB. Only a
  compromised cams-admin (or something on the in-cluster `http` path) can
  send one. After an oversize message the connection closes and the backoff
  is **not** reset, however long it was up, so the spikes come at most once
  per backoff step (up to 5 min apart). Avoiding it would need a WebSocket
  implementation of our own or a dependency; accepted for this phase.
- **Answers are read with a cap.** The enrollment answer at most 64 KiB, the
  426 probe at most 4 KiB, the CLI's `/health` probe at most 4 KiB; a longer
  or endless body is dropped at once. At most 20 messages of an unsupported
  type are answered per connection (none while the socket isn't draining);
  more close it.
- **The channel stays on cams-admin's host.** The `connectUrl` of the
  enrollment answer must be on the same host as `camsAdmin.url`.
- **The CLI only talks to a cam-proxy.** It sends the admin token and the
  code only when the proxy's port answers `/health` as a cam-proxy; if the
  port answers otherwise or not in time it does nothing (it never writes
  `overrides.json` behind a running proxy).
- **CodeQL `js/request-forgery`** on the enrollment request is an accepted
  finding (`.github/codeql-accepted.tsv`): contacting the URL the admin gives
  is the request's purpose.

## The contract

`test/contract/cams-admin-v1/` is a copy of cams-admin's `contract/v1/`
(`SOURCE` names the commit). `test/fleet-contract.test.ts` reproduces the
signature vectors byte for byte, and the hello, enrollment request and
heartbeats (one camera, four cameras, truncated) must pass the **strict**
schemas: a new health-summary field fails here until cams-admin's contract
has it. The `contract-drift` CI step (`scripts/contract-drift.sh`) fails when
the copy differs from cams-admin's: the branch `SOURCE` names (`(contract/v1,
main)` normally; a cams-admin branch while a contract change is in review).
To take a new contract: copy it over and update `SOURCE` in the same PR.
`test/fleet-jcs.test.ts` reproduces the canonical-JSON and signed-envelope
vectors byte for byte, and `test/fleet-command-check.test.ts` runs every
command fixture through the proxy's check (cams-admin runs the same check
from a cam-proxy checkout: `scripts/contract/cam-proxy-commands.ts` there).

## Testing against a real cams-admin

cams-admin's local stack (`scripts/localstack/start.sh` in that repo, ports
29xxx) runs cams-admin with cam-proxies and cam-sims on the Mac; enroll a
proxy there with `admin-enroll --url http://127.0.0.1:29000` and the code
from its UI. Never against the Pi, the cluster or a real S3 bucket.
