# Moving a camera to another proxy

A proxy can hand one of its cameras to another proxy of the same cams-admin
account on the same LAN, for example to retire a proxy in favour of a new
one. The camera keeps its name, settings and history: the target takes it
over without a restart, then copies the old content, newest first. The
source deletes what the target verified when the move ends. cams-admin runs the
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
- **The target trusts cams-admin** for who the source is: the source's
  address and the fingerprint of its CA come with the offer from cams-admin,
  and the target sends the camera's new password and takes the camera on
  that word. Allow `move.receive` only on proxies of an account whose
  cams-admin you trust.
- **The proxies talk directly.** The target fetches the content from the
  source's address on the LAN, with a token for this one move. The token only
  works from the target's address as the source sees it, so put nothing
  between the two proxies that changes the address (no reverse proxy, no
  `X-Forwarded-For`; `server.trustProxy` stays 0 on the source). Before the
  switch-over a valid token from another address is refused and recorded
  (`move-token-refused`), and the offer's speed test then shows no speed; from
  the switch-over on it ends the move (`token_address`). Refused requests to
  the move endpoints are rate limited per address.
- One move at a time per proxy. The target's **profile** says how many
  cameras it may hold (`profile.cameras`, local only; `moves.maxCameras` is
  its old name, still read for one release): a move onto a target that holds
  that many is refused (`camera_limit`). **Without a profile** the target may
  hold only the cameras it has (at least 1), so set it first: the target's
  Status page asks for it ("Set this proxy's profile"), the Settings page
  edits it, `PUT /control/profile` sets it. With FTP on, the passive range
  needs 10 ports per camera: left unset, `ftp.passive` is 30000 up with 10
  ports per camera for `profile.cameras` or the cameras held, whichever is
  more (`cameras` 4: `30000-30039`; at most 10 cameras with FTP on, 100
  ports). A range set by hand that is smaller loads with the warning
  `profile_ftp_ports`, and a move that would need the missing ports is
  refused (`incompatible`, below). Open the ports in the host's firewall
  too: the profile shows the lines for each camera with FTP
  (`profile.firewall`: `ufw` or `nft`); on the multi-camera host change
  `host.json` and render instead (its ruleset is the only one).
- **No shared camera password needed.** A target without
  `CAMPROXY_CAMERA_PASSWORD` takes a new camera all the same: its password
  comes with the move (the switch-over's `secrets` step) and is stored for it.
- **Keep the commands on while a move runs.** Finishing and cancelling are
  commands too: while commands are paused on a proxy, or its `move.send`
  (source) or `move.receive` (target) is unticked, cams-admin can't finish or
  cancel the move on that side; it waits until they are back.

## Starting one

On the source, **Settings → Move to another proxy…** next to the camera (the
local admin, or a cams-admin sign-in while `move.send` is allowed). Pick the
target; it checks the offer and answers. When it can't take the camera, the
dialog shows why (no `move.receive`, it can't reach the camera, the camera id
is taken there, it is in another move, ...), followed by the target's own
detail: what failed, in one line. For example:

| reason | detail |
|---|---|
| `moves_not_allowed` | `move.receive is not allowed` |
| `busy` | `move mv_… is open here`, or `move journal unreadable` |
| `no_site_ca` | `tls.site is not set`, or `the site CA is missing` |
| `id_taken` | `camera id cam3 is in use here` |
| `camera_limit` | `3 of 3 cameras (profile.cameras)`, or `1 of 1 cameras (no profile set: set this proxy's profile)` |
| `incompatible` | too few FTP passive ports for one more camera, `ftp.passive: 10 ports (30000-30009) for 2 cameras; at least 10 per camera (profile_ftp_ports)`, or the configuration error the camera would cause, e.g. `cameras: cam3 and cam9 both use the FTP user cam9` |
| `ca_does_not_cover_camera` | `the site CA does not cover the address 192.0.2.10`, or `… the name cam3.garage.internal` |
| `camera_unreachable` | `192.0.2.10:443 not reachable within 3 s` |

The detail names settings, variables, ids and addresses, never a token, a
password or another secret's value. The target's `move-offer` audit record
and the source's `move-phase` `rejected` record carry it too.

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
  time budget, not below the estimate. The budget counts from approval,
  the switch-over included; the copy spreads over it and aims to be done at
  80 % of it. A longer budget means a gentler copy;
- that the source deletes the camera's content the target verified when the
  move ends; what could not be copied (failed or missing files, Archive items
  not copied) stays on the source and ages out with its retention. Audit
  records stay.

**Approve move** starts it. Approving here, or the auto-approval within the
bounds cams-admin started the move with, is the only approval: it covers the
settings and limits named on the panel. An offer not approved within 30
minutes expires: after 35 minutes both proxies close it on their own
(`move-cancel`, reason `offer_expired`), even when cams-admin is away.

### Started from cams-admin

cams-admin can start a move on the source with the command `move.begin`
(under `move.send`, like the page). The source runs the same checks as its
page and answers with the request, or with the reason it refuses
(`no_site_ca`, `external_cert`, `moves_not_allowed`, `busy`,
`unknown_camera`). The camera's password stays on the proxy; the command and
its answer carry none.

cams-admin may add bounds: whether to transfer content, which kinds, what to
do when it doesn't fit, and the longest time budget. When the target's answer
arrives and accepts, the source builds the plan the panel would build and
approves it itself, as a click on **Approve move** would, if it fits the
bounds:

- the estimated time is within the bounds' time budget (also when nothing is
  transferred);
- the space choice is possible (when the content fits on the target, every
  choice means copy everything);
- the kinds are those of the bounds, limited to what exists;
- the time budget is the panel's (whole minutes, not below the estimate),
  capped at the bounds' budget.

Otherwise the offer waits on the panel for a person, with the reason shown
there and in the audit log. The reasons are a closed list: `over_budget`
(the estimate is above the bounds' budget), `space` (the space choice is not
possible), `no_estimate` (cams-admin gave no estimate), `not_allowed` (this
proxy does not allow moves now, for example `move.send` was taken away
meanwhile) and `plan` (the plan was refused, with its detail). A rejected
answer is not noted. A move started without bounds, from the page, is never
approved by the source itself.

## What happens

1. **Switch-over** (seconds to minutes). The target adds the camera live
   with the source's settings, fetches its password, pushes its own
   certificate to the camera and points the camera's FTP upload at itself.
   The source keeps running the camera until the target has it, so no
   minute of stills is lost; then it hides the camera.
2. **Copy.** The target pulls the content, Archive first (newest first),
   then the rest newest day first, each file checked by size and SHA-256.
   With "copy as much as fits" the plan stops at the first Archive day that
   doesn't fit: everything after it (Archive and the other kinds) waits or is
   skipped, so an Archive item is never left out for the sake of a newer
   still. A file the source's retention deleted
   meanwhile is skipped; a file that fails its check three times is reported
   (`move-file-failed`). The copy halves its speed while either proxy is
   busy, waits while the target's storage is paused, and resumes after a
   restart of either proxy. Over the budget it goes on, never faster
   (`move-budget-exceeded`, once).
3. **The check.** Before the move concludes, the target compares what the
   source lists now with what it verified. Per kind it counts files
   *complete*, *missing* (still on the source: one recovery pass copies them
   again), *failed* (failed their check three times) and *expired* (the
   source's retention removed them meanwhile). The result is the audit
   record `move-check` and is shown in cams-admin; failed and missing files
   after the recovery pass make the copy "not complete". The one still of
   the overlap minute, which both proxies recorded, counts as present and
   is kept on the source (it holds the seconds before the switch-over).
4. **End.** The target reports to the source, file by file, what to
   keep (failed, missing, its own and whole chunks). When cams-admin finishes the move, the source deletes only
   that, plus its stored password and certificate; the target deletes its
   temporary files and the move's keys. The camera now belongs to the
   target. What the source keeps stays under its retention and ages out
   with it: failed and missing files, the overlap still, and every Archive
   item that was not copied. An Archive item with no expiry stays until you
   delete it by hand; it carries a "Kept here" note that says why
   ([docs/archive.md](archive.md)). Without the target's report (it refused
   it, or it did not arrive), the source keeps every Archive item and deletes
   the rest, as `move-outcome-refused` records. Both proxies tell cams-admin
   how long the rest ages out (`keepDays`: the longest of the retention
   settings, at least 7 days) when a move finishes or is cancelled.

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
  not copied yet is given up, and the source cleans up as at a normal end,
  deleting only what the target had verified. While Archive items are still
  copying, cams-admin's button reads **End after Archive**: the move keeps
  copying until the Archive part is done and then ends. An Archive item that
  still couldn't be copied stays on the source.
- **Cancel move…** (the Status page, or cams-admin) before the switch-over:
  nothing changed on the source; the move just closes.
- **Cancel after the switch-over:** the camera comes back at once. The
  target drops it first; the source runs it again, pushes its own
  certificate and points the camera's FTP upload back at itself. If a step
  of that fails, the source tries again by itself, with a backoff, also after
  a restart, and records each failure (`move-cancel`, at most once an hour);
  no other move starts meanwhile.
- **The copy back.** What the new proxy recorded itself since the switch-over
  is then copied back to the original, which keeps its own older content.
  There is no "delete what was copied" or "let it age out" choice any more
  after the switch-over: the content the move copied to the new proxy is
  removed there when the copy back ends, and so is what the original
  verified. The copy back:
  - is not cancellable and not paced (no time budget; it is the original's
    own content), but halves its speed while either proxy is busy;
  - pauses (`move-paused`) when the next chunk doesn't fit on the original
    without deleting anything, when it would leave less than 5 % of the
    storage budget free, or when the original's storage deleted content for a
    size cap or budget within the last hour: it never pushes out older
    original content, so on a full original it waits until someone frees room;
  - retries on its own after a failure or a restart;
  - sends its own report of what the original verified; what failed stays on
    the new proxy and ages out with its retention.
- **Give up** (cams-admin) on a copy back deletes nothing on either proxy:
  what was copied back stays, the rest ages out where it is.
- Before the switch-over, a cancel changes nothing on the source; the move
  just closes (the choice "Delete what was copied on the target" applies
  only there).

## Leftovers

**Settings → Reset to defaults** keeps `cameras.<id>.moved`: it is the state
of a move, not a setting. Clearing it by hand (its **Reset**) is refused
while the move is open here or after the move took the camera away for good
(`move_open`); a cancel brings the camera back.

When a move ends, each proxy keeps a small note of it for 7 days
(`data/admin/moves/<moveId>.<role>.ended.json`: the move's id, how it ended
and the counts, nothing secret). With it a repeated finish or cancel from
cams-admin, even after a restart, gets the same answer and the end is
reported again. A camera that once moved away and comes back is taken only
when it is the same camera (address, protocol and user); the target then
replaces its old entry whole with the moved settings. An old entry it can't
replace (a `tlsName`, a PoE switch port, a storage share in `config.json`,
or a `CAMPROXY_CAMERA_PASSWORD_<ID>` in the environment) fails the move
(`camera_failed`, `stale_leftover`): remove it first.

The proxy never writes `config.json`. A camera from `config.json` stays there
after the move, hidden (`cameras.<id>.moved` = the move's id): it doesn't run,
isn't listed and its FTP user is refused. Settings lists it as moved; delete
it from `config.json` when convenient. A camera added on the Settings page
(`overrides.json`) is removed at the end.

A proxy whose last camera moved away keeps running: cams-admin, the pages and
the health summary work. The health has one Camera item, "no camera runs on
this proxy", which is no problem, and no stream, events or FTP items; so a
retired proxy still reports ok.

## In the audit log

Both proxies record the move with its `moveId`, `camera`, `source`, `target`
and `role`; never the password, the token or a key. The actions, each in
[docs/audit-log.md](audit-log.md):

| side | actions |
|---|---|
| source | `move-request` (started on its page, or by cams-admin with `move.begin`), `move-approve` (a person, or the auto-approval, named in its label), `move-auto-approve` (the offer waits for a person, with the reason), `move-switch` (`go`), `move-phase` (`opened`, `switching`, `released`, `finished`, `cancelled`, `failed`), `move-cleanup`, `move-done`, `move-cancel`, `move-outcome-refused` (the report of what to keep did not arrive), `move-return` (the copy back: `open`, `finish`), `move-token-refused` (a refused request to its move endpoints) |
| target | `move-offer` (its answer), `move-switch` (`start`, `secrets`, `camera`, `cert`, `ftp`), `move-phase` (`switching`, `switched`, `copying`, `copied`, `finished`, `cancelled`, `failed`), `move-progress` (every 10 %), `move-check` (the completeness check), `move-budget-exceeded`, `move-paused` (a copy back waits for room), `move-return` (`start`, `finish`), `move-file-failed`, `move-source-unreachable`, `move-done`, `move-cancel` |

A normal move shows, in this order: `move-request` and `move-approve` on the
source (no `move-auto-approve`: that record means the offer is waiting), `move-offer` and the `move-switch` steps on the target, `released` on
the source, `move-progress` up to `copied` on the target, then `move-cleanup`
and `move-done` on the source and `move-done` on the target.
