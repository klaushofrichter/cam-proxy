# cams-admin: reporting to the fleet registry

[cams-admin](https://github.com/klaushofrichter/cams-admin) keeps a registry
of cam-proxies and shows their health on one dashboard. A proxy reports to it
over one **outbound** WebSocket: cams-admin can't connect to a proxy, and in
this version it can't tell a proxy to do anything. The protocol and the design
are cams-admin's spec `docs/superpowers/specs/2026-10-06-cams-admin-phase1-design.md`
(§8 protocol, §9 this proxy's side); the wire format is cams-admin's
`contract/v1/`, vendored here in `test/contract/cams-admin-v1/`.

**Off unless configured.** Without `camsAdmin.url` the proxy opens no
connection, starts no timer, reads and writes no `data/admin/` folder and has
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
| `camsAdmin.keyFile` | `admin/key.json` | relative to `server.dataDir`, inside it |
| `camsAdmin.enabled` | `true` | `false` keeps the key and stays off |
| `camsAdmin.allowCommands` | `[]` | reserved for commands from cams-admin (a later phase); anything in it is a config error in this version. Not a Settings-page setting |

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

## The contract

`test/contract/cams-admin-v1/` is a copy of cams-admin's `contract/v1/`
(`SOURCE` names the commit). `test/fleet-contract.test.ts` reproduces the
signature vectors byte for byte, and the hello, enrollment request and
heartbeats (one camera, four cameras, truncated) must pass the **strict**
schemas: a new health-summary field fails here until cams-admin's contract
has it. The `contract-drift` CI step (`scripts/contract-drift.sh`) fails when
the copy differs from cams-admin main's (until cams-admin main has
`contract/v1`, from the `SOURCE` commit). To take a new contract: copy it
over and update `SOURCE` in the same PR.

## Testing against a real cams-admin

cams-admin's local stack (`scripts/localstack/start.sh` in that repo, ports
29xxx) runs cams-admin with cam-proxies and cam-sims on the Mac; enroll a
proxy there with `admin-enroll --url http://127.0.0.1:29000` and the code
from its UI. Never against the Pi, the cluster or a real S3 bucket.
