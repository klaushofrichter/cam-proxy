# Moving a camera to another proxy

A proxy can hand one of its cameras to another proxy of the same cams-admin
account on the same LAN, for example to retire a proxy in favour of a new
one. The camera keeps its name, settings and history: the target takes it
over without a restart, then copies the old content, newest first. The
source deletes the camera's content when the move ends. cams-admin runs the
steps; both proxies record each one in their audit log. The design:
[the spec](superpowers/specs/2026-10-21-camera-move-design.md).

## Before a move

- **Both proxies need a site CA** (`tls.site`, [TLS: the site
  CA](../README.md#tls-the-site-ca)), and the target's CA must cover the
  camera's address. The Raspberry Pi has none, so it never takes part: every
  move to or from it is refused (`no_site_ca`). A camera whose certificate is
  managed elsewhere (`tlsName`, a public name) can't be moved
  (`external_cert`).
- **The allow entries**, on each proxy's cams-admin card
  ([docs/cams-admin.md](cams-admin.md#allowed-commands)), off by default:
  `move.send` on the source (cams-admin may move a camera away, after you
  approve it here), `move.receive` on the target (cams-admin may hand it a
  camera). Only the proxy's own admin token can tick them.
- **The proxies talk directly.** The target fetches the content from the
  source's address on the LAN, with a token for this one move. The token only
  works from the target's address as the source sees it, so put nothing
  between the two proxies that changes the address (no reverse proxy, no
  `X-Forwarded-For`; `server.trustProxy` stays 0 on the source). A valid token
  from another address ends the move (`token_address`).
- One move at a time per proxy. `moves.maxCameras` (local only, no limit by
  default) caps how many cameras a target may run.

## Starting one

On the source, **Settings → Move to another proxy…** next to the camera (the
local admin, or a cams-admin sign-in while `move.send` is allowed). Pick the
target; it checks the offer and answers. When it can't take the camera, the
dialog shows why (no `move.receive`, it can't reach the camera, the camera id
is taken there, it is in another move, ...).

When it can, one panel shows:

- the settings that move with the camera (name, poll interval, FTP, stills,
  storage share, analytics, events);
- the content per kind (stills, clips, events, still checks, Archive) with
  sizes and days, and whether to transfer it at all;
- if it doesn't all fit on the target: leave kinds out, **raise the limits on
  the target**, or copy as much as fits, newest first. The limits are the
  target's host-wide ones (`stills.maxGB`, `previews.maxGB`, `ftp.maxGB`, and
  `storage.maxBytes` when the disk holds more): raising them applies to every
  camera on the target, not only this one;
- the estimated time (from a short speed test between the proxies) and the
  time budget, not below the estimate. The copy spreads over the budget; a
  longer budget means a gentler copy;
- that the source deletes all the camera's content when the move ends,
  copied or not. Audit records stay.

**Approve move** starts it. Approving is the only approval: it covers the
settings and limits named on the panel.

## What happens

1. **Switch-over** (seconds to minutes). The target adds the camera live
   with the source's settings, fetches its password, pushes its own
   certificate to the camera and points the camera's FTP upload at itself.
   The source keeps running the camera until the target has it, so no
   minute of stills is lost; then it hides the camera.
2. **Copy.** The target pulls the content, newest day first, each file
   checked by size and SHA-256. A file the source's retention deleted
   meanwhile is skipped; a file that fails its check three times is reported
   (`move-file-failed`). The copy halves its speed while either proxy is
   busy, waits while the target's storage is paused, and resumes after a
   restart of either proxy. Over the budget it goes on, never faster
   (`move-budget-exceeded`, once).
3. **End.** When cams-admin finishes the move, the source deletes the
   camera's content and its stored password and certificate; the target
   deletes its temporary files and the move's keys. The camera now belongs
   to the target.

The Status page shows a move in progress: phase, copied of total, time left,
an over-budget note, or the reason a move failed.

### What moves, and what doesn't

- **Password:** only the camera password the proxy itself uses (stored per
  camera in `data/admin/camera-passwords.json`) travels, sealed to a key the
  target makes for this move. A password from the environment
  (`CAMPROXY_CAMERA_PASSWORD`, `.env`) wins on either proxy; the source's
  `.env` value is not deleted at the end.
- **FTP:** the camera uploads to the target's own FTP user and password.
- **Retention:** retention and size limits are host settings and don't
  move; the target's apply from the switch-over. Content older than the
  target keeps ages out there after the copy.
- **Not copied:** the stream log, analytics usage counters and the
  recordings cache (SD recordings stay on the camera).

### A stalled copy

A source that answers busy (503) only slows the copy down. A source that
doesn't answer, or keeps refusing, is retried with a backoff for as long as
it takes and recorded as `move-source-unreachable` at the first failure and
every 6 hours. The copy is never cut for being slow: a move that stays
stuck needs a cancel.

## Ending a transfer early, cancelling

- **End transfer** (cams-admin): the camera stays on the target, the content
  not copied yet is given up, and the source cleans up as at a normal end.
- **Cancel move…** (the Status page, or cams-admin) before the switch-over:
  nothing changed on the source; the move just closes.
- **Cancel after the switch-over:** the camera goes back to the source. The
  target drops it first; the source runs it again at once, pushes its own
  certificate and points the camera's FTP upload back at itself. If a step of
  that fails, the source tries again by itself, with a backoff, also after a
  restart, and records each failure (`move-cancel`, at most once an hour); no
  other move starts meanwhile.
- **What was copied:** **Delete what was copied on the target** deletes only
  the content this move copied there. What the target captured itself since
  the switch-over stays on the target and ages out with its retention; it is
  not sent back to the source. **Let it age out there** keeps the copy until
  the target's retention removes it.

## Leftovers

The proxy never writes `config.json`. A camera from `config.json` stays there
after the move, hidden (`cameras.<id>.moved` = the move's id): it doesn't run,
isn't listed and its FTP user is refused. Settings lists it as moved; delete
it from `config.json` when convenient. A camera added on the Settings page
(`overrides.json`) is removed at the end.

A proxy whose last camera moved away keeps running (cams-admin, the pages and
the health summary work; the health shows "no camera runs on this proxy").

## In the audit log

Both proxies record the move with its `moveId`, `camera`, `source`, `target`
and `role`; never the password, the token or a key. The actions, each in
[docs/audit-log.md](audit-log.md):

| side | actions |
|---|---|
| source | `move-request` (started on its page), `move-approve`, `move-switch` (`go`), `move-phase` (`opened`, `switching`, `released`, `finished`, `cancelled`, `failed`), `move-cleanup`, `move-done`, `move-cancel`, `move-token-refused` (a refused request to its move endpoints) |
| target | `move-offer` (its answer), `move-switch` (`start`, `secrets`, `camera`, `cert`, `ftp`), `move-phase` (`switching`, `switched`, `copying`, `copied`, `finished`, `cancelled`, `failed`), `move-progress` (every 10 %), `move-budget-exceeded`, `move-file-failed`, `move-source-unreachable`, `move-done`, `move-cancel` |

A normal move shows, in this order: `move-request` and `move-approve` on the
source, `move-offer` and the `move-switch` steps on the target, `released` on
the source, `move-progress` up to `copied` on the target, then `move-cleanup`
and `move-done` on the source and `move-done` on the target.
