# Moving a camera from one proxy to another (design)

Status: draft for Klaus's review, 2026-10-21 (builder check done; Klaus answered its three questions). Repos: cam-proxy (most of the
work), cams-admin (runs the move), cams (applies the move without a held
change). Decisions marked **Klaus** were made by him in the brainstorming
session on 2026-10-21; decisions marked **my call** are the designer's and can
be overridden.

## 1. Intent

Move one camera from one cam-proxy (the **source**) to another (the
**target**) in the same account and on the same LAN, for example to retire a
proxy in favour of another. After the move, cams users see the same camera
with the same name and history, served by the target. The user asks for the
move once, approves one confirmation panel, and the rest runs on its own;
what happened is visible in the audit logs.

## 2. Goals, non-goals, anti-goals

Goals
- One request, one confirmation panel, then no further human interaction
  (**Klaus**): no password re-entry, no held-change Confirm in cams, no
  kube-setup step.
- No gap in new content: the target takes over capture before the source
  stops.
- The camera's content under retention moves to the target, newest first,
  within a time budget the user approved.
- A move interrupted by a restart, power loss or network outage carries on
  from where it stopped.
- Every decision, action, status change and the completion are audit events.

Non-goals (now)
- Moving across accounts (later, §16).
- Moving a camera physically to another network or site (later, §16). The
  camera stays where it is; only the proxy that serves it changes.
- Serving not-yet-copied content from the source on request (**Klaus**: cams
  shows empty placeholders until it arrives).
- Transferring audit logs (**Klaus**: history is not rewritten; §11).
- Encrypting content on the LAN (**Klaus**). Passwords are a different
  matter (§9.3).
- Adding or removing a camera while a proxy runs (**Klaus**, 2026-10-21):
  the move restarts the proxy process where needed (§9.1).
- Proxies without a site CA (the Pi), cameras whose certificate comes from
  elsewhere (cam1's cluster `cam1-cert-push` CronJob), and targets whose site
  CA doesn't cover the camera's address (**Klaus**: rejected with a reason in
  the first version, §6).

Anti-goals (a move that does these has failed even if it "worked")
- The camera ends up served by both proxies, or by neither, for longer than
  the switch-over itself.
- Content is deleted on the source before the target has it, other than by
  the source's own normal retention.
- A camera password passes through cams-admin, a log, an audit record, or the
  LAN in clear text.
- A move can be started against a target whose local admin never allowed
  incoming moves.

## 3. Terms

- **Move**: one job, id `mv_<ulid>`, owned by cams-admin.
- **Content**: what the source holds for the camera under retention: clips
  (with their FTP pictures), stills and previews/sprites, events, analysis
  results and still checks, Archive items. The recordings cache (fetched from
  the SD card) is a cache, not content, and is not moved. The SD card stays
  in the camera.
- **Manifest**: the source's list of the camera's content at the time of the
  approval, split into **chunks** (one kind × one camera day), each with its
  file list, sizes and SHA-256 checksums.
- **Switch-over**: the moment the target starts serving the camera and the
  source stops.

## 4. The flow

```
user (source proxy page)          source            cams-admin            target
 Move camera… → pick target ─────► move.request ───► checks account ─────► move.offer
                                                                           evaluates (§6)
 panel (§7) ◄──────────────────── offer answer ◄──── accept / reject ◄────┘
 Approve ────────────────────────► move.approve ──► job created, tokens ──► move.start
                                   manifest ◄──────────────────────────── pulls manifest
                                   password (sealed, §9.3) ◄─────────────── pulls
                                                                           takes over camera (§9)
                                   stops camera ◄── switch-over done ◄──── reports
                                   files ◄───────────────────────────────── pulls, newest first (§8)
                                                     progress ◄─────────── per chunk
                                                     transfer done ◄────── verified
                                   deletes camera's content, removes camera (§11)
```

Phases of the job, in order; each is a step in the task list (§10):

1. `requested`: the user picked the camera and the target.
2. `offered`: the target is evaluating.
3. `rejected` (end) or `awaiting-approval`: the panel is shown.
4. `approved`: the user approved; manifest frozen.
5. `switching`: the target takes over the camera.
6. `copying`: content moves.
7. `cleaning`: the source deletes the camera's content and config.
8. `done` (end). Or `cancelling` → `cancelled` (end) from 4–6.

Where the user starts it (**my call**): the source proxy's page (Cameras →
the camera → "Move to another proxy…"). Signed in with the local admin token
or with a cams-admin one-time link (**Klaus**: a one-time token is enough
authorization). The target list comes from cams-admin: proxies of the same
account, online, enrolled, with a version that supports moves.

## 5. Who keeps what

- **cams-admin** owns the job: phase, the approved plan, the manifest's chunk
  list with each chunk's state (`pending`, `copied`, `verified`, `skipped`),
  and the move tokens. It is the authority after a restart (**Klaus**:
  cams-admin tracks what was transferred and what remains). It never holds
  content or passwords.
- **Each proxy** keeps a local journal of its side of the job (in
  `data/admin/moves/<moveId>.json`, mode 600, written atomically like the
  other admin files) so it can resume without cams-admin being reachable, and
  reports to cams-admin when it is. File-level progress (which files of a
  chunk arrived) lives only on the target. **my call**: per-file rows in
  cams-admin would mean tens of thousands of rows per move for little gain.
- Messages between cams-admin and the proxies use the existing outbound
  channel and signed commands; new commands: `move.offer`, `move.start`,
  `move.cancel`, `move.finish` (target and source sides), plus events from the
  proxies (`move.progress`, `move.phase`). Content and passwords go directly
  proxy to proxy (§8, §9.3) (**Klaus**).

## 6. The target's evaluation (accept or reject)

The target rejects with a reason the user sees on the panel:

| reason | when |
|---|---|
| `moves_not_allowed` | the target's local admin hasn't allowed incoming moves (§13) |
| `other_account` | not in the source's account (also checked by cams-admin first) |
| `camera_unreachable` | the target can't open the camera's HTTPS port (TCP connect, no login) |
| `camera_limit` | the target is at its configured maximum number of cameras |
| `id_taken` | the target already has a camera with this id |
| `busy` | the target is already in another move (one move per proxy at a time, **my call**) |
| `incompatible` | the target's version doesn't support a feature the camera's settings use |
| `no_site_ca` | the source or the target has no site CA (`tls.site` unset, e.g. the Pi) |
| `ca_does_not_cover_camera` | the target's site CA's `cameraSubnet` doesn't include the camera's address; the message names both ("een can't vouch for 192.168.1.90"). Widening it is a one-time local setup on the target, outside the move |
| `external_cert` | the camera's certificate is managed elsewhere (a camera with `tls.cameraCerts` off for it, such as cam1) |

Space is **not** a reason to reject (**Klaus**). The target computes, from the
source's per-kind summary (bytes, files, oldest, newest per kind) and its own
storage settings and free space, whether all content under retention fits.
If not, it answers with the shortfall and the options of §7.

## 7. The confirmation panel

Shown on the source proxy's page once the target answered. Contents:

- Camera, source → target.
- **The camera's settings**, as they will be on the target (**Klaus**: the
  camera keeps the source's settings): retention, storage limits, FTP stream,
  stills, analytics/Google Vision on or off, event settings, name. Read-only
  on the panel (**my call**; change them on the target afterwards).
- **Transfer content? Yes / No.** No: only the camera moves; the source still
  deletes the camera's content when the move ends (§11).
- **Content table**: per kind, size, files, oldest–newest.
- **If it doesn't all fit**, the shortfall and a choice (**Klaus**):
  - leave out kinds (stills, clips, events, Archive, analyses);
  - change retention or size limits on the target (fields prefilled with
    values that would fit);
  - transfer as much as fits, newest first, and let the target's retention
    manage its space.
- **Estimated transfer time** and the **time budget** (**Klaus**), prefilled
  with the estimate, adjustable upward only (a lower budget than the
  estimate would mean "faster than measured", which can't be promised). The
  estimate comes from a short throughput probe between the two proxies (§8.3).
- What happens at the end: the source deletes all the camera's content,
  copied or not; audit records stay (§11).
- **Approve** / **Cancel**.

Approving is the only approval. It covers per-camera settings that a cams-admin
sign-in normally can't change (storage limits, Google Vision on/off) because
the user saw them on the panel (**Klaus**, confirmed 2026-10-21). An offer not
approved within 30 minutes expires (**my call**), and a manifest older than
that would be stale anyway.

## 8. Moving the content

### 8.1 Channel

The target pulls from the source (**my call**: the source already listens on
the LAN for cams; the target needs nothing new opened). New endpoints on the
source under `/api/moves/<moveId>/…`: the manifest, a file by chunk and path,
catalog rows by chunk. Plain HTTP on the LAN is acceptable for content
(**Klaus**); where the source has HTTPS (een: 8443) the target uses it, with
the source's site-CA pin from cams-admin.

Authentication: a per-move bearer token cams-admin generates at approval and
sends to both proxies in `move.start` (signed command; the proxies store only
its hash on the source side). Valid only for this move's endpoints, only from
the target's address as cams-admin knows it, and revoked at `done` or
`cancelled`. **my call**.

Network exposure: none new if the source's existing port is used. If a host's
firewall doesn't allow the target in (the mini PC's 8480 is LAN-open; een's
8443 is LAN-open), that is a kube-setup request before the first move, not
part of the move.

### 8.2 Order and what goes

- Newest chunk first (**my call**, follows **Klaus**'s "newest first" for
  space): what users are most likely to open fills in first.
- Per chunk: files, then their catalog rows. A row is imported only when its
  files are present and verified, so cams never sees a row pointing at a
  missing file.
- Catalog ids are per proxy: imported rows get the target's ids, and links
  between rows (event → clip → analysis) are remapped. Content addressed by
  camera and time (stills, the timeline, recordings) stays valid. A cams
  bookmark that holds a raw clip or Archive id from the source may not
  resolve afterwards (**my call**; cams uses times in its URLs for most
  views — the builder checks and lists the exceptions).
- The source's retention keeps running during the move (**Klaus**). A chunk
  or file that expired at the source before it was copied is marked
  `skipped (expired)`, not an error.
- Content captured by the source after approval and before the switch-over
  (minutes) is copied too: the manifest gets a final chunk at switch-over.

### 8.3 Rate and time budget

- Estimate: a probe of a few seconds (e.g. 64 MB or 5 s) from source to
  target, before the panel; estimate = manifest bytes / measured rate, plus
  per-file overhead.
- Rate during the move = remaining bytes / remaining budget, recomputed every
  minute, never above the probe rate.
- When the budget runs out with content left (**Klaus**): keep going at the
  same or a lower rate, never faster, and write an audit event
  (`move-budget-exceeded`) once.
- The rate also yields to live work: the target's capture of the camera and
  the source's service of its other cameras come first (**my call**; a simple
  form: halve the rate while either proxy reports CPU or disk pressure).

### 8.4 Verification and resume

- Every file is checked against the manifest's SHA-256 after download; a
  mismatch is retried (3 times), then the file is marked failed and the
  chunk `copied with failures`.
- A file is written to a temporary name and renamed when verified, so a
  restart never leaves half a file under a real name.
- After a restart either proxy reads its journal, the target asks cams-admin
  for the chunk states, and continues with the first chunk not `verified`.
  Within a chunk, verified files are skipped.
- `copying` ends when every chunk is `verified`, `skipped` or
  `copied with failures`; the counts go into the completion event.

## 9. Switching the camera over

### 9.1 Order (no gap)

1. The target adds the camera to its configuration with the source's settings
   (a `config.json` entry it writes itself, as the local admin would; the
   move is the authorization, §13). Cameras and passwords are read only when
   the process starts (`src/config/load.ts` RESTART/`loadSecrets`), so the
   target then restarts its process on its own (**Klaus**: automatic restarts
   are acceptable). Its other cameras miss a few seconds of stills and live
   view; a clip upload in that moment may fail (the SD card still has it).
2. The target gets the camera passwords from the source (§9.3).
3. The target issues a leaf from its own site CA for the camera's new TLS
   name (`<cam>.<target site>.internal`) and pushes it to the camera, as it
   does for a camera it was set up with.
4. The target starts stills and events (both can run in parallel with the
   source: the camera serves several stream and event clients).
5. The target points the camera's FTP upload at itself. From now on new
   clips go to the target.
6. The target reports `switched`; the source stops its workers for the
   camera (without a restart: it marks the camera `moving` in its journal and
   the camera's worker is stopped; the config entry goes at cleanup, which
   restarts the source once) (stills, events, FTP expectation, status polling) and keeps the
   camera's config and content, marked `moving` (needed for cancel, §10.3).
7. cams-admin moves the camera to the target in its registry (proxy, TLS
   name) and publishes the snapshot to cams.

Certificate guard: each proxy refuses a camera that serves a certificate it
didn't expect (`src/tls/camera-certs.ts`). The move keeps the guard: in
`move.start` cams-admin tells the source the fingerprint of the leaf the
target will push (the target reports it before pushing), so the source
accepts it for the remaining overlap; on cancel the target is told the
source's leaf likewise. **my call**: suspending the guard would be simpler
but weaker. A push restarts the camera's web server for a few seconds; both
proxies treat that as a short camera outage.

Overlap between 4 and 6 means the source may capture a few extra stills or
events; they are deleted with the rest of its content at the end.

### 9.2 cams

The camera keeps its cams id, so the credentials file entry
(`<account>/<camera id>`) stays valid: no kube-setup step.

The camera's proxy and TLS name change. cams today confirms trust per camera
(`server/admin/trust.ts`: account + cams id, all six values together), so a
move would be held for a Confirm (cams-admin M6).

**Trusted proxies (Klaus, option (a), 2026-10-21).** cams gains a per-account
list of confirmed proxies: proxy id, URL, CA pins, proxy TLS name. An account
admin confirms a proxy **once** (a banner like today's held changes: "New
proxy <name> at <url>, pin <short>: Confirm / Ignore"), typically right after
it is enrolled. At first start with this feature cams seeds the list from the
proxies its confirmed cameras already use, so existing proxies need no click.
A change of a trusted proxy's URL, pins or TLS name is held as today.

A camera change applies without a hold when: the snapshot marks it as part of
a move (`moveId`); the new proxy is on the trusted list with exactly the
offered values; the camera's `host` and protocol are unchanged; and the new
camera TLS name is under the new proxy's site (`<cam>.<site>.internal`).
Anything else is held as today. Cost if wrong: a compromised cams-admin could
move a camera between two trusted proxies of the account without a Confirm;
it couldn't send the password to a host no admin confirmed.

### 9.3 Passwords

The camera's users' passwords (the proxy user and the cams user; the admin
password where the source holds one) go from source to target directly
(**Klaus**), never through cams-admin, never in clear text:

- At `move.start`, the target generates an X25519 key pair for the move and
  reports the public key to cams-admin, which passes it to the source in a
  signed command. **my call**.
- The source seals the passwords to that key (libsodium sealed box or
  equivalent) and the target pulls the sealed blob with the move token.
  cams-admin sees only the public key.
- The target stores them in a new file, `data/admin/camera-passwords.json`
  (mode 600 in the 700 folder, written atomically, tightened and checked like
  the other admin files), keyed by camera id. Today passwords come only from
  `CAMPROXY_CAMERA_PASSWORD_<ID>` / `_FILE` or the shared default
  (`src/config/secrets.ts`); the environment still wins over the file, so a
  hand-set password is never overridden. **my call**: writing `.env` would
  break the env-file writer's one-line limit, and per-camera `_FILE` paths
  would need a compose change on every host first.
- A source that uses the shared default password sends that value for the
  moved camera; the target stores it per camera.
- The source deletes its copies in `cleaning` (§11), not before: cancel needs
  them.

## 10. Task list, failures and cancel

### 10.1 The task list

The job's steps (phases of §4 and the chunk list of §8) are stored in
cams-admin and mirrored in each proxy's journal. Every step can be done again
safely: adding the camera when it's there already, pushing a cert that is
already on the camera, pointing FTP where it already points, importing a
chunk that is already verified. A resumed move repeats the current step from
its start.

### 10.2 Failures

| what | what happens |
|---|---|
| a proxy restarts | resumes from its journal (§8.4) |
| cams-admin unreachable | proxies continue the current phase from their journals; phase changes that need cams-admin (switch-over registry update, completion) wait for it |
| source unreachable during `copying` | the target retries with backoff; the move stays in `copying`; audit event on the first failure and every 6 h. The camera is already served by the target, so nothing is lost but the remaining old content. The user can cancel or **end the transfer** (§10.4) |
| target fails during `switching` before step 5 | the source never stopped; the move is cancelled automatically (§10.3) |
| target fails after step 5 | the target resumes from its journal when it comes back; the camera keeps uploading FTP to the target (lost while it's down, as for any proxy outage; the SD card keeps the recordings) |
| a file fails 3 times | marked failed (§8.4); the move continues |

### 10.3 Cancel (**Klaus**)

Possible in `approved`, `switching`, `copying`; from the source's page or
cams-admin.

- Before the switch-over: the job ends; nothing to undo but the target's
  config entry if written.
- After it: the camera moves back. The source re-enables its workers; the
  source pushes a leaf from its own site CA again and points FTP back at
  itself; cams-admin moves the camera back in the registry (same no-hold
  rule, §9.2); the target removes the camera from its config and deletes the
  passwords.
- Content already copied to the target: the user chooses at cancel time
  between deleting it and letting the target's retention age it out
  (**Klaus**).
- Content the source captured is all still there (it deleted nothing).

### 10.4 Ending the transfer early

If the source is gone for good, the user can end the transfer from cams-admin:
the move goes to `cleaning` with the remaining chunks marked `abandoned`, and
cleaning skips the unreachable source (its deletion is noted as not done in
the completion event). **my call**: without it a dead source would hold the
move open forever.

## 11. Completion

- The target reports `copying` finished.
- The source deletes all content of the camera, copied or not (**Klaus**):
  files, catalog rows, Archive items of that camera, the camera's
  recordings cache. Then it removes the camera from its config and deletes
  its password files and its leaf record for the camera.
- Audit records stay on both proxies (**Klaus**: history is not rewritten).
- The move token is revoked; the job is `done`.

## 12. Audit events

On every party, with `moveId`, `cam`, `source`, `target`:

| action | where | when |
|---|---|---|
| `move-request` | source, cams-admin | the user asked; who and from where |
| `move-offer` | target | the target's answer: accept (with the space result) or the reject reason |
| `move-approve` | source, cams-admin | the approved plan: kinds, space choice, settings, budget, estimate |
| `move-phase` | all | each phase change |
| `move-switch` | source, target | each switch-over step with its outcome |
| `move-progress` | target | every 10% of bytes and at least hourly: chunks, bytes, rate, time left |
| `move-budget-exceeded` | target, cams-admin | once, when the budget runs out with content left |
| `move-file-failed` | target | a file failed its checks 3 times (one record per chunk, listing up to 50) |
| `move-cancel` | all | who, the phase it was cancelled in, the choice for copied content |
| `move-cleanup` | source | what was deleted (counts and bytes per kind) |
| `move-done` | all | totals: copied, skipped (expired), failed, abandoned, duration |

No other notification (**Klaus**). Never a password, a token or a sealed
blob in a record.

## 13. Security

- **Incoming moves are off by default** on every proxy: a new allow-list
  entry `move.receive`, set by the local admin on the Cams-Admin page (like
  `ui.config`). Without it the target rejects with `moves_not_allowed`.
  Starting a move from a proxy needs `move.send`, also local and off by
  default (**my call**: both follow the existing model where cams-admin can
  only do what each proxy's local admin allowed; this is a one-time setup per
  proxy, not a per-move interaction).
- The target adds a camera, writes passwords and changes the camera's FTP
  target and certificate: things cams-admin may never do on its own (M5).
  The move is allowed to because the local admin of the target allowed
  `move.receive`, the user approved on the source, and the passwords come
  from the source, not from cams-admin.
- Move tokens: per move, bound to the target's address, revoked at the end.
- Content in clear on the LAN (**Klaus**); passwords sealed (§9.3).

## 14. What changes where

- **cam-proxy**: move endpoints (source side), the move worker (target side),
  journal, manifest/chunks, rate control, catalog import with id remapping,
  camera add/remove via the move, sealed password exchange, the panel and the
  "Move to another proxy" entry, cancel, the allow-list entries, audit
  actions.
- **cams-admin**: the job model and its UI (list of moves, phase, progress,
  cancel, end transfer), the `move.*` commands and events in contract v1,
  the target list, registry update at switch-over, snapshot marking.
- **cams**: the trusted-proxy list with its one-time Confirm and seeding, and
  applying a move-marked camera change without a hold under §9.2's rules;
  placeholders for missing content already exist.
- **cam-sim**: nothing new expected; the e2e test moves a cam-sim camera
  between two local proxies.

## 15. Testing

- Unit: chunking and manifest, rate computation with budget overrun, resume
  from every phase, id remapping, sealed-box exchange, every reject reason,
  cancel from every phase.
- Integration (two proxies + cams-admin + cam-sim, the livestack): a full
  move; a move with a restart of each party in `switching` and `copying`;
  a cancel after switch-over; a space shortfall with each option; the budget
  overrun.
- Real camera: one move of cam3 or cam4 between two of the home proxies,
  with Klaus's OK, after the livestack passes.

## 16. Later

- **Across accounts**: the target is in another account; needs consent on
  both sides and moving the camera's cams id and credentials between
  accounts.
- **Physical move**: a "green light" step to unplug the camera, the target
  taking over when it appears on its network, and the target backfilling
  the offline gap from the SD card over Baichuan.

## 17. Calls I made (for review)

1. The move starts on the source proxy's page.
2. cams-admin tracks chunks; per-file progress only on the target.
3. One move per proxy at a time.
4. Settings are read-only on the panel.
5. Offer expires after 30 minutes.
6. Target pulls from the source over the source's existing port.
7. Per-move bearer token bound to the target's address.
8. Newest chunk first; rows imported only after their files verify.
9. Catalog ids are remapped; id-based bookmarks may break.
10. The time budget can only be raised above the estimate.
11. Transfer rate yields to live work under pressure.
12. (superseded by Klaus's option (a), §9.2)
13. Passwords sealed to a per-move key from the target.
14. "End transfer" for a source that is gone for good.
15. `move.receive` and `move.send` allow-list entries, off by default.
16. Received passwords go to `data/admin/camera-passwords.json`; the environment wins.
17. The certificate guard stays on; expected fingerprints are handed over in the move commands.
