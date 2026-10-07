# cam-proxy: migration phase 3 (remote configuration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cam-proxy runs cams-admin's P3 commands — `config.get`, `config.set` / `config.unset` with a dry-run diff and a revision conflict check, `config.rollback`, `camera.action`, `camera.name.set`, `proxy.restart` — each behind its own local allow entry (off by default), only on a compiled list of remote-settable settings, with camera writes only through the proxy's existing whole-object Set + re-read functions, every change audited and visible (and undoable) on the proxy itself.

**Architecture:** The P2 command machinery (`src/fleet/command-check.ts`, `commands.ts`, the journal, the policy) stays as it is and gains handlers. Settings commands reuse `applyOverrides` through a new **pure** planning step (`planOverrides` / `planUnset`, nothing written) so a dry run and a real write compute the same change list; a compiled classification (`src/fleet/remote-settable.ts`) decides what cams-admin may touch, and an overrides backup per command (`data/admin/overrides.bak-<cmdId>.json`) makes path-level rollback possible. Camera commands call the control API's action code through an extracted, Express-free `performAction` core (no HTTP self-call, no internal credential). The wire format is cams-admin `contract/v1` ("The P3 contract" below), vendored into `test/contract/cams-admin-v1/`.

**Tech Stack:** TypeScript, Express 5, vitest, Svelte 5, Playwright (existing). Node ≥ 26. No new runtime dependency.

**Spec:** cams-admin `docs/superpowers/specs/2026-10-06-cams-admin-migration-design.md` (cited **M §n**): §3 (M4, M5), §7.5–§7.9, §8 (all), §12.2, §13.1, §14.1–§14.3, §15 (P3). Read it from cams-admin `main`. Builds on this repo's `docs/superpowers/plans/2026-10-06-migration-p2-cam-proxy.md` (rulings R2-1 … R2-9 stay in force). The companion plan is cams-admin `docs/superpowers/plans/2026-10-07-migration-p3-cams-admin.md`; the section **"The P3 contract" is identical in both plans**. The P4 plans (cams, cams-admin) are written in parallel; nothing here depends on them.

## Klaus's decisions (recorded as decisions, not defaults)

Klaus pre-approved spec, plan, implementation and deployment, and answered M §16:

1. **Held trust changes (Q1):** cams holds changed connection data until an account admin confirms. *(P4; nothing here. P3 never changes connection data anyway: addresses, TLS names and pins are on the deny list.)*
2. **Stale cache (Q2):** cams uses its cached configuration however old. *(P4.)*
3. **Disruptive remote actions (Q3):** camera reboot, power-cycle, proxy restart and FTP/NTP/cert setup **may be allowed for remote use per proxy, off by default.** This plan implements them as separate allow entries, grouped and warned on the Status card, never allowed by any default, `config.json` example or test fixture that ships.

## Rulings made in this plan (where the spec is silent or unclear)

- **R3-1 Exact-leaf classification; the contract is the upper bound.** `src/fleet/remote-settable.ts` lists every remote-settable leaf exactly (`cameras.*.<leaf>` for camera leaves) and every denied leaf or prefix explicitly. A test walks `SETTINGS` and fails for any leaf in neither list (a new setting is denied until someone classifies it), and another fails when the compiled remote list is not a subset of the vendored `remote-settable.json`. Deny wins over remote. Making a new setting remote-settable therefore needs a cams-admin contract PR first: a second review on the security boundary.
- **R3-2 Narrow-only paths.** Google Vision's switch and limits may only move toward **less spending** (`0` = no cap for `dailyCap` and `perCameraDailyCap`), and `retention.auditDays` only **up**: a compromised cams-admin must not be able to run up a paid bill or shorten the audit log that records its own commands. A widening fails `widening_local_only`. `config.rollback` is exempt: it only restores the value the path held before cams-admin's own change.
- **R3-3 Path refusals are `done` results, not nacks.** They depend on the proxy's current configuration (camera list, env layer, revision), are journaled like any outcome, and write nothing. The nack list stays the transport-level list of P2.
- **R3-4 Whole-revision conflict; cams-admin computes the local diff.** `config.set`/`config.unset` compare `baseRevision` with `configRevision` (also on a dry run) and answer `conflict` with the current revision and the current values of the command's paths. The proxy can't know cams-admin's base content (M §8.4's "paths that differ"), so cams-admin re-reads (`config.get`) and diffs its stored view.
- **R3-5 Rollback is path-level from the backup.** Each cams-admin write (not a dry run) saves `{overridesBefore, paths: [{path, before, after}]}` in `data/admin/overrides.bak-<cmdId>.json` (mode 600, the last 20). `config.rollback {cmdId}` restores each path's override state (`before`) when its current override state still equals `after`; otherwise `conflict` naming the paths that changed. A rolled-back backup is marked; a second rollback fails `already_rolled_back`. The rollback writes its own backup (so it can be rolled back). The card's **Undo** is the same operation with the local admin's rights.
- **R3-6 `config.get` is compact.** One object per path (`v`, `s`, `r`, `p`, `n`, `by`), plus the remote-settable leaves with the proxy's own bounds (`settable`), at most 24 cameras (the rest in `omittedCameras`). A 24-camera proxy stays under the contract's 64 KiB (a test).
- **R3-7 `performAction` core.** The body of `POST /control/(cameras/:cam/)actions/:name` moves into `src/api/actions.ts` as `performAction(d, name, cam, input, who): Promise<ActionOutcome>`; the Express handler maps the outcome to the response exactly as today (existing tests unchanged). Commands call the same core with `who = {user: 'cams-admin', requestedBy: 'cams-admin', cmdId}`. The host-wide `restart` (no camera) and every never-remote action stay unreachable from a command (args validation + step 11 + a guard in the handler).
- **R3-8 Results are projected; the Push-now key leak is fixed.** Every `camera.action` answer is scrubbed (keys matching `/pem|key|password|passwd|secret|token|cookie/i` dropped at any depth) and clamped to 16 KiB. `camera-cert-push` is projected explicitly to `{outcome, served, leaf: {fingerprint, notAfter, names, ips}, detail, tookMs}`. **Finding:** today `POST …/actions/camera-cert-push` answers the whole `PushResult`, including `leaf.keyPem` (the camera certificate's **private key**) and `servedPem`, to the admin's browser. The same projection now applies to the HTTP answer (CHANGELOG: security fix).
- **R3-9 Disruptive budgets survive restarts.** The journal budget (contract step 11): `proxy.restart` ≤ 2 per hour, disruptive `camera.action`s ≤ 6 per hour per proxy, counted from `data/admin/commands.json`. An in-memory limit alone would let a compromised cams-admin restart the proxy in a loop (each restart resets memory). The camera's own reboot/power-cycle cooldown (2 min) applies unchanged on top.
- **R3-10 `proxy.restart` answers first.** The handler journals `ok`, the runner sends `done`, then an `after` hook calls `restartProcess()` (the existing stop-and-exit path). A re-sent `cmdId` after the restart is answered from the journal (`duplicate`), never restarts again.
- **R3-11 Rate windows.** `config.set`, `config.unset`, `config.rollback` share one 6/min window (a dry run + apply = 2); `camera.action` 12/min; `camera.name.set` 6/min (as the managed rename limit); `config.get` only the totals.
- **R3-12 A local edit is reported within seconds.** `configRevision` joins the client's `changeKey`, so a Settings page edit sends an early heartbeat (≥ 10 s floor) and cams-admin re-reads (M §8.1).
- **R3-13 Requesters.** `RebootRequester` (and the other requester types the actions take) gain `user?: string` (default `'admin'`) and `requestedBy: 'session' | 'token' | 'cams-admin'` with `ip` optional; records made for a command say `user: 'cams-admin'`, `requestedBy: 'cams-admin'` and carry `cmdId` and cams-admin's `actor` in `details`.
- **R3-14 Settings changed by cams-admin are marked.** `GET /control/config` gains `by: {cmdId, actor, at}` on a path whose override value is the one a cams-admin command set (from the backups); the Settings page shows "set by cams-admin (on behalf of …)" with the Undo link.

## Global Constraints

- **Every P3 command is OFF unless allowed locally** (R2-1, R2-3): default allow-list empty; only the local admin token (or its session) widens it; the Pi and the cluster proxy run nothing new after the release until someone allows an entry on that proxy. No shipped `config.json`, example or fixture allows a P3 entry.
- **The compiled deny list can't be widened** by any setting, file, command or managed token (M5). `camsAdmin.*`, `server.*`, `go2rtc.*`, every address/port/file path/TLS/trust setting, `ntp.server`, `poeSwitch.*`, camera users and connection fields are never remote-settable; no camera is added or removed remotely.
- **No new camera write path** (M §8.3): only `cameraName.write`, `setupCameraFtp`, `cameraFtpOff`, `ensureNtp`, `tls.pushNow`, the reboot and the power-cycle — the functions the control API already calls. No generic Set passthrough, ever.
- **Local edits win** (M4): a cams-admin write needs `baseRevision` = the current `configRevision`; nothing is merged over a local change.
- **Visible on the proxy:** every executed command writes `admin-command` (P2); a settings write also writes `config-change` with `user: 'cams-admin'`, `details.cmdId`, `details.actor`; a camera action writes its existing record with `user: 'cams-admin'`. The cams-admin card lists the last 20 commands and the cams-admin changes with Undo.
- **Never logged, audited, served or sent:** tokens, hashes beyond 8 hex, private keys or PEMs (R3-8), passwords, `data/admin/*` contents. `overrides.bak-*.json` joins the `data/admin/` never-print list (CLAUDE.md).
- **Files in `data/admin/`:** mode 600, folder 700, atomic writes (`writePrivateJson`), refused when unsafe (P2 rule). Backups: at most 20 files, oldest deleted first.
- **Synchronous write sections:** a settings command's revision check, planning and write run without an `await` in between, so a local `PUT /control/config` can't interleave (one event loop).
- **Limits** as in the contract (step 9, step 11, R3-9, R3-11). Never keyed on an address.
- **Contract:** `test/contract/cams-admin-v1/` equals cams-admin `main`'s `contract/v1` (`scripts/contract-drift.sh`).
- **The Pi stays as it is:** without `camsAdmin.url` no command arrives and no `data/admin/` file is written (`test/pi-compat.test.ts`).
- **Real camera, Pi, cluster:** never touched by this plan's tests or by the implementing session; the camera round trip runs against cam-sim (in process, and in cams-admin's local stack).

## Review Focus

1. **A settings path that looks harmless but redirects trust** — e.g. `cameras.cam1.host` via `config.set`, a camera id that doesn't exist (`cameras.evil.host` adding a camera), `cameras.cam1` as a whole, a legacy path `camera.host` that `normalizeOverrides` translates, or `camsAdmin.url` — must fail **before** `planOverrides` sees it (classification runs on the **translated** paths), and the overrides file must stay byte-identical. Task 6 (a test per case, with a spy on `writeOverrides`).
2. **A local edit between cams-admin's dry run and its apply** must make the apply answer `conflict` with the current values, write nothing, and leave the local value in place; a dry run after a local edit must also answer `conflict`. Task 6.
3. **Rollback after a later local edit to one of the same paths** must answer `conflict` naming only that path and restore nothing; a rollback after a local edit to an *unrelated* path must succeed and keep that edit. Task 6.
4. **A compromised cams-admin looping disruptive commands** (proxy restarts, camera reboots across proxy restarts, Google Vision limits raised, audit days lowered) is bounded by the journal budget and the narrow paths, and each attempt is visible in the audit log. Task 11.
5. **A camera action's answer carrying key material** (the cert push's `leaf.keyPem`, `servedPem`, an FTP object's `password`) never reaches cams-admin or the admin browser. Tasks 7, 8.

---

## The P3 contract (identical in both plans; binding)

Additive to "The P2 contract" (cams-admin `docs/superpowers/plans/2026-10-06-migration-p2-cams-admin.md`, as amended by `revocationOnly`, cams-admin `contract/README.md`). The envelope stays **v1**, the subprotocol `cams-admin.v1`, signatures and JCS unchanged. Everything new is in cams-admin `contract/v1/` (made by `contract/build.ts` / `contract/make.ts` / `scripts/contract/make-vectors.ts`); cam-proxy vendors it into `test/contract/cams-admin-v1/`.

**Commands P3 implements:** `config.get`, `config.set`, `config.unset`, `config.rollback`, `camera.action`, `camera.name.set`, `proxy.restart` (all already in the strict `command` enum since P2). No new wire command, no new message type, no new heartbeat field.

**Allow entries** (unchanged list since P2): `config.get`, `config.set`, `config.unset`, `config.rollback`, `camera.name.set`, `proxy.restart`, `camera.action:<a>` per remote action. **Every entry is off by default.** The **disruptive** entries are `proxy.restart` and `camera.action:<a>` for `a` in `restart`, `camera-reboot`, `camera-powercycle`, `camera-ftp-setup`, `camera-ftp-off`, `camera-ntp-set`, `camera-cert-push` (Klaus's decision 3: allowed per proxy, off by default; the UIs group and warn).

**Action lists** (compiled on both sides, exported from `contract/build.ts`):
- `REMOTE_ACTIONS` (unchanged): `camera-test`, `onvif-resubscribe`, `camera-ftp-test`, `poe-switch-read`, `inventory`, `inventory-cancel`, `retention-run`, `restart`, `camera-reboot`, `camera-powercycle`, `camera-ftp-setup`, `camera-ftp-off`, `camera-ntp-set`, `camera-cert-push`.
- `NEVER_REMOTE_ACTIONS` (new export): `find-camera`, `camera-address`, `camera-trust-clear`, `tls-ca-rotate`, `tls-ca-drop-previous`, `archive-clear`, `inventory-repair`, `camera-poe-on`, `restart-proxy`.
- `DISRUPTIVE_ACTIONS` (new export): `restart`, `camera-reboot`, `camera-powercycle`, `camera-ftp-setup`, `camera-ftp-off`, `camera-ntp-set`, `camera-cert-push`.

**Check order** (normative; the P2 steps 1–12 with these changes, each step's refusal wins over later ones):

- **Step 8 (allowed):** for `camera.action`, the command passes step 8 when the allow-list holds **at least one** `camera.action:*` entry; every other command needs its own name in the allow-list. (`implemented` as before.)
- **Step 9 (rate, in memory):** the totals (30/min, 300/day) plus per-command windows: `config.set`, `config.unset` and `config.rollback` share **one** window of 6 per minute (dry runs count); `camera.action` 12 per minute; `camera.name.set` 6 per minute; `tokens.apply` 6 per hour. `config.get` counts only toward the totals.
- **Step 10 (args):** the args validators below (`unsupported_version` for `args.v` ≠ 1, `invalid_args` otherwise).
- **Step 11 (entries and budgets the args need):** `camera.action`: an `args.action` in `NEVER_REMOTE_ACTIONS` → `not_allowed` (always, whatever the allow-list says); otherwise `camera.action:<args.action>` must be in the allow-list → else `not_allowed`; a disruptive action, or `proxy.restart`, must fit the **journal budget** → else `rate_limited` with `retryAfterS`. The journal budget counts the command journal's entries (persisted, so a restart never resets it): `proxy.restart` at most 2 per hour; disruptive `camera.action`s at most 6 per hour per proxy. Journal entries count whatever their status.
- Steps 1–7 and 12 unchanged.

**Args v1** (strict; closed objects; checked in code on the proxy, by `commands/<name>.args.schema.json` in tests):

| command | args |
|---|---|
| `config.get` | `{ "v": 1 }` |
| `config.set` | `{ "v": 1, "dryRun": bool, "baseRevision": "sha256:<64 lower hex>", "set": { "<path>": <value>, … } }` — 1–64 entries; `<value>` is a boolean, a safe integer, or a string of at most 512 characters (never null, an array or an object) |
| `config.unset` | `{ "v": 1, "dryRun": bool, "baseRevision": "sha256:<64 lower hex>", "paths": ["<path>", …] }` — 1–64 unique paths |
| `config.rollback` | `{ "v": 1, "dryRun": bool, "cmdId": "cmd_<ULID20>" }` — the `config.set`/`config.unset`/`config.rollback` command to undo |
| `camera.action` | `{ "v": 1, "camera": "<camera id>" \| null, "action": "<name>", "input"?: object }` — `action` is in `REMOTE_ACTIONS` ∪ `NEVER_REMOTE_ACTIONS` (else `invalid_args`); `camera` is null **only** for `retention-run` (required otherwise); `input` only for `inventory`: `{ "kind": string 1–32, "camera"?: bool }` |
| `camera.name.set` | `{ "v": 1, "camera": "<camera id>", "name": string 1–64 without control characters }` |
| `proxy.restart` | `{ "v": 1 }` |

`<path>`: `^[a-z][A-Za-z0-9]{0,31}(\.[a-z0-9][A-Za-z0-9-]{0,31}){0,5}$` (dotted, as `GET /control/config` names settings; no `_`, so never `__proto__`). `<camera id>`: `^[a-z0-9][a-z0-9-]{0,31}$`. `retention-run` always runs as a **dry run** on the proxy, whatever is asked.

**`done` outcomes** (the handler's; journaled; nothing is written on anything but `ok` with `dryRun: false`):

| command | `status: "ok"` | `status: "conflict"` | `status: "failed"`, `code` |
|---|---|---|---|
| `config.get` | the view | — | `store_error` |
| `config.set`, `config.unset` | the change list (also for a dry run) | `baseRevision` ≠ the proxy's current `configRevision` | `not_remote_settable`, `held_by_env`, `unknown_camera`, `widening_local_only`, `invalid_value`, `store_error` |
| `config.rollback` | the change list | a path the command changed has changed since | `no_backup`, `already_rolled_back`, `not_remote_settable`, `invalid_value`, `store_error` |
| `camera.action` | the action answered 2xx | — | the action's error code (`camera_error`, `camera_offline`, `camera_restarting`, `not_configured`, `too_soon`, `switch_busy`, `no_power`, `switch_auth`, `switch_unreachable`, `switch_error`, `inventory_busy`, `stopping`, `camera_mismatch`, `invalid`, `unknown_camera`, `internal`) |
| `camera.name.set` | the name as read back | — | `invalid_name`, `camera_offline`, `camera_error`, `unknown_camera` |
| `proxy.restart` | `{ "restartAt": ms }`; the proxy restarts **after** the result is sent | — | — |

**Results v1** (`commands/<name>.result.schema.json`; `jcs(result)` ≤ 65536 bytes as in P2):

- `config.get`: `{ "revision": "sha256:…", "schema": int, "cameras": [id…], "omittedCameras": [id…], "paths": { "<path>": { "v"?: value, "s": "default"|"file"|"override"|"env", "r"?: "restart"|"process", "p"?: true, "n"?: value, "by"?: { "cmdId", "actor", "at" } } }, "settable": { "<pattern>": { "type": "integer"|"boolean"|"string", "min"?, "max"?, "oneOf"?, "enum"?, "pattern"?, "optional"?, "dir"?: "less"|"more" } } }`. `v` absent = unset; `r` = needs a restart (`process` = a new process); `p` = changed, waiting for that restart, `n` the next value; `by` = the override's current value was set by that cams-admin command. `settable` lists the remote-settable leaves (`cameras.*.<leaf>` once for every camera) with the proxy's own bounds; `dir` marks a narrow-only path. At most 24 cameras' paths; the rest are named in `omittedCameras`.
- `config.set` / `config.unset` / `config.rollback` `ok`: `{ "dryRun": bool, "baseRevision": "sha256:…", "revision": "sha256:…", "changes": [ { "path", "from"?: value, "to"?: value, "sourceFrom", "sourceTo", "restart"?: "restart"|"process" } ], "unchanged": [path…] }` (+ `"of": "cmd_…"` for a rollback). `revision` is the revision **after** (equal to `baseRevision` for a dry run). `from`/`to` absent = unset. A path set to the value Reset would restore drops the override (`sourceTo` is then `file` or `default`).
- `failed` (config): `{ "paths": [ { "path", "code", "detail"? } ] }` (`detail` ≤ 200).
- `conflict` (config): `{ "revision": "sha256:…", "current": { "<path>": { "v"?: value, "s": … } } }` — the proxy's current revision and the current values of the paths the command names (for a rollback: the paths that changed since).
- `camera.action`: `{ "action", "camera": id|null, "httpStatus": int, "answer": object|null, "verified"?: bool, "mismatch"?: [key…] }`. `answer` is the action's JSON answer, **scrubbed**: every key matching `/pem|key|password|passwd|secret|token|cookie/i` removed at any depth, then clamped to 16 KiB (`answer: null`, `"clamped": true` when larger). `verified`/`mismatch` for the camera writes (`camera-ftp-setup`, `camera-ftp-off`, `camera-ntp-set`, `camera-cert-push`): the proxy's whole-object Set re-read and compared.
- `camera.name.set`: `{ "camera", "requested", "name", "verified": bool }`.
- `proxy.restart`: `{ "restartAt": ms }`.

**Remote-settable paths:** `contract/v1/remote-settable.json`:

```json
{ "v": 1,
  "remote": [ "<exact leaf path, cameras.*.<leaf> for a camera leaf>", … ],
  "narrow": { "<path>": "less" | "more" },
  "denied": [ "<prefix>", … ] }
```

`remote` is the **upper bound**: cam-proxy's compiled list must be a subset of it (a test on each side); a path not in `remote` is never remote-settable, whatever a proxy says. `narrow`: cams-admin may only move the value in that direction (`less` spending, `more` evidence): `analytics.googleVision.enabled` (`less`: only to false), `analytics.googleVision.monthlyLimit`, `.dailyCap`, `.checksPerDay`, `.perCameraDailyCap` (`less`; for `dailyCap` and `perCameraDailyCap`, 0 means **no cap**, so 0 counts as infinitely high), `retention.auditDays` (`more`). A widening `config.set`/`config.unset` fails `widening_local_only`; a `config.rollback` is exempt (it restores a value the path had before cams-admin's own change). `denied` documents M §8.2's right column (and `retention.auditDays` is not in it: it is narrow). The `remote` list:

```
stills.enabled stills.stream stills.intervalS stills.size stills.quality stills.maxGB
previews.tileSize previews.grid previews.quality previews.maxGB
events.onvif.subscribeMin events.onvif.pullTimeoutS events.poll.enabled events.poll.intervalS events.poll.afterOnvifDownS events.maxOpenMin
retention.stillsDays retention.previewsDays retention.clipsDays retention.eventsDays retention.auditDays retention.streamLogDays retention.intervalMin
storage.maxPercent storage.maxBytes storage.minFreeBytes storage.keepHours.stills storage.keepHours.clips storage.keepHours.previews
composition.concurrent sse.maxClients sse.queuePerClient sse.pingS recordings.cacheMB
health.diskPercent health.tempC host.stats
ftp.enabled ftp.stream ftp.stalledHours ftp.maxGB
archive.enabled archive.warnPercent
analytics.kinds.person analytics.kinds.vehicle analytics.kinds.pet
analytics.googleVision.enabled analytics.googleVision.monthlyLimit analytics.googleVision.dailyCap analytics.googleVision.checksPerDay analytics.googleVision.perCameraDailyCap
cameras.*.name cameras.*.statusPollS cameras.*.stills.enabled cameras.*.stills.stream cameras.*.stills.intervalS
cameras.*.ftp.enabled cameras.*.ftp.stream cameras.*.storage.sharePercent
cameras.*.analytics.kinds.person cameras.*.analytics.kinds.vehicle cameras.*.analytics.kinds.pet cameras.*.events.poll.enabled
```

`denied`: `server`, `go2rtc`, `ftp.port`, `ftp.passive`, `ftp.tls`, `ftp.publicHost`, `ftp.certFile`, `ftp.keyFile`, `tls`, `composition.font`, `ntp.server`, `poeSwitch`, `camsAdmin`, `cameras.*.id`, `cameras.*.host`, `cameras.*.protocol`, `cameras.*.tlsName`, `cameras.*.user`, `cameras.*.onvifPort`, `cameras.*.rtspPort`, `cameras.*.baichuanPort`, `cameras.*.poeSwitch`, `cameras.*.ftp.user`, `cameras.*.webUiUrl`.

**Path checks on the proxy** (`config.set`/`config.unset`, in this order, every path; any failure fails the whole command, nothing written): (1) a camera path `cameras.<id>.…` whose `<id>` is not a configured camera → `unknown_camera` (adding or removing a camera is never remote); (2) not in the proxy's compiled remote list (deny wins over everything) → `not_remote_settable`; (3) `sources[path] === 'env'` → `held_by_env` (also on a dry run); (4) `baseRevision` ≠ current → `conflict` (also on a dry run); (5) a narrow path moved the wrong way → `widening_local_only`; (6) the result fails the proxy's own validation (`applyOverrides` rules, cross-checks) → `invalid_value` with the proxy's message as `detail`.

**`configRevision`** (P2, unchanged): `sha256:` + hex SHA-256 of `jcs(overrides)`. P3 adds behaviour only: a change of it makes an early heartbeat (the 10 s floor applies), so cams-admin learns about a local edit within seconds.

**Fixtures** (added to `contract/v1/fixtures/`; `$context` as in P2, plus `journal` = a list of `{cmdId, command, at, action?}` for the journal budget; unless the table names an allow-list, a fixture's `$context.allow` holds exactly the entries its command needs, so it reaches the step it tests):

| fixture | strict | runtime (proxy) |
|---|---|---|
| `valid-command-config-get`, `valid-command-config-set` (dry run, `sse.pingS`), `valid-command-config-unset`, `valid-command-config-rollback`, `valid-command-camera-action` (`camera-test`, allow `camera.action:camera-test`), `valid-command-camera-name-set`, `valid-command-proxy-restart` | valid | run |
| `valid-result-config-get`, `valid-result-config-set-ok`, `valid-result-config-set-conflict`, `valid-result-config-set-failed`, `valid-result-camera-action-verified` | valid | accepted (server) |
| `refused-config-set-not-allowed` (allow `["config.get"]`) | valid | `not_allowed` |
| `refused-camera-action-entry-missing` (`camera-reboot`, allow `["camera.action:camera-test"]`) | valid | `not_allowed` |
| `refused-camera-action-never-remote` (`find-camera`, every allow entry) | valid* | `not_allowed` |
| `refused-camera-action-no-camera` (`camera-reboot`, `camera: null`) | valid* | `invalid_args` |
| `refused-config-set-bad-path` (`"Sse.pingS"`) | valid* | `invalid_args` |
| `refused-config-set-object-value` (`{"sse": {"pingS": 5}}` as one entry) | valid* | `invalid_args` |
| `refused-config-set-65-paths` | valid* | `invalid_args` |
| `refused-config-set-args-v2` | valid | `unsupported_version` |
| `refused-proxy-restart-budget` (allow `["proxy.restart"]`, `$context.journal` two `proxy.restart` within the hour) | valid | `rate_limited` |
| `refused-camera-action-budget` (allow `["camera.action:camera-reboot"]`, journal six disruptive actions within the hour) | valid | `rate_limited` |
| `refused-proxy-restart-paused` | valid | `paused` |

\* the `command` schema checks only that `args` is an object; strict refuses the fixture's args against `commands/<name>.args.schema.json` (a test says so for each).

`vectors.json` gains two `envelopes` entries: a signed `config.set` command and its signed `done` result (`status: ok`, a one-change list), so both sides reproduce the bytes.

**Cross-check rule while the repos are out of step:** a command fixture whose `body.command` is not in the checking proxy's `IMPLEMENTED` set is reported `pending` (not a failure) by cams-admin `scripts/contract/cam-proxy-commands.ts` and skipped by cam-proxy's vendored-fixture test; once cam-proxy implements P3, neither may report `pending` (cam-proxy's last task asserts it).

---

## File map

| file | responsibility |
|---|---|
| `test/contract/cams-admin-v1/**` | the vendored P3 contract (Task 1) |
| `test/helpers/contract.ts` | `$context.journal`; `pending()` for fixtures this version doesn't implement yet |
| `src/fleet/remote-settable.ts` (new) | `REMOTE`, `DENIED`, `NARROW`, `classify()`, `narrowingOk()`, `settableView()` (R3-1, R3-2) |
| `src/fleet/policy.ts` | `IMPLEMENTED` grows; `NEVER_REMOTE_ACTIONS` gains `restart-proxy`; `DISRUPTIVE_ACTIONS`; entry texts without "(not in this version)"; `isDeniedPath`/`DENIED_PATH_PREFIXES` move to `remote-settable.ts` |
| `src/config/changes.ts` (new) | `configChanges(beforeLoaded, afterLoaded)`: the change list `recordChanges` builds today, shared |
| `src/config/load.ts` | `planOverrides`, `planUnset` (pure); `applyOverrides`/`removeOverride` call them; `writeOverridesFile` exported |
| `src/fleet/command-args.ts` | strict validators for the seven P3 commands |
| `src/fleet/command-check.ts` | step 8 for `camera.action`, step 9 windows, step 11 entries and journal budgets |
| `src/fleet/journal.ts` | `countSince(pred, sinceMs)`; entries keep `action` for `camera.action` |
| `src/fleet/backups.ts` (new) | `OverridesBackups`: save, get, list, markRolledBack, prune to 20 |
| `src/fleet/config-commands.ts` (new) | handlers `config.get`, `config.set`, `config.unset`, `config.rollback`; `undoLocal()` for the card |
| `src/api/actions.ts` (new) | `performAction()` (moved from `control-api.ts`), `ActionOutcome`, `projectPush()` |
| `src/api/control-api.ts` | the action route maps `performAction`; `configView` gains `by`; `recordChanges` uses `configChanges` |
| `src/fleet/camera-commands.ts` (new) | handlers `camera.action`, `camera.name.set`, `proxy.restart`; `scrub()`, verify functions |
| `src/fleet/commands.ts` | `Done.after`; journal entries keep `action`; the runner takes the handler map |
| `src/camera/reboot.ts`, `src/tls/camera-certs.ts` (types) | requester `user?`, `requestedBy: 'cams-admin'`, `ip?` (R3-13) |
| `src/proxy.ts` | wiring: handlers, backups, `changeKey` + `configRevision` |
| `src/api/cams-admin-api.ts` | `GET /control/admin/changes`, `POST /control/admin/changes/:cmdId/undo`; grouped entries in the commands view |
| `src/fleet/cli.ts` | `admin-commands changes`, `admin-commands undo <cmdId>` |
| `web/src/components/CamsAdminCommands.svelte`, `web/src/lib/cams-admin.ts`, `web/src/lib/settings.ts` (+ the Settings page component that renders a row) | grouped allow entries with warnings; cams-admin changes with Undo; "set by cams-admin" marker |
| `docs/cams-admin.md`, `CHANGELOG.md`, `CLAUDE.md`, `README.md` | docs |

---

### Task 1: Vendor the P3 contract (PR A)

**Files:**
- Modify: `test/contract/cams-admin-v1/**` (copied from cams-admin `main` after cams-admin PR A), `test/contract/cams-admin-v1/SOURCE`, `test/helpers/contract.ts`, `test/fleet-contract.test.ts`, `test/fleet-command-check.test.ts` (the fixture loop)

**Interfaces:**
- Produces: `FixtureContext.journal?: { cmdId: string; command: string; at: number; action?: string }[]`; `pending(f: Fixture, implemented: ReadonlySet<string>): boolean` (true when `f.message.body.command` is not implemented here).

- [ ] **Step 1: Copy** cams-admin `main`'s `contract/v1` over `test/contract/cams-admin-v1/` (keep `SOURCE`, set it to `cams-admin <commit> (contract/v1, main)`). `scripts/contract-drift.sh` → passes.
- [ ] **Step 2: Failing test** — run `npx vitest run test/fleet-contract.test.ts test/fleet-command-check.test.ts`: the new `valid-command-config-*` fixtures fail (`not_allowed`: not implemented yet).
- [ ] **Step 3: Implement** in `test/helpers/contract.ts`:

```ts
// A command fixture this version can't run yet (the cross-repo rule of the
// P3 contract): skipped and listed, never passed silently. Task 12 asserts
// that nothing is pending any more.
export const pending = (f: Fixture, implemented: ReadonlySet<string>): boolean => {
  const b = (f.message as { body?: { command?: unknown } })?.body;
  return f.schema === 'command' && typeof b?.command === 'string' && !implemented.has(b.command);
};
```

and in the fixture loop of `test/fleet-command-check.test.ts`: `if (pending(f, IMPLEMENTED)) { it.skip(\`${name} (pending: not implemented yet)\`, () => {}); continue; }`. Add `journal` to `FixtureContext` and pass it on in the context builder as `journal` entries (Task 4 reads them).
- [ ] **Step 4: Run** `npx vitest run test/fleet-contract.test.ts test/fleet-command-check.test.ts && scripts/contract-drift.sh` → PASS (P3 fixtures listed as skipped).
- [ ] **Step 5: Commit**

```bash
git add test/contract/cams-admin-v1 test/helpers/contract.ts test/fleet-contract.test.ts test/fleet-command-check.test.ts
git commit -m "test(contract): vendor the P3 contract; P3 command fixtures pending until implemented"
```

**→ PR A ends here** (vendor, no behaviour change). Merge the same day as cams-admin PR A.

---

### Task 2: The remote-settable classification

**Files:**
- Create: `src/fleet/remote-settable.ts`, `test/fleet-remote-settable.test.ts`
- Modify: `src/fleet/policy.ts` (remove `DENIED_PATH_PREFIXES`, `isDeniedPath`; re-export from `remote-settable.ts` only if something imports them: `grep -rn isDeniedPath src test`)

**Interfaces:**
- Produces:
  - `export const REMOTE: readonly string[]` — the contract's `remote` list, exactly (patterns with `cameras.*.`).
  - `export const DENIED: readonly string[]` — prefixes: the contract's `denied` list.
  - `export const NARROW: Readonly<Record<string, 'less' | 'more'>>`.
  - `export type PathClass = 'remote' | 'denied' | 'unknown_camera' | 'not_a_setting';`
  - `export function patternOf(path: string): string` (`cameras.cam-1.stills.enabled` → `cameras.*.stills.enabled`).
  - `export function classify(path: string, cameraIds: readonly string[]): PathClass`.
  - `export function narrowingOk(path: string, from: unknown, to: unknown): boolean` (true when the path is not narrow, or the move is in its direction).
  - `export function settableView(): Record<string, { type: string; min?: number; max?: number; oneOf?: number[]; enum?: string[]; pattern?: string; optional?: boolean; dir?: 'less' | 'more' }>` (for `config.get`, from `leafAt`).

- [ ] **Step 1: Failing tests** (`test/fleet-remote-settable.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { leafPaths, SETTINGS } from '../src/config/schema';
import { classify, DENIED, NARROW, narrowingOk, patternOf, REMOTE, settableView } from '../src/fleet/remote-settable';
import { CONTRACT } from './helpers/contract';

const contract = JSON.parse(readFileSync(join(CONTRACT, 'remote-settable.json'), 'utf8')) as { remote: string[]; narrow: Record<string, string>; denied: string[] };
const IDS = ['cam1', 'cam-2'];

describe('the classification (R3-1)', () => {
  it('every setting leaf is classified: remote or denied, never both, never neither', () => {
    for (const p of leafPaths(SETTINGS, '', IDS)) {
      const c = classify(p, IDS);
      expect(['remote', 'denied'], p).toContain(c);
      const listed = REMOTE.includes(patternOf(p));
      const denied = DENIED.some((d) => patternOf(p) === d || patternOf(p).startsWith(`${d}.`));
      expect(listed && denied, `${p} is in both lists`).toBe(false);
      expect(listed || denied, `${p} is unclassified: add it to REMOTE (contract first) or DENIED`).toBe(true);
    }
  });
  it('the compiled remote list is a subset of the contract (the upper bound); narrow paths agree', () => {
    for (const r of REMOTE) expect(contract.remote, r).toContain(r);
    expect(NARROW).toEqual(contract.narrow);
  });
  it('M5: the deny list holds every trust, address, port, file and camsAdmin path', () => {
    for (const p of ['camsAdmin.url', 'camsAdmin.enabled', 'camsAdmin.keyFile', 'server.port', 'server.publicUrl', 'go2rtc.binary', 'ftp.port', 'ftp.publicHost', 'ftp.certFile', 'tls.site', 'tls.cameraSubnet', 'composition.font', 'ntp.server', 'poeSwitch.host', 'poeSwitch.model',
      'cameras.cam1.host', 'cameras.cam1.protocol', 'cameras.cam1.tlsName', 'cameras.cam1.user', 'cameras.cam1.onvifPort', 'cameras.cam1.rtspPort', 'cameras.cam1.baichuanPort', 'cameras.cam1.poeSwitch.port', 'cameras.cam1.ftp.user', 'cameras.cam1.webUiUrl', 'cameras.cam1.id'])
      expect(classify(p, IDS), p).toBe('denied');
  });
  it('a camera path for a camera that does not exist is unknown_camera (never adds one); a whole camera is not a setting', () => {
    expect(classify('cameras.evil.name', IDS)).toBe('unknown_camera');
    expect(classify('cameras.evil.host', IDS)).toBe('unknown_camera');
    expect(classify('cameras.cam1', IDS)).toBe('not_a_setting');
    expect(classify('cameras', IDS)).toBe('not_a_setting');
    expect(classify('stills', IDS)).toBe('not_a_setting');
    expect(classify('nosuch.path', IDS)).toBe('not_a_setting');
    expect(classify('cameras.cam-2.stills.enabled', IDS)).toBe('remote');
  });
  it('no remote path has a secret-looking name (settings never hold secrets)', () => {
    for (const r of REMOTE) expect(r).not.toMatch(/token|password|secret|key|credential/i);
  });
});

describe('narrow paths (R3-2)', () => {
  it('Google Vision only toward less spending; 0 = no cap for the caps', () => {
    expect(narrowingOk('analytics.googleVision.enabled', true, false)).toBe(true);
    expect(narrowingOk('analytics.googleVision.enabled', false, true)).toBe(false);
    expect(narrowingOk('analytics.googleVision.monthlyLimit', 1000, 100)).toBe(true);
    expect(narrowingOk('analytics.googleVision.monthlyLimit', 100, 1000)).toBe(false);
    expect(narrowingOk('analytics.googleVision.dailyCap', 50, 10)).toBe(true);
    expect(narrowingOk('analytics.googleVision.dailyCap', 50, 0)).toBe(false); // 0 = no cap
    expect(narrowingOk('analytics.googleVision.dailyCap', 0, 50)).toBe(true);
    expect(narrowingOk('analytics.googleVision.perCameraDailyCap', 5, 0)).toBe(false);
    expect(narrowingOk('analytics.googleVision.checksPerDay', 5, 0)).toBe(true); // 0 = no checks
  });
  it('audit days only up; other paths are free', () => {
    expect(narrowingOk('retention.auditDays', 90, 30)).toBe(false);
    expect(narrowingOk('retention.auditDays', 30, 90)).toBe(true);
    expect(narrowingOk('sse.pingS', 30, 5)).toBe(true);
  });
  it('settableView: every remote leaf with its bounds, narrow ones marked', () => {
    const v = settableView();
    expect(Object.keys(v).sort()).toEqual([...REMOTE].sort());
    expect(v['sse.pingS']).toMatchObject({ type: 'integer', min: 1, max: 300 });
    expect(v['analytics.googleVision.dailyCap'].dir).toBe('less');
    expect(v['cameras.*.stills.intervalS']).toMatchObject({ type: 'integer', oneOf: [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60] });
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/fleet-remote-settable.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `src/fleet/remote-settable.ts`:

```ts
import { leafAt, CAMERA_ID } from '../config/schema';

// What cams-admin may set on this proxy (M §8.2, M5; plan R3-1, R3-2).
// Exact leaves: a new setting is denied until someone classifies it here, and
// a remote one must also be in the contract's remote-settable.json (the upper
// bound; a test). Deny wins. Compiled in: no setting, file or command widens it.
export const REMOTE: readonly string[] = [
  'stills.enabled', 'stills.stream', 'stills.intervalS', 'stills.size', 'stills.quality', 'stills.maxGB',
  'previews.tileSize', 'previews.grid', 'previews.quality', 'previews.maxGB',
  'events.onvif.subscribeMin', 'events.onvif.pullTimeoutS', 'events.poll.enabled', 'events.poll.intervalS', 'events.poll.afterOnvifDownS', 'events.maxOpenMin',
  'retention.stillsDays', 'retention.previewsDays', 'retention.clipsDays', 'retention.eventsDays', 'retention.auditDays', 'retention.streamLogDays', 'retention.intervalMin',
  'storage.maxPercent', 'storage.maxBytes', 'storage.minFreeBytes', 'storage.keepHours.stills', 'storage.keepHours.clips', 'storage.keepHours.previews',
  'composition.concurrent', 'sse.maxClients', 'sse.queuePerClient', 'sse.pingS', 'recordings.cacheMB',
  'health.diskPercent', 'health.tempC', 'host.stats',
  'ftp.enabled', 'ftp.stream', 'ftp.stalledHours', 'ftp.maxGB',
  'archive.enabled', 'archive.warnPercent',
  'analytics.kinds.person', 'analytics.kinds.vehicle', 'analytics.kinds.pet',
  'analytics.googleVision.enabled', 'analytics.googleVision.monthlyLimit', 'analytics.googleVision.dailyCap', 'analytics.googleVision.checksPerDay', 'analytics.googleVision.perCameraDailyCap',
  'cameras.*.name', 'cameras.*.statusPollS', 'cameras.*.stills.enabled', 'cameras.*.stills.stream', 'cameras.*.stills.intervalS',
  'cameras.*.ftp.enabled', 'cameras.*.ftp.stream', 'cameras.*.storage.sharePercent',
  'cameras.*.analytics.kinds.person', 'cameras.*.analytics.kinds.vehicle', 'cameras.*.analytics.kinds.pet', 'cameras.*.events.poll.enabled',
];
export const DENIED: readonly string[] = [
  'server', 'go2rtc', 'ftp.port', 'ftp.passive', 'ftp.tls', 'ftp.publicHost', 'ftp.certFile', 'ftp.keyFile', 'tls', 'composition.font', 'ntp.server', 'poeSwitch', 'camsAdmin',
  'cameras.*.id', 'cameras.*.host', 'cameras.*.protocol', 'cameras.*.tlsName', 'cameras.*.user', 'cameras.*.onvifPort', 'cameras.*.rtspPort', 'cameras.*.baichuanPort', 'cameras.*.poeSwitch', 'cameras.*.ftp.user', 'cameras.*.webUiUrl',
];
// R3-2: toward less spending, or toward more audit evidence.
export const NARROW: Readonly<Record<string, 'less' | 'more'>> = {
  'analytics.googleVision.enabled': 'less', 'analytics.googleVision.monthlyLimit': 'less', 'analytics.googleVision.dailyCap': 'less',
  'analytics.googleVision.checksPerDay': 'less', 'analytics.googleVision.perCameraDailyCap': 'less', 'retention.auditDays': 'more',
};
// Caps where 0 means "no cap" (schema docs): 0 counts as infinitely high.
const ZERO_IS_UNLIMITED = new Set(['analytics.googleVision.dailyCap', 'analytics.googleVision.perCameraDailyCap']);
const CAMERA_ID_RE = new RegExp(CAMERA_ID);
const under = (p: string, x: string) => p === x || p.startsWith(`${x}.`);

export type PathClass = 'remote' | 'denied' | 'unknown_camera' | 'not_a_setting';

export function patternOf(path: string): string {
  const m = /^cameras\.([^.]+)\.(.+)$/.exec(path);
  return m ? `cameras.*.${m[2]}` : path;
}

export function classify(path: string, cameraIds: readonly string[]): PathClass {
  const m = /^cameras\.([^.]+)(\..+)?$/.exec(path);
  if (m && !m[2]) return 'not_a_setting';
  if (m && (!CAMERA_ID_RE.test(m[1]) || !cameraIds.includes(m[1]))) return 'unknown_camera';
  if (!leafAt(path)) return 'not_a_setting';
  const pat = patternOf(path);
  if (DENIED.some((d) => under(pat, d))) return 'denied';
  return REMOTE.includes(pat) ? 'remote' : 'denied';
}

export function narrowingOk(path: string, from: unknown, to: unknown): boolean {
  const dir = NARROW[path];
  if (!dir) return true;
  if (typeof from === 'boolean' || typeof to === 'boolean') return dir === 'less' ? to === false || from === to : to === true || from === to;
  const n = (x: unknown) => (typeof x !== 'number' ? 0 : ZERO_IS_UNLIMITED.has(path) && x === 0 ? Infinity : x);
  return dir === 'less' ? n(to) <= n(from) : n(to) >= n(from);
}

export function settableView(): Record<string, { type: string; min?: number; max?: number; oneOf?: number[]; enum?: string[]; pattern?: string; optional?: boolean; dir?: 'less' | 'more' }> {
  return Object.fromEntries(REMOTE.map((pat) => {
    const leaf = leafAt(pat.replace('cameras.*.', 'cameras.x.'))!;
    const { doc: _doc, unset: _unset, ...bounds } = leaf as Record<string, unknown>;
    return [pat, { ...(bounds as { type: string }), ...(NARROW[pat] ? { dir: NARROW[pat] } : {}) }];
  }));
}
```

(`cameras.x.` works for `leafAt` because a collection consumes one id segment. Remove `DENIED_PATH_PREFIXES`/`isDeniedPath` from `policy.ts`; update `test/fleet-policy.test.ts` to import from `remote-settable.ts`.)
- [ ] **Step 4: Run** `npx vitest run test/fleet-remote-settable.test.ts test/fleet-policy.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/fleet/remote-settable.ts src/fleet/policy.ts test/fleet-remote-settable.test.ts test/fleet-policy.test.ts
git commit -m "feat(fleet): remote-settable classification (exact leaves, deny wins, narrow-only cost and audit paths)"
```

---

### Task 3: Pure planning of overrides (no behaviour change)

**Files:**
- Create: `src/config/changes.ts`, `test/config-plan.test.ts`
- Modify: `src/config/load.ts`, `src/api/control-api.ts` (`recordChanges` uses `configChanges`)

**Interfaces:**
- Produces:
  - `export interface Plan { next: Loaded; overrides: Record<string, unknown>; paths: string[] }` — `paths`: the translated leaf paths the request names.
  - `export function planOverrides(loaded: Loaded, given: object): Plan` — everything `applyOverrides` does **except** writing; throws `ConfigError` as today.
  - `export function planUnset(loaded: Loaded, paths: string[]): Plan` — leaf paths only (`ConfigError('<p>: unknown setting')` otherwise; whole cameras are `removeOverride`'s and never here).
  - `export function writeOverridesFile(file: string, overrides: object): void` (today's `writeOverrides`, exported).
  - `applyOverrides(loaded, given)` = `const p = planOverrides(loaded, given); writeOverridesFile(loaded.files.overrides, p.overrides); return p.next;`
  - `src/config/changes.ts`: `export interface Change { path: string; from?: unknown; to?: unknown; sourceFrom: Source; sourceTo: Source; restart?: 'restart' | 'process' }`; `export function configChanges(before: Loaded, after: Loaded): Change[]` (leaf paths of both configs, values compared by JSON, `restart` as `recordChanges` computes it today).
  - `export function overrideState(overrides: object, path: string): { set: boolean; value?: unknown }`.

- [ ] **Step 1: Failing tests** (`test/config-plan.test.ts`), with a temp data dir and a `config.json` (the helpers `test/config.test.ts` uses):

```ts
it('planOverrides writes nothing and equals what applyOverrides then writes', () => {
  const l = load();
  const before = readFileSync(l.files.overrides, 'utf8');
  const p = planOverrides(l, { sse: { pingS: 7 } });
  expect(readFileSync(l.files.overrides, 'utf8')).toBe(before);
  expect(p.paths).toEqual(['sse.pingS']);
  const written = applyOverrides(l, { sse: { pingS: 7 } });
  expect(written.overrides).toEqual(p.overrides);
  expect(getPath(written.config, 'sse.pingS')).toBe(7);
});
it('a value equal to Reset drops the override in the plan too', () => {
  const l = applyOverrides(load(), { sse: { pingS: 7 } });
  const p = planOverrides(l, { sse: { pingS: DEFAULTS.sse.pingS } });
  expect(getPath(p.overrides, 'sse.pingS')).toBeUndefined();
});
it('planUnset: several paths at once, nothing written; an unknown path throws', () => {
  const l = applyOverrides(load(), { sse: { pingS: 7, maxClients: 9 } });
  const p = planUnset(l, ['sse.pingS', 'sse.maxClients']);
  expect(p.overrides).toEqual({});
  expect(() => planUnset(l, ['nosuch'])).toThrow(ConfigError);
  expect(() => planUnset(l, ['cameras.cam1'])).toThrow(ConfigError);
});
it('legacy paths are translated before paths are listed', () => {
  const p = planOverrides(load(), { camera: { statusPollS: 30 } });
  expect(p.paths).toEqual(['cameras.cam1.statusPollS']);
});
it('configChanges: from, to, sources and restart flags', () => {
  const l = load();
  const n = planOverrides(l, { sse: { pingS: 7 }, stills: { quality: 5 } }).next;
  expect(configChanges(l, n)).toEqual([
    { path: 'sse.pingS', from: DEFAULTS.sse.pingS, to: 7, sourceFrom: 'default', sourceTo: 'override' },
    { path: 'stills.quality', from: DEFAULTS.stills.quality, to: 5, sourceFrom: 'default', sourceTo: 'override', restart: 'restart' },
  ].sort((a, b) => a.path.localeCompare(b.path)));
});
```

- [ ] **Step 2: Run** `npx vitest run test/config-plan.test.ts` → FAIL.
- [ ] **Step 3: Implement.** In `load.ts`, move the body of `applyOverrides` up to (not including) `writeOverrides(...)` into `planOverrides`, returning `{ next: result, overrides, paths: setPaths(patch as Obj) }`; `planUnset` folds `dropPath` over the translated paths (each must be in `settingPaths(loaded.config)`; a path with no override is skipped), then one `build(...)`. Export `setPaths` as `leafPathsOf`. `configChanges` sorts by path. In `control-api.ts`, `recordChanges` becomes `const changes = configChanges(beforeLoaded, d.loaded())` with `key: c.path` kept in the audit details for compatibility (`{key, from, to, restart?}`) so the Audit page and its tests are unchanged; it now takes the previous `Loaded` (callers keep `const before = d.loaded()`).
- [ ] **Step 4: Run** `npx vitest run test/config-plan.test.ts test/config.test.ts test/control-api.test.ts test/audit-ui.test.ts` → PASS (no existing test changes).
- [ ] **Step 5: Commit**

```bash
git add src/config/load.ts src/config/changes.ts src/api/control-api.ts test/config-plan.test.ts
git commit -m "refactor(config): plan overrides without writing; shared change list"
```

---

### Task 4: The command check for P3 (args, entries, windows, journal budgets)

**Files:**
- Modify: `src/fleet/command-args.ts`, `src/fleet/command-check.ts`, `src/fleet/journal.ts`, `src/fleet/policy.ts`, `test/fleet-command-check.test.ts`, `test/fleet-journal.test.ts`, `test/fleet-policy.test.ts`

**Interfaces:**
- Produces:
  - `command-args.ts`: `ConfigSetArgs { v: 1; dryRun: boolean; baseRevision: string; set: Record<string, boolean | number | string> }`, `ConfigUnsetArgs { v: 1; dryRun: boolean; baseRevision: string; paths: string[] }`, `ConfigRollbackArgs { v: 1; dryRun: boolean; cmdId: string }`, `CameraActionArgs { v: 1; camera: string | null; action: string; input?: { kind: string; camera?: boolean } }`, `CameraNameArgs { v: 1; camera: string; name: string }`; `validateConfigGet`, `validateConfigSet`, `validateConfigUnset`, `validateConfigRollback`, `validateCameraAction`, `validateCameraName`, `validateProxyRestart`, all in `ARGS_VALIDATORS`.
  - `policy.ts`: `NEVER_REMOTE_ACTIONS` + `'restart-proxy'`; `export const DISRUPTIVE_ACTIONS = ['restart', 'camera-reboot', 'camera-powercycle', 'camera-ftp-setup', 'camera-ftp-off', 'camera-ntp-set', 'camera-cert-push'] as const`; `export const DISRUPTIVE_ENTRIES: ReadonlySet<string>` (`proxy.restart` + `camera.action:<d>`); `IMPLEMENTED` stays P2 here and grows in Task 9.
  - `journal.ts`: `JournalEntry.action?: string`; `countSince(pred: (e: JournalEntry) => boolean, sinceMs: number): { n: number; oldest: number | null }`.
  - `CheckContext.journalBudget?: (command: string, action: string | undefined) => { ok: true } | { ok: false; retryAfterS: number }`.
  - `CommandLimits`: groups `config.set|config.unset|config.rollback` → one 6/min window; `camera.action` 12/min; `camera.name.set` 6/min.
  - `export const PATH_RE = /^[a-z][A-Za-z0-9]{0,31}(\.[a-z0-9][A-Za-z0-9-]{0,31}){0,5}$/;`

- [ ] **Step 1: Failing tests** in `test/fleet-command-check.test.ts` (helpers `cmd(command, args)`, `ctx(o)` as the file has them; `allowAll` = every `ALLOW_ENTRIES`; pass `implemented: new Set([...IMPLEMENTED, 'config.get', 'config.set', 'config.unset', 'config.rollback', 'camera.action', 'camera.name.set', 'proxy.restart'])` in this describe):

```ts
describe('P3: entries, args and budgets', () => {
  it('camera.action passes step 8 with any camera.action:* entry, then needs its own entry at step 11', () => {
    const c = ctx({ allow: ['camera.action:camera-test'] });
    expect(kind(checkCommand(cmd('camera.action', { v: 1, camera: 'cam1', action: 'camera-test' }), c))).toBe('run');
    expect(code(checkCommand(cmd('camera.action', { v: 1, camera: 'cam1', action: 'camera-reboot' }), ctx({ allow: ['camera.action:camera-test'] })))).toBe('not_allowed');
    expect(code(checkCommand(cmd('camera.action', { v: 1, camera: 'cam1', action: 'camera-test' }), ctx({ allow: ['config.get'] })))).toBe('not_allowed');
  });
  it('a never-remote action is not_allowed whatever the allow-list says; an unknown one is invalid_args', () => {
    for (const a of NEVER_REMOTE_ACTIONS) expect(code(checkCommand(cmd('camera.action', { v: 1, camera: 'cam1', action: a }), ctx({ allow: allowAll }))), a).toBe('not_allowed');
    expect(code(checkCommand(cmd('camera.action', { v: 1, camera: 'cam1', action: 'frobnicate' }), ctx({ allow: allowAll })))).toBe('invalid_args');
  });
  it('camera null only for retention-run; retention-run with a camera is invalid', () => {
    expect(code(checkCommand(cmd('camera.action', { v: 1, camera: null, action: 'camera-reboot' }), ctx({ allow: allowAll })))).toBe('invalid_args');
    expect(kind(checkCommand(cmd('camera.action', { v: 1, camera: null, action: 'retention-run' }), ctx({ allow: allowAll })))).toBe('run');
    expect(code(checkCommand(cmd('camera.action', { v: 1, camera: 'cam1', action: 'retention-run' }), ctx({ allow: allowAll })))).toBe('invalid_args');
  });
  it('config.set args: dotted paths only, leaf values only, 1–64 entries, a revision', () => {
    const base = { v: 1, dryRun: true, baseRevision: `sha256:${'a'.repeat(64)}` };
    const ok = (set: object) => kind(checkCommand(cmd('config.set', { ...base, set }), ctx({ allow: ['config.set'] })));
    expect(ok({ 'sse.pingS': 5 })).toBe('run');
    for (const bad of [{}, { 'Sse.pingS': 5 }, { '__proto__.x': 1 }, { 'sse..pingS': 1 }, { 'sse.pingS': null }, { 'sse.pingS': { a: 1 } }, { 'sse.pingS': [1] }, { 'sse.pingS': 1.5 }, { 'x.y': 'z'.repeat(513) }, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`a.b${i}`, 1]))])
      expect(ok(bad), JSON.stringify(bad).slice(0, 60)).toBe('nack');
    expect(kind(checkCommand(cmd('config.set', { ...base, baseRevision: 'sha256:XYZ', set: { 'sse.pingS': 5 } }), ctx({ allow: ['config.set'] })))).toBe('nack');
  });
  it('config.unset: unique paths; config.rollback: a cmd id; config.get and proxy.restart: exactly {v: 1}', () => {});
  it('step 9: config.set/unset/rollback share 6 a minute (dry runs count)', () => {});
  it('step 11: proxy.restart at most 2 an hour from the journal (a restart does not reset it)', () => {
    const journal = [{ cmdId: 'cmd_A', command: 'proxy.restart', at: NOW - 10 * 60_000 }, { cmdId: 'cmd_B', command: 'proxy.restart', at: NOW - 5 * 60_000 }];
    const d = checkCommand(cmd('proxy.restart', { v: 1 }), ctx({ allow: ['proxy.restart'], journal }));
    expect(d).toMatchObject({ kind: 'nack', code: 'rate_limited', retryAfterS: 50 * 60 });
  });
  it('step 11: six disruptive camera actions an hour per proxy, any camera; non-disruptive ones are not counted', () => {});
  it('the fixtures: every P3 refused-* and valid-command-* fixture as the contract says', () => {
    for (const { name, f } of fixtures().filter((x) => x.f.schema === 'command' && x.f.$context)) {
      const d = checkCommand(f.message as Envelope, fixtureCtx(f.$context!, P3_IMPLEMENTED));
      expect(d.kind === 'nack' ? d.code : d.kind, name).toBe(name.startsWith('valid-') ? 'run' : f.$expect!.runtime);
    }
  });
});
```

(`fixtureCtx` builds `journalBudget` from `$context.journal` with the same function the runner uses, `journalBudgetOf(entries, now)`, exported from `command-check.ts`.) `test/fleet-journal.test.ts`: `countSince` counts entries newer than `sinceMs` matching the predicate and returns the oldest one's time.
- [ ] **Step 2: Run** `npx vitest run test/fleet-command-check.test.ts test/fleet-journal.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `command-args.ts` (closed objects via `only()`, as `validateTokensApply`):

```ts
export const PATH_RE = /^[a-z][A-Za-z0-9]{0,31}(\.[a-z0-9][A-Za-z0-9-]{0,31}){0,5}$/;
const REV = /^sha256:[0-9a-f]{64}$/;
const CMD_ID = /^cmd_[0-9A-HJKMNP-TV-Z]{20}$/;
const CAM = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NAME = /^[^\u0000-\u001f\u007f]{1,64}$/u;
const leafValue = (x: unknown) => typeof x === 'boolean' || Number.isSafeInteger(x) || (typeof x === 'string' && x.length <= 512);
const v1 = <T>(a: unknown, keys: string[], rest: (o: Record<string, unknown>) => string | null): ArgsVerdict<T> => {
  if (!isObj(a)) return { ok: false, code: 'invalid_args', detail: 'args: not an object' };
  if (a.v !== 1) return Number.isInteger(a.v) ? { ok: false, code: 'unsupported_version', detail: `args.v ${String(a.v)}` } : { ok: false, code: 'invalid_args', detail: 'args.v' };
  if (!only(a, ['v', ...keys])) return { ok: false, code: 'invalid_args', detail: 'args: unknown field' };
  const bad = rest(a);
  return bad ? { ok: false, code: 'invalid_args', detail: bad } : { ok: true, args: a as T };
};
export const validateConfigGet = (a: unknown) => v1<{ v: 1 }>(a, [], () => null);
export const validateProxyRestart = validateConfigGet;
export const validateConfigSet = (a: unknown) => v1<ConfigSetArgs>(a, ['dryRun', 'baseRevision', 'set'], (o) => {
  if (typeof o.dryRun !== 'boolean') return 'dryRun';
  if (typeof o.baseRevision !== 'string' || !REV.test(o.baseRevision)) return 'baseRevision';
  if (!isObj(o.set)) return 'set';
  const e = Object.entries(o.set);
  if (e.length < 1 || e.length > 64) return 'set: 1 to 64 entries';
  for (const [p, x] of e) if (!PATH_RE.test(p) || !leafValue(x)) return `set.${p.slice(0, 64)}`;
  return null;
});
export const validateConfigUnset = (a: unknown) => v1<ConfigUnsetArgs>(a, ['dryRun', 'baseRevision', 'paths'], (o) => {
  if (typeof o.dryRun !== 'boolean') return 'dryRun';
  if (typeof o.baseRevision !== 'string' || !REV.test(o.baseRevision)) return 'baseRevision';
  if (!Array.isArray(o.paths) || o.paths.length < 1 || o.paths.length > 64) return 'paths: 1 to 64';
  if (o.paths.some((p) => typeof p !== 'string' || !PATH_RE.test(p)) || new Set(o.paths).size !== o.paths.length) return 'paths';
  return null;
});
export const validateConfigRollback = (a: unknown) => v1<ConfigRollbackArgs>(a, ['dryRun', 'cmdId'], (o) => (typeof o.dryRun !== 'boolean' ? 'dryRun' : typeof o.cmdId !== 'string' || !CMD_ID.test(o.cmdId) ? 'cmdId' : null));
export const validateCameraAction = (a: unknown) => v1<CameraActionArgs>(a, ['camera', 'action', 'input'], (o) => {
  if (typeof o.action !== 'string' || ![...REMOTE_ACTIONS, ...NEVER_REMOTE_ACTIONS].includes(o.action as never)) return 'action';
  if (o.action === 'retention-run' ? o.camera !== null : typeof o.camera !== 'string' || !CAM.test(o.camera)) return 'camera';
  if (o.input !== undefined) {
    if (o.action !== 'inventory' || !isObj(o.input) || !only(o.input, ['kind', 'camera'])) return 'input';
    if (typeof o.input.kind !== 'string' || o.input.kind.length < 1 || o.input.kind.length > 32) return 'input.kind';
    if (o.input.camera !== undefined && typeof o.input.camera !== 'boolean') return 'input.camera';
  }
  return null;
});
export const validateCameraName = (a: unknown) => v1<CameraNameArgs>(a, ['camera', 'name'], (o) => (typeof o.camera !== 'string' || !CAM.test(o.camera) ? 'camera' : typeof o.name !== 'string' || !NAME.test(o.name) ? 'name' : null));
```

`command-check.ts` — step 8 and step 11:

```ts
  const entryOk = command === 'camera.action' ? c.policy.allow.some((e) => e.startsWith('camera.action:')) : c.policy.allow.includes(command);
  if (!c.implemented.has(command) || (!claim && !entryOk)) return nack('not_allowed');
  // … step 9, step 10 as today …
  if (command === 'camera.action') {
    const a = (v.args as CameraActionArgs).action;
    if ((NEVER_REMOTE_ACTIONS as readonly string[]).includes(a) || !c.policy.allow.includes(`camera.action:${a}`)) return nack('not_allowed');
  }
  if (command === 'proxy.restart' || (command === 'camera.action' && (DISRUPTIVE_ACTIONS as readonly string[]).includes((v.args as CameraActionArgs).action))) {
    const b = c.journalBudget?.(command, command === 'camera.action' ? (v.args as CameraActionArgs).action : undefined) ?? { ok: true };
    if (!b.ok) return nack('rate_limited', b.retryAfterS);
  }
```

```ts
export function journalBudgetOf(count: Journal['countSince'], now: number) {
  return (command: string, action?: string): { ok: true } | { ok: false; retryAfterS: number } => {
    const hour = now - 3_600_000;
    const r = command === 'proxy.restart'
      ? { ...count((e) => e.command === 'proxy.restart', hour), cap: 2 }
      : { ...count((e) => e.command === 'camera.action' && (DISRUPTIVE_ACTIONS as readonly string[]).includes(e.action ?? ''), hour), cap: 6 };
    return r.n < r.cap ? { ok: true } : { ok: false, retryAfterS: Math.max(1, Math.ceil((r.oldest! + 3_600_000 - now) / 1000)) };
  };
}
```

`CommandLimits.per`: build windows once and share the instance: `const cfg = new Window(60_000, 6); this.per = { 'tokens.apply': [new Window(3_600_000, 6)], 'config.set': [cfg], 'config.unset': [cfg], 'config.rollback': [cfg], 'camera.action': [new Window(60_000, 12)], 'camera.name.set': [new Window(60_000, 6)] };`. `Journal.countSince` walks `this.entries` from the newest back while `at >= sinceMs`.
- [ ] **Step 4: Run** `npx vitest run test/fleet-command-check.test.ts test/fleet-journal.test.ts test/fleet-policy.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/fleet/command-args.ts src/fleet/command-check.ts src/fleet/journal.ts src/fleet/policy.ts test/fleet-command-check.test.ts test/fleet-journal.test.ts test/fleet-policy.test.ts
git commit -m "feat(fleet): P3 command check: args, camera.action entries, shared config window, journal budgets"
```

---

### Task 5: Overrides backups

**Files:**
- Create: `src/fleet/backups.ts`, `test/fleet-backups.test.ts`

**Interfaces:**
- Produces:

```ts
export interface PathState { set: boolean; value?: unknown }
export interface Backup {
  v: 1; cmdId: string; command: 'config.set' | 'config.unset' | 'config.rollback'; actor: string; at: number;
  revisionBefore: string; revisionAfter: string;
  paths: { path: string; before: PathState; after: PathState }[];
  rolledBack?: { at: number; by: 'cams-admin' | 'local'; cmdId?: string; user?: string };
}
export class OverridesBackups {
  constructor(dir: string, now?: () => number); // dir = <dataDir>/admin
  save(b: Backup): void;              // writePrivateJson(overrides.bak-<cmdId>.json), then prune to the newest 20 by `at`
  get(cmdId: string): Backup | null;  // null: missing, unsafe or invalid (logged once)
  list(): Backup[];                   // newest first, valid ones only
  markRolledBack(cmdId: string, r: NonNullable<Backup['rolledBack']>): void;
  byPath(): Map<string, { cmdId: string; actor: string; at: number; value: unknown }>; // the newest not-rolled-back backup whose `after` set the path (R3-14 marker)
}
```

- [ ] **Step 1: Failing tests:** save/get round trip, file mode 600 in a 700 folder; the 21st save deletes the oldest file; `get` of a world-readable file returns null (P2's private-file rule) and of a malformed one null; `cmdId` must match the command id pattern (a path traversal id like `../x` throws before any file name is built); `markRolledBack` persists; `byPath` ignores rolled-back backups and keeps the newest per path.
- [ ] **Step 2: Run** `npx vitest run test/fleet-backups.test.ts` → FAIL.
- [ ] **Step 3: Implement** with `readPrivateJson`/`writePrivateJson` from `private-file.ts`; file name `overrides.bak-${cmdId}.json` only after `/^cmd_[0-9A-HJKMNP-TV-Z]{20}$/.test(cmdId)`; `list()` reads `readdirSync(dir).filter((f) => /^overrides\.bak-cmd_[0-9A-HJKMNP-TV-Z]{20}\.json$/.test(f))`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/fleet/backups.ts test/fleet-backups.test.ts
git commit -m "feat(fleet): overrides backups per cams-admin write (last 20, private files)"
```

---

### Task 6: `config.get`, `config.set`, `config.unset`, `config.rollback`

**Files:**
- Create: `src/fleet/config-commands.ts`, `test/fleet-config-commands.test.ts`
- Modify: `src/api/control-api.ts` (export `configView` from a small module or move it to `src/config/view.ts` so both use it)

**Interfaces:**
- Consumes: Tasks 2, 3, 5; `configRevision(l)` (P2); `Handler`, `Done` (P2 `commands.ts`).
- Produces:

```ts
export interface ConfigCommandDeps {
  loaded: () => Loaded;
  setLoaded: (l: Loaded) => void;         // proxy.ts's: applies live settings
  running: () => Config;                  // what the components run with (config.get's values)
  backups: OverridesBackups;
  audit: Pick<AuditLog, 'write'>;
  now?: () => number;
}
export function configHandlers(d: ConfigCommandDeps): Record<'config.get' | 'config.set' | 'config.unset' | 'config.rollback', Handler>;
export function compactView(l: Loaded, running: Config, marks: ReturnType<OverridesBackups['byPath']>, maxCameras?: number): Record<string, unknown>; // the config.get result
export function undoLocal(d: ConfigCommandDeps, cmdId: string, who: { user: string; ip?: string; userAgent?: string }): Done; // the card's Undo (R3-5)
```

- [ ] **Step 1: Failing tests** (`test/fleet-config-commands.test.ts`), with a real `loadConfig` in a temp dir (two cameras `cam1`, `cam2`), a `setLoaded` that records, an in-memory audit, `CMD = (n) => 'cmd_' + String(n).padStart(20, '0')`, `rev()` = `configRevision(loaded)`:

```ts
const run = (name: string, args: object, n = 1) => h[name](args, { cmdId: CMD(n), actor: 'admin@example.org', command: name } as CommandBody);

it('config.get: compact paths with sources, settable bounds, the revision; no secret anywhere', async () => {
  const r = (await run('config.get', { v: 1 })) as Done;
  expect(r.status).toBe('ok');
  expect(r.result).toMatchObject({ revision: rev(), schema: CONFIG_SCHEMA, cameras: ['cam1', 'cam2'], omittedCameras: [] });
  expect((r.result!.paths as Record<string, unknown>)['sse.pingS']).toEqual({ v: DEFAULTS.sse.pingS, s: 'default' });
  expect((r.result!.settable as Record<string, unknown>)['cameras.*.name']).toBeDefined();
  expect(JSON.stringify(r.result)).not.toMatch(/password|CAMPROXY_|token/i);
});
it('config.get: a 24-camera proxy stays under 64 KiB; the 25th camera is omitted, not cut', () => {});
it('dry run: the diff, nothing written, no config-change record, revision unchanged', async () => {
  const before = readFileSync(overridesFile, 'utf8');
  const r = await run('config.set', { v: 1, dryRun: true, baseRevision: rev(), set: { 'sse.pingS': 7, 'stills.quality': 5 } });
  expect(r).toMatchObject({ status: 'ok', result: { dryRun: true, revision: rev(), changes: [
    { path: 'sse.pingS', from: DEFAULTS.sse.pingS, to: 7, sourceFrom: 'default', sourceTo: 'override' },
    { path: 'stills.quality', from: DEFAULTS.stills.quality, to: 5, sourceFrom: 'default', sourceTo: 'override', restart: 'restart' }] } });
  expect(readFileSync(overridesFile, 'utf8')).toBe(before);
  expect(setLoaded).not.toHaveBeenCalled();
  expect(audit.records.filter((x) => x.action === 'config-change')).toHaveLength(0);
});
it('apply: written, applied live, backup saved, config-change by cams-admin with cmdId and actor', async () => {
  const base = rev();
  const r = await run('config.set', { v: 1, dryRun: false, baseRevision: base, set: { 'sse.pingS': 7 } }, 2);
  expect(r).toMatchObject({ status: 'ok', result: { dryRun: false, baseRevision: base } });
  expect((r as Done).result!.revision).not.toBe(base);
  expect(setLoaded).toHaveBeenCalledTimes(1);
  expect(backups.get(CMD(2))).toMatchObject({ paths: [{ path: 'sse.pingS', before: { set: false }, after: { set: true, value: 7 } }] });
  expect(audit.records.find((x) => x.action === 'config-change')).toMatchObject({ user: 'cams-admin', details: { cmdId: CMD(2), actor: 'admin@example.org', changes: [{ key: 'sse.pingS', to: 7 }] } });
});
it('Review Focus 1: trust paths fail before planning, the file stays byte-identical', async () => {
  const spy = vi.spyOn(load, 'writeOverridesFile');
  const plan = vi.spyOn(load, 'planOverrides');
  for (const [set, code] of [
    [{ 'cameras.cam1.host': '192.0.2.9' }, 'not_remote_settable'], [{ 'camsAdmin.url': 'https://evil.example' }, 'not_remote_settable'],
    [{ 'cameras.evil.name': 'x' }, 'unknown_camera'], [{ 'cameras.evil.host': '192.0.2.9' }, 'unknown_camera'],
    [{ 'camera.host': '192.0.2.9' }, 'not_remote_settable'], // legacy path, translated to cameras.cam1.host first (one-camera fixture: run in the 1-camera config)
    [{ 'ntp.server': '192.0.2.1' }, 'not_remote_settable'], [{ 'ftp.publicHost': '192.0.2.1' }, 'not_remote_settable'],
    [{ 'sse.pingS': 7, 'tls.site': 'x' }, 'not_remote_settable'], // one bad path fails the whole command
  ] as const) {
    const r = await run('config.set', { v: 1, dryRun: false, baseRevision: rev(), set });
    expect(r, JSON.stringify(set)).toMatchObject({ status: 'failed', code, result: { paths: expect.arrayContaining([expect.objectContaining({ code })]) } });
  }
  expect(spy).not.toHaveBeenCalled();
  expect(plan).not.toHaveBeenCalled();
});
it('held_by_env, even on a dry run (a remote-settable path the env layer holds)', async () => {
  // a Loaded whose envNames holds 'sse.pingS' (built with the test's env-layer helper): failed held_by_env.
});
it('Review Focus 2: a local edit between dry run and apply → conflict with the current values; nothing written', async () => {
  const base = rev();
  await run('config.set', { v: 1, dryRun: true, baseRevision: base, set: { 'sse.pingS': 7 } });
  localEdit({ sse: { pingS: 9 } }); // applyOverrides through the same Loaded holder, like PUT /control/config
  const r = await run('config.set', { v: 1, dryRun: false, baseRevision: base, set: { 'sse.pingS': 7 } }, 2);
  expect(r).toMatchObject({ status: 'conflict', result: { revision: rev(), current: { 'sse.pingS': { v: 9, s: 'override' } } } });
  expect(getPath(holder.loaded.config, 'sse.pingS')).toBe(9);
  const dry = await run('config.set', { v: 1, dryRun: true, baseRevision: base, set: { 'sse.pingS': 7 } }, 3);
  expect(dry.status).toBe('conflict');
});
it('narrow paths (R3-2): raising a Vision limit or lowering audit days fails widening_local_only', async () => {});
it('invalid_value: the proxy\'s own rules (e.g. previews.grid too small for stills.intervalS), the message as detail', async () => {});
it('config.unset: back to file/default, same checks, backup saved', async () => {});
it('Review Focus 3: rollback restores only the command\'s paths; an unrelated local edit stays; the same path edited since → conflict', async () => {
  const r1 = await run('config.set', { v: 1, dryRun: false, baseRevision: rev(), set: { 'sse.pingS': 7, 'sse.maxClients': 50 } }, 2);
  localEdit({ stills: { quality: 4 } }); // unrelated
  const rb = await run('config.rollback', { v: 1, dryRun: false, cmdId: CMD(2) }, 3);
  expect(rb).toMatchObject({ status: 'ok', result: { of: CMD(2), changes: expect.arrayContaining([expect.objectContaining({ path: 'sse.pingS', to: DEFAULTS.sse.pingS })]) } });
  expect(getPath(holder.loaded.config, 'stills.quality')).toBe(4);
  expect(await run('config.rollback', { v: 1, dryRun: false, cmdId: CMD(2) }, 4)).toMatchObject({ status: 'failed', code: 'already_rolled_back' });
  // the conflict case: set, then a local edit of the same path, then rollback
  await run('config.set', { v: 1, dryRun: false, baseRevision: rev(), set: { 'sse.pingS': 11 } }, 5);
  localEdit({ sse: { pingS: 12 } });
  expect(await run('config.rollback', { v: 1, dryRun: false, cmdId: CMD(5) }, 6)).toMatchObject({ status: 'conflict', result: { current: { 'sse.pingS': { v: 12, s: 'override' } } } });
  void r1;
});
it('rollback: no_backup for an unknown cmdId; a dry run writes nothing; a rollback of a rollback restores again', async () => {});
it('rollback re-checks the classification (a backup naming a denied path is refused not_remote_settable)', async () => {});
it('a store error (overrides.json not writable) fails store_error and leaves the running config unchanged', async () => {});
```

- [ ] **Step 2: Run** `npx vitest run test/fleet-config-commands.test.ts` → FAIL.
- [ ] **Step 3: Implement** `src/fleet/config-commands.ts`. The core of `config.set`/`config.unset` (synchronous from the revision check to the write):

```ts
type Failure = { path: string; code: string; detail?: string };
const failed = (code: string, paths: Failure[]): Done => ({ status: 'failed', code, result: { paths } });

function checkPaths(l: Loaded, paths: string[]): Done | null {
  const ids = l.config.cameraOrder;
  const fails: Failure[] = [];
  for (const p of paths) {
    const c = classify(p, ids);
    if (c === 'unknown_camera') fails.push({ path: p, code: 'unknown_camera' });
    else if (c !== 'remote') fails.push({ path: p, code: 'not_remote_settable' });
    else if (l.sources[p] === 'env') fails.push({ path: p, code: 'held_by_env' });
  }
  if (!fails.length) return null;
  // The first code in the contract's order names the command's outcome.
  const order = ['unknown_camera', 'not_remote_settable', 'held_by_env'];
  return failed(order.find((o) => fails.some((f) => f.code === o))!, fails);
}

function write(d: ConfigCommandDeps, cmd: CommandBody, args: { dryRun: boolean; baseRevision: string }, request: (l: Loaded) => { paths: string[]; plan: () => Plan }): Done {
  const l = d.loaded();
  let req: { paths: string[]; plan: () => Plan };
  try {
    req = request(l); // translates paths (legacy) without planning
  } catch (err) {
    return failed('invalid_value', [{ path: '', code: 'invalid_value', detail: String((err as Error).message).slice(0, 200) }]);
  }
  const bad = checkPaths(l, req.paths);
  if (bad) return bad;
  const revision = configRevision(l);
  if (args.baseRevision !== revision) return { status: 'conflict', result: { revision, current: currentOf(l, req.paths) } };
  let plan: Plan;
  try {
    plan = req.plan();
  } catch (err) {
    if (err instanceof ConfigError) return failed('invalid_value', [{ path: pathOfMessage(err.message), code: 'invalid_value', detail: err.message.slice(0, 200) }]);
    throw err;
  }
  const changes = configChanges(l, plan.next);
  const widening = changes.filter((c) => !narrowingOk(c.path, c.from, c.to));
  if (widening.length) return failed('widening_local_only', widening.map((c) => ({ path: c.path, code: 'widening_local_only' })));
  const unchanged = req.paths.filter((p) => !changes.some((c) => c.path === p));
  if (args.dryRun) return { status: 'ok', result: { dryRun: true, baseRevision: revision, revision, changes, unchanged } };
  try {
    writeOverridesFile(l.files.overrides, plan.overrides);
  } catch {
    return { status: 'failed', code: 'store_error', result: { paths: [] } };
  }
  d.setLoaded(plan.next);
  const after = configRevision(plan.next);
  d.backups.save({ v: 1, cmdId: cmd.cmdId, command: cmd.command as Backup['command'], actor: cmd.actor, at: (d.now ?? Date.now)(), revisionBefore: revision, revisionAfter: after,
    paths: req.paths.map((p) => ({ path: p, before: overrideState(l.overrides, p), after: overrideState(plan.overrides, p) })) });
  if (changes.length) d.audit.write({ action: 'config-change', category: ['configuration'], type: ['change'], outcome: 'success', user: 'cams-admin',
    message: `Settings changed by cams-admin (on behalf of ${cmd.actor}): ${changes.map((c) => c.path).join(', ')}`,
    details: { cmdId: cmd.cmdId, actor: cmd.actor, changes: changes.map((c) => ({ key: c.path, from: c.from, to: c.to, ...(c.restart ? { restart: c.restart } : {}) })) } });
  return { status: 'ok', result: { dryRun: false, baseRevision: revision, revision: after, changes, unchanged }, changed: changes.map((c) => c.path) };
}
```

- `config.set`: `request = (l) => { const patch = {}; for (const [p, v] of Object.entries(args.set)) setPath(patch, p, v); const norm = normalizeOverrides(patch, l.order, l.addedCameras); const paths = leafPathsOf(norm); return { paths, plan: () => planOverrides(l, norm) }; }` (`setPath` on a fresh `{}` with `PATH_RE`-checked keys; classification runs on the **translated** `paths`).
- `config.unset`: `paths = args.paths.map((p) => translatePath(p, l.order))`; `plan: () => planUnset(l, paths)`.
- `config.rollback`: `b = d.backups.get(args.cmdId)` → `no_backup`; `b.rolledBack` → `already_rolled_back`; `checkPaths(l, b.paths.map((x) => x.path))` (defense, R3-5); the paths whose `overrideState(l.overrides, path)` ≠ `after` → `conflict` `{revision, current: currentOf(l, thosePaths)}`; otherwise build the overrides by setting/dropping each path to `before` (`dropPath`/`setPath` on a clone), `build` through `planOverrides(l, {})`-equivalent `rebuild(l, overrides)` (export a small `rebuildWith(l, overrides): Loaded` from `load.ts` that calls `build`); **no** narrowing check (R3-2); dry run returns the changes; otherwise write, `setLoaded`, save its own backup (command `config.rollback`), `markRolledBack(args.cmdId, {at, by: 'cams-admin', cmdId: cmd.cmdId})`, `config-change` record with `details.rollbackOf`. Result adds `of: args.cmdId`.
- `config.get`: `{status: 'ok', result: compactView(d.loaded(), running(), d.backups.byPath())}`; `compactView` maps `configView`'s entries to `{v, s, r, p, n, by}` (drop `type`, `env`, `resetTo`, `legacy`; `by` only when the override value equals the marked value), adds `settable: settableView()`, `schema: CONFIG_SCHEMA`, `cameras`, and drops camera paths beyond `maxCameras` (24) into `omittedCameras`.
- `undoLocal(d, cmdId, who)` = the rollback path with `by: 'local'`, `user: who.user`, no backup of its own (it is not a cams-admin command), `config-change` record with the local user and `details.undoOf`.
- `currentOf(l, paths)` = `{ [p]: { ...(getPath(l.config, p) !== undefined ? { v: getPath(l.config, p) } : {}), s: l.sources[p] ?? 'default' } }`.
- [ ] **Step 4: Run** `npx vitest run test/fleet-config-commands.test.ts test/config-plan.test.ts test/control-api.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/fleet/config-commands.ts src/config/load.ts src/api/control-api.ts test/fleet-config-commands.test.ts
git commit -m "feat(fleet): config.get/set/unset/rollback with dry run, revision conflict, path-level rollback"
```

---

### Task 7: The `performAction` core, and the Push-now key leak

**Files:**
- Create: `src/api/actions.ts`, `test/control-actions-core.test.ts`
- Modify: `src/api/control-api.ts` (the action route becomes a thin mapper), `src/camera/reboot.ts` (requester type), `src/tls/camera-certs.ts` (`Requester` type), `test/control-api.test.ts` (one new assertion)

**Interfaces:**
- Produces:

```ts
export interface ActionWho { user: string; requestedBy: 'session' | 'token' | 'cams-admin'; ip?: string; userAgent?: string; cmdId?: string; actor?: string }
export type ActionOutcome =
  | { status: number; json?: unknown; retryAfterS?: number; errorCode?: never }
  | { status: number; error: string; detail?: string; extra?: Record<string, unknown>; retryAfterS?: number };
export type ActionDeps = Pick<ControlDeps, 'cameras' | 'cameraCount' | 'cameraId' | 'running' | 'resubscribe' | 'checkCamera' | 'storage' | 'cameraFtp' | 'restart' | 'restartCamera' | 'cameraReboot' | 'cameraPowerCycle' | 'poeSwitch' | 'findCamera' | 'envFile' | 'restartProcess' | 'inventory' | 'archive' | 'tls' | 'cameraNtp' | 'audit'>;
export async function performAction(d: ActionDeps, name: string, cam: string | null, body: Record<string, unknown>, who: ActionWho): Promise<ActionOutcome>;
export function projectPush(r: PushResult): { outcome: string; served: string | null; leaf?: { fingerprint: string; notAfter: number; names: string[]; ips: string[] }; detail?: string; tookMs: number };
export const OWN_AUDIT: ReadonlySet<string>; // moved, unchanged
```

- `RebootRequester` → `{ user?: string; requestedBy: 'session' | 'token' | 'cams-admin'; ip?: string; userAgent?: string; cmdId?: string; actor?: string }`; the reboot/power-cycle records use `user: who.user ?? 'admin'` and put `cmdId`/`actor` in `details` when present. Same for `Requester` in `camera-certs.ts`.

- [ ] **Step 1: Failing tests** (`test/control-actions-core.test.ts`, against the existing control-api test harness that builds `ControlDeps` with fakes):

```ts
it('performAction answers what the route answered (camera-test, retention-run dry, restart one camera, too_soon with Retry-After, not_configured)', async () => {});
it('the route maps an outcome to the same status, JSON and headers as before (snapshot of the existing control-api tests passes unchanged)', () => {});
it('Push now never answers key material (security fix, R3-8)', async () => {
  const res = await request(app).post('/control/cameras/cam1/actions/camera-cert-push').set(auth);
  expect(JSON.stringify(res.body)).not.toMatch(/BEGIN|keyPem|certPem|servedPem/);
  expect(res.body).toMatchObject({ outcome: 'pushed', leaf: { fingerprint: expect.any(String) } });
});
it('a cams-admin requester shows in the reboot record: user cams-admin, requestedBy cams-admin, the cmdId', async () => {});
```

- [ ] **Step 2: Run** `npx vitest run test/control-actions-core.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Move the `switch (name)` of `action` into `performAction`, replacing each `res.…` with a returned outcome (`fail(s, e, detail, extra)` → `{status: s, error: e, detail, extra}`; `tooSoon(a)` → `{status: 429, error: 'too_soon', detail, retryAfterS: a.retryAfterS}`; `res.json(x)` → `{status: 200, json: x}`; `res.status(202).end()` → `{status: 202}`; `cameraCall` → a function returning the outcome). `restart-proxy` returns `{status: 202}` and the route keeps its `res.once('close', …restartProcess)` (the core never restarts by itself). `camera-cert-push` returns `{status: 200, json: projectPush(await d.tls.pushNow(cam, who))}`. The route:

```ts
const send = (res: Response, o: ActionOutcome) => {
  if (o.retryAfterS !== undefined) res.setHeader('Retry-After', String(o.retryAfterS));
  if ('error' in o && o.error) { res.locals.errorCode = o.error; return void res.status(o.status).json({ error: o.error, ...(o.detail ? { detail: o.detail } : {}), ...(o.extra ?? {}) }); }
  return o.json === undefined ? void res.status(o.status).end() : void res.status(o.status).json(o.json);
};
```

The route keeps the parts that are HTTP-only: `targetCamera` (404/503), the `control-action` record on `close`, and the `camera_required` answer. `performAction` gets `cam` already resolved (`null` only for host actions).
- [ ] **Step 4: Run** `npx vitest run test/control-actions-core.test.ts test/control-api.test.ts test/control-camera-routes.test.ts test/camera-reboot.test.ts test/camera-powercycle.test.ts test/config-tls.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/api/actions.ts src/api/control-api.ts src/camera/reboot.ts src/tls/camera-certs.ts test/control-actions-core.test.ts test/control-api.test.ts
git commit -m "refactor(api): actions as an Express-free core; Push now no longer answers key material"
```

---

### Task 8: `camera.action`, `camera.name.set`, `proxy.restart`

**Files:**
- Create: `src/fleet/camera-commands.ts`, `test/fleet-camera-commands.test.ts`
- Modify: `src/fleet/commands.ts` (`Done.after`, journal `action`)

**Interfaces:**
- Consumes: `performAction`, `ActionWho` (Task 7); `cameraName.write` (existing); `restartProcess` (existing).
- Produces:

```ts
export interface CameraCommandDeps {
  actions: ActionDeps;
  cameraIds: () => string[];
  cameraName: { write: (cam: string, name: string) => Promise<string> };
  restartProcess: () => void;
  now?: () => number;
}
export function cameraHandlers(d: CameraCommandDeps): Record<'camera.action' | 'camera.name.set' | 'proxy.restart', Handler>;
export function scrub(x: unknown, depth?: number): unknown;       // R3-8
export function verifyFtp(action: 'camera-ftp-setup' | 'camera-ftp-off', answer: Record<string, unknown>, target?: { server: string; port: number; tls: boolean; stream: 'main' | 'sub' }): { verified: boolean; mismatch: string[] };
export function verifyNtp(answer: { outcome: string }): { verified: boolean; mismatch: string[] };
export function verifyPush(answer: { outcome: string; served: string | null; leaf?: { fingerprint: string } }): { verified: boolean; mismatch: string[] };
```

- `commands.ts`: `export type Done = { status: 'ok' | 'failed' | 'conflict'; code?: string; result?: Record<string, unknown>; changed?: string[]; action?: string; after?: () => void }`; `run()` copies `done.action` into the journal entry, and after `send('result', …)` (whether it was delivered or not) calls `done.after?.()` inside `setImmediate` (errors logged `admin_command_after_error`).

- [ ] **Step 1: Failing tests** (`test/fleet-camera-commands.test.ts`, with the control-api harness fakes and the in-process cam-sim where the existing camera tests use it):

```ts
it('camera.action camera-test: ok with the action\'s answer as answer, httpStatus 200', async () => {});
it('unknown camera → failed unknown_camera; a restarting one → failed camera_restarting', async () => {});
it('camera-reboot inside the cooldown → failed too_soon (the existing 2-minute cooldown)', async () => {});
it('retention-run is always a dry run (the storage is never asked for a real run)', async () => {
  const spy = vi.spyOn(storage, 'run');
  await h['camera.action']({ v: 1, camera: null, action: 'retention-run' }, cmdBody('camera.action'));
  expect(spy).toHaveBeenCalledWith({ dryRun: true });
});
it('a never-remote action reaching the handler (defense) fails not_allowed; restart without a camera is never the host-wide restart', async () => {});
it('camera-ftp-setup against cam-sim: whole-object Set, re-read, verified true; the answer has no password', async () => {
  const r = (await h['camera.action']({ v: 1, camera: 'cam1', action: 'camera-ftp-setup' }, cmdBody('camera.action'))) as Done;
  expect(r).toMatchObject({ status: 'ok', result: { httpStatus: 200, verified: true, mismatch: [] } });
  expect(JSON.stringify(r.result)).not.toMatch(/password/i);
});
it('camera-ntp-set: failed outcome from the camera → verified false, mismatch [server]', async () => {});
it('camera-cert-push: projected (no PEM), verified when the camera serves the pushed leaf', async () => {});
it('scrub: drops pem/key/password/secret/token/cookie keys at any depth; over 16 KiB → answer null, clamped true', () => {
  expect(scrub({ a: 1, keyPem: 'x', nested: [{ password: 'p', ok: true }], Token: 't' })).toEqual({ a: 1, nested: [{ ok: true }] });
});
it('camera.name.set: SetDevName through cameraName.write, re-read, verified; invalid name → failed invalid_name', async () => {});
it('proxy.restart: done is journaled and sent before restartProcess runs; a re-sent cmdId answers duplicate and never restarts again', async () => {
  const order: string[] = [];
  // runner with a send that records 'sent' and restartProcess that records 'restart'
  await runner.onCommand(signed('proxy.restart', { v: 1 }), conn, (type, body) => (order.push(`${type}:${body.phase}`), true));
  await new Promise((r) => setImmediate(r));
  expect(order).toEqual(['result:received', 'result:done', 'restart']);
  await runner.onCommand(resigned(sameCmdId), conn2, send);
  expect(order.filter((x) => x === 'restart')).toHaveLength(1);
});
```

- [ ] **Step 2: Run** `npx vitest run test/fleet-camera-commands.test.ts` → FAIL.
- [ ] **Step 3: Implement.**

```ts
const SECRET_KEY = /pem|key|password|passwd|secret|token|cookie/i;
export function scrub(x: unknown, depth = 0): unknown {
  if (depth > 16) return null;
  if (Array.isArray(x)) return x.map((v) => scrub(v, depth + 1));
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).filter(([k]) => !SECRET_KEY.test(k)).map(([k, v]) => [k, scrub(v, depth + 1)]));
  return typeof x === 'string' && x.length > 2000 ? x.slice(0, 2000) : x;
}
const CAMERA_WRITES = new Set(['camera-ftp-setup', 'camera-ftp-off', 'camera-ntp-set', 'camera-cert-push']);

export function cameraHandlers(d: CameraCommandDeps): Record<'camera.action' | 'camera.name.set' | 'proxy.restart', Handler> {
  const who = (cmd: CommandBody): ActionWho => ({ user: 'cams-admin', requestedBy: 'cams-admin', cmdId: cmd.cmdId, actor: cmd.actor });
  return {
    'camera.action': async (args, cmd) => {
      const a = args as CameraActionArgs;
      if ((NEVER_REMOTE_ACTIONS as readonly string[]).includes(a.action) || !(REMOTE_ACTIONS as readonly string[]).includes(a.action)) return { status: 'failed', code: 'not_allowed', action: a.action };
      if (a.camera !== null && !d.cameraIds().includes(a.camera)) return { status: 'failed', code: 'unknown_camera', action: a.action };
      if (a.camera !== null && d.actions.cameras.get(a.camera)?.phase() === 'restarting') return { status: 'failed', code: 'camera_restarting', action: a.action };
      if (a.camera === null && a.action !== 'retention-run') return { status: 'failed', code: 'invalid', action: a.action };
      const body = a.action === 'retention-run' ? { dryRun: true } : a.action === 'inventory' ? { ...(a.input ?? {}) } : {};
      const o = await performAction(d.actions, a.action, a.camera, body, who(cmd));
      const ok = o.status < 400;
      const json = 'json' in o ? o.json : null;
      const text = JSON.stringify(scrub(json) ?? null);
      const answer = text.length > 16_384 ? null : (JSON.parse(text) as Record<string, unknown> | null);
      const check = ok && CAMERA_WRITES.has(a.action) ? verifyOf(a.action, json, d) : {};
      return {
        status: ok ? 'ok' : 'failed', ...(ok ? {} : { code: 'error' in o ? o.error : 'internal' }), action: a.action,
        result: { action: a.action, camera: a.camera, httpStatus: o.status, answer, ...(answer === null && text !== 'null' ? { clamped: true } : {}), ...check },
        changed: ok && CAMERA_WRITES.has(a.action) ? [`camera:${a.camera}:${a.action}`] : [],
      };
    },
    'camera.name.set': async (args) => {
      const a = args as CameraNameArgs;
      if (!d.cameraIds().includes(a.camera)) return { status: 'failed', code: 'unknown_camera' };
      try {
        const name = await d.cameraName.write(a.camera, a.name);
        return { status: 'ok', result: { camera: a.camera, requested: a.name, name, verified: name === a.name }, changed: [`camera:${a.camera}:name`] };
      } catch (err) {
        return { status: 'failed', code: err instanceof CameraNameRefused ? 'invalid_name' : err instanceof CameraError && err.code === 'camera_offline' ? 'camera_offline' : 'camera_error' };
      }
    },
    'proxy.restart': () => {
      const restartAt = (d.now ?? Date.now)() + 1000;
      return { status: 'ok', result: { restartAt }, after: () => d.restartProcess() };
    },
  };
}
```

`camera.name.set` writes the same `camera-name` audit record the route writes (`user: 'cams-admin'`, `details.cmdId`, `details.actor`): factor the route's record into `cameraNameRecord(audit, base, from, read, to, outcome)` in `control-api.ts` and call it from both. `verifyFtp` compares the re-read (redacted) object against the intended target: setup → `enable === 1`, `server`, `port`, `onlyFtps`, `streamType`, and `uploadOn` ⊇ `['MD','AI_PEOPLE','AI_VEHICLE','AI_DOG_CAT']`; off → `enable === 0`. `verifyNtp`: `set`/`already` → verified; `failed` → `mismatch: ['server']`; `unsupported` → `verified: false, mismatch: []`. `verifyPush`: `outcome` `pushed`/`current` and `served === leaf.fingerprint`. The projection of `camera-cert-push` already happened in `performAction` (Task 7).
- [ ] **Step 4: Run** `npx vitest run test/fleet-camera-commands.test.ts test/fleet-commands.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/fleet/camera-commands.ts src/fleet/commands.ts src/api/control-api.ts test/fleet-camera-commands.test.ts test/fleet-commands.test.ts
git commit -m "feat(fleet): camera.action, camera.name.set, proxy.restart through the existing camera functions (verified, scrubbed)"
```

---

### Task 9: Wiring, `IMPLEMENTED`, early heartbeat on a local edit

**Files:**
- Modify: `src/proxy.ts`, `src/fleet/policy.ts` (`IMPLEMENTED`, `ENTRY_TEXT`), `test/fleet-commands.test.ts`, `test/fleet-heartbeat.test.ts`, `test/fleet-client.test.ts`

**Interfaces:**
- Produces: `IMPLEMENTED` = P2's plus `config.get`, `config.set`, `config.unset`, `config.rollback`, `camera.action`, `camera.name.set`, `proxy.restart`, and every `camera.action:<a>` entry (the heartbeat's `allow` reports allowed ∩ implemented). `ENTRY_TEXT` without "(not in this version)":
  - `config.get`: "cams-admin may read this proxy's settings (values and sources; no secrets)"
  - `config.set`: "cams-admin may change the settings marked remote-settable (never addresses, ports, files, trust, users or cams-admin itself); local edits win"
  - `config.unset`: "cams-admin may reset those settings to config.json's value or the default"
  - `config.rollback`: "cams-admin may undo its own setting changes"
  - `camera.name.set`: "cams-admin may rename a camera (the camera's own name)"
  - `proxy.restart`: "DISRUPTIVE: cams-admin may restart this proxy (at most 2 an hour)"
  - `camera.action:<a>`: "cams-admin may run <a> on a camera" — for the disruptive ones prefixed "DISRUPTIVE: " and naming the effect (`camera-reboot` "reboots the camera (recording stops for about a minute)", `camera-powercycle` "cuts the camera's PoE power", `camera-ftp-setup`/`camera-ftp-off` "rewrites the camera's FTP upload settings", `camera-ntp-set` "rewrites the camera's NTP settings", `camera-cert-push` "replaces the camera's HTTPS certificate", `restart` "restarts a camera's worker (stills and events pause)").
- `CommandRunner` gets `handlers: { 'tokens.apply': …, ...configHandlers(…), ...cameraHandlers(…) }` and `journalBudget` in its check context (`journalBudgetOf(journal.countSince.bind(journal), conn.serverNow())` — the budget is on the journal's `at`, which is the proxy's clock; use `this.now()` there, not cams-admin's clock).
- `changeKey`: `` `${…today's…}|${configRevision(loaded)}` ``.

- [ ] **Step 1: Failing tests:** `test/fleet-commands.test.ts`: a signed `config.set` (allowed) through the runner changes the setting live and writes `admin-command` **and** `config-change`; with an empty allow-list every P3 fixture command is `not_allowed`; the heartbeat `allow` lists a P3 entry once allowed; `test/fleet-client.test.ts`: a local `applyOverrides` changes `changeKey` (early heartbeat within the 10 s floor); `test/fleet-contract.test.ts`: no fixture is `pending` any more with the real `IMPLEMENTED`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** in `proxy.ts` next to the P2 wiring:

```ts
  const backups = new OverridesBackups(join(loaded.config.server.dataDir, 'admin'));
  const handlers = {
    ...configHandlers({ loaded: () => loaded, setLoaded, backups, audit, running: () => running }),
    ...cameraHandlers({ actions: actionDeps, cameraIds: () => cameraIds(running), cameraName, restartProcess: () => controlDeps.restartProcess() }),
  };
```

(`actionDeps` is the object the control API already receives, built once and passed to both; `configHandlers` also takes `running` for `compactView`.) The runner's default `tokens.apply` handler stays and is merged with these.
- [ ] **Step 4: Run** `npx vitest run test/fleet-commands.test.ts test/fleet-client.test.ts test/fleet-heartbeat.test.ts test/fleet-contract.test.ts test/pi-compat.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/proxy.ts src/fleet/policy.ts test/fleet-commands.test.ts test/fleet-client.test.ts test/fleet-heartbeat.test.ts test/fleet-contract.test.ts
git commit -m "feat(fleet): run the P3 commands; a local settings edit sends an early heartbeat"
```

---

### Task 10: Visible on the proxy — changes list, Undo, CLI, Settings marker, card

**Files:**
- Modify: `src/api/cams-admin-api.ts`, `src/api/control-api.ts` (`configView` `by`), `src/fleet/cli.ts`, `src/cli.ts` (usage), `web/src/lib/cams-admin.ts`, `web/src/components/CamsAdminCommands.svelte`, `web/src/lib/settings.ts` and the Settings page row component, `test/fleet-control.test.ts`, `test/fleet-cli.test.ts`, `test/cams-admin-ui.test.ts`, `e2e/` (one spec, see Step 1)

**Interfaces:**
- Produces:
  - `GET /control/admin/changes` → `{ items: { cmdId, command, actor, at, paths: { path, from?, to? }[], rolledBack: Backup['rolledBack'] | null }[] }` (from `backups.list()`, values from `before`/`after`).
  - `POST /control/admin/changes/:cmdId/undo` → 200 `{ changes }` | 404 `no_backup` | 409 `conflict` `{ paths }` | 409 `already_rolled_back`. Admin access (a managed admin token is refused for writes by `managedMay`, which is right: Undo is the local person's).
  - `GET /control/admin/commands` gains `groups: { read: string[]; settings: string[]; camera: string[]; disruptive: string[] }` (allow entries by kind).
  - `GET /control/config` entries gain `by?: { cmdId, actor, at }`.
  - CLI: `cam-proxy admin-commands changes` (table: time, cmdId, actor, paths), `cam-proxy admin-commands undo <cmdId>` (through the running proxy's control API with the local admin token, as the P2 commands do; refused with a message when the proxy is not running).
- [ ] **Step 1: Failing tests:** control routes (list after a `config.set` through the runner; undo restores; undo after a local edit of the same path → 409 naming it; a managed admin token gets 403 on undo); CLI (`changes` prints the cmdId and paths, never a value of a path whose name looks secret — none exist, the test pins it); UI unit (`cams-admin-ui.test.ts`): the disruptive group renders with its warning and every box unchecked by default; a Playwright test (`e2e/cams-admin-p3.spec.ts`, the existing e2e harness with a fake cams-admin from `test/helpers/` that sends one `config.set`): the Settings page shows "set by cams-admin (on behalf of admin@example.org)" on `sse.pingS`, the card's change list shows it, **Undo** restores the default.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (Svelte 5 runes; the card's existing list style; the disruptive group under a heading "Disruptive — off by default" with each entry's sentence; Undo uses the existing `ConfirmDialog.svelte` naming the paths). **Step 4: Run** `npx vitest run test/fleet-control.test.ts test/fleet-cli.test.ts test/cams-admin-ui.test.ts && npm run check && npm run test:e2e -- e2e/cams-admin-p3.spec.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/api/cams-admin-api.ts src/api/control-api.ts src/fleet/cli.ts src/cli.ts web/src test/fleet-control.test.ts test/fleet-cli.test.ts test/cams-admin-ui.test.ts e2e/cams-admin-p3.spec.ts
git commit -m "feat(ui): cams-admin changes with Undo, grouped command entries, settings marked as set by cams-admin"
```

---

### Task 11: Hostile cams-admin (P3), camera round trip against cam-sim, Pi compatibility

**Files:**
- Modify: `test/fleet-isolation.test.ts`, `test/pi-compat.test.ts`
- Create: `test/fleet-p3-roundtrip.test.ts`

- [ ] **Step 1: Write the tests.**
  - `fleet-isolation.test.ts` (the P1/P2 suite with the fake cams-admin) gains a P3 block, **every allow entry allowed**: (a) `config.set` of every `DENIED` prefix's first leaf and of `cameras.<new id>.host` → `failed`, `overrides.json` byte-identical, one `admin-command` failure record each; (b) 50 `config.set` in a minute → at most 6 run, the rest `rate_limited`; (c) `proxy.restart` three times in an hour, with a simulated process restart (a new runner on the same journal file) between them → the third `rate_limited` (R3-9) and `restartProcess` called twice; (d) seven `camera.action camera-reboot` across two runners in an hour → the seventh `rate_limited`; (e) Google Vision `monthlyLimit` raised and `retention.auditDays` lowered → `widening_local_only`, nothing written; (f) `camera.action` with every `NEVER_REMOTE_ACTIONS` name → `not_allowed`, the never-remote functions' spies (`findCamera`, `writeEnvKey`, `tls.rotate`, `tls.clearTrust`, `tls.dropPrevious`, `archive.clear`, `inventory.repair`, `poeSwitch.poeOn`, `restartProcess`) never called; (g) stills, events, FTP intake and the client API keep answering within their usual time during (b) (the P2 flood check, extended).
  - `fleet-p3-roundtrip.test.ts` (in-process cam-sim, the proxy started as the e2e harness does, the fake cams-admin connected): allow `config.get`, `config.set`, `config.rollback`, `camera.name.set`, `camera.action:camera-ntp-set` **in the test's own temp policy file**; `config.get` → `set` dry run → apply (`sse.pingS`) → the live SSE ping interval changed → rollback → the default again, and both `config-change` records present; `camera.name.set` → cam-sim's `GetDevName` returns the new name, `verified: true`, then set back; with `ntp.server` set locally to `192.0.2.123`, `camera-ntp-set` → cam-sim's `GetNtp` server is `192.0.2.123`, `verified: true`.
  - `pi-compat.test.ts`: the Pi config (no `camsAdmin.url`) loads, `GET /control/config` has no `by`, `data/admin/` holds no `overrides.bak-*` after a start and a local settings change.
- [ ] **Step 2: Run** `npx vitest run test/fleet-isolation.test.ts test/fleet-p3-roundtrip.test.ts test/pi-compat.test.ts` → PASS (fix the code, not the test, on a failure).
- [ ] **Step 3: Commit**

```bash
git add test/fleet-isolation.test.ts test/fleet-p3-roundtrip.test.ts test/pi-compat.test.ts
git commit -m "test(fleet): hostile P3 commands, budgets across restarts, camera round trip against cam-sim, Pi unchanged"
```

---

### Task 12: Docs, CHANGELOG, final checks

**Files:**
- Modify: `docs/cams-admin.md`, `CHANGELOG.md` (`## Unreleased`), `CLAUDE.md`, `README.md` (one line), `deploy/cluster/REQUEST.md` (one line: "P3 needs no cluster change")
- Test: whole suite

- [ ] **Step 1:** `docs/cams-admin.md`: "Remote configuration (P3)" — the commands; the remote-settable and denied lists (link to `src/fleet/remote-settable.ts`); narrow-only paths and why; dry run, conflict, rollback, Undo; the disruptive entries and their budgets; "cams-admin compromised" runbook extended (pause on the card or `CAMPROXY_ADMIN_COMMANDS=off`; review `GET /control/admin/changes`; Undo each change; block the managed tokens); cut-over steps 3–4 for this proxy (allow `config.get` only and compare; then `config.set` + `config.rollback`, one harmless change `sse.pingS` and its rollback from cams-admin; disruptive entries only when Klaus asks for them on that proxy). `CHANGELOG.md`: user-visible changes plus **Security: "Push now" no longer returns the camera certificate's private key**. `CLAUDE.md`: the `data/admin/` rule names `overrides.bak-*.json`; "P3: settings commands only on `src/fleet/remote-settable.ts`'s list; a new setting is denied until classified (remote needs the cams-admin contract first)".
- [ ] **Step 2:** Add to `test/fleet-contract.test.ts`: `it('no vendored command fixture is pending (P3 implemented)', …)` with the real `IMPLEMENTED`.
- [ ] **Step 3:** `npm test && npm run build && npm run lint:types && npm run check && npm run schema && git diff --exit-code config.schema.json && scripts/contract-drift.sh && npm run test:e2e && npm run test:e2e:multi && npm audit --audit-level=high` → all green (`config.schema.json` unchanged: P3 adds no setting).
- [ ] **Step 4: Commit**

```bash
git add docs/cams-admin.md CHANGELOG.md CLAUDE.md README.md deploy/cluster/REQUEST.md test/fleet-contract.test.ts
git commit -m "docs: remote configuration (P3), runbook, Push now security fix"
```

**→ PR B ends here** ("Migration P3 (cam-proxy): remote configuration").

---

## Release and rollout order (both repos)

Each step is its own PR to `main`; merge only when every check passes; every step leaves the Pi and the cluster proxy working.

1. **cams-admin PR A — P3 contract** (cams-admin plan Tasks 1–2). cam-proxy's `contract-drift` fails on cam-proxy PRs until step 2: do it the same day. The cams-admin cross-check reports the P3 fixtures `pending` until step 4.
2. **cam-proxy PR A — vendor** (this plan, Task 1). No behaviour change; no release.
3. **cams-admin PR B — remote configuration** (cams-admin plan Tasks 3–7, 9). Release cams-admin. Safe: a P2 proxy doesn't implement P3, reports no P3 entry in `allow`, and cams-admin greys everything out.
4. **cam-proxy PR B** (this plan, Tasks 2–12). Release cam-proxy: the cluster proxy updates through the release workflow; **the Pi** is updated by the release owner (pull + `docker compose up -d`; not by a session told not to touch the Pi). Both proxies still allow nothing new → nothing changes until step 6. The cams-admin cross-check now runs every P3 fixture against cam-proxy `main` (no `pending`).
5. **cams-admin PR C — local stack** (cams-admin plan Task 8): real `admin-enroll`, the two-proxy P3 check against cam-proxy `main`, on the Mac.
6. **Cut-over steps 3–4** (M §11.4), with Klaus, one proxy at a time (cluster first, then the Pi): on the proxy's own card with its **local** admin token allow `config.get` only; compare cams-admin's Settings tab with the proxy's Settings page; then allow `config.set` + `config.rollback` (+ `config.unset`), change `sse.pingS` from cams-admin (dry run, apply), see it in both audit logs, roll it back. **Disruptive entries stay off** on both proxies until Klaus allows one locally. Rollback at any step: pause on the card, or clear the entries. **P3 done** (M §15) when both proxies passed step 4 and one camera action showed a re-read result in cams-admin.

## kube-setup

No change. P3 rides the existing in-cluster channel; `data/admin/overrides.bak-*.json` lives on the existing PVC; no new port, host, egress, env variable, Secret or volume. (`deploy/cluster/REQUEST.md` gets one line saying so.)

## Self-review

- **Spec coverage:** M §7.6 P3 commands (Tasks 4, 6, 8, 9); §7.8 limits (Task 4, R3-9, R3-11); §7.9 double audit (Tasks 6, 8, 9); §8.1 reading + early report (Tasks 6, 9, R3-12); §8.2 remote-settable list, deny list, `held_by_env`, no camera added (Tasks 2, 6); §8.3 no new camera write, re-read results (Tasks 7, 8); §8.4 dry run, diff, conflict (Task 6, R3-4); §8.5 backups, path-level rollback, card Undo, Settings reset unchanged (Tasks 5, 6, 10); §8.6 remote and never-remote actions as separate entries, off by default (Tasks 4, 8, 9, Klaus's decision 3); §12.2 (all files); §13.1 compromised cams-admin bounded (Tasks 2, 4, 11, R3-2, R3-9); §14.1 classification walk, conflict, `held_by_env`, rollback, journal duplicate, hostile suite (Tasks 2, 6, 8, 11); §14.2 contract (Tasks 1, 4, 12); §14.3 two-proxy stack (cams-admin plan); §15 P3 done (rollout step 6).
- **Placeholder scan:** test bodies left as one-line `it(...)` names in Tasks 4, 6, 8 state the exact assertion in their name and follow the fully written neighbours' pattern; every code step has the code.
- **Type consistency:** `planOverrides/planUnset/writeOverridesFile/rebuildWith`, `configChanges/overrideState`, `classify/narrowingOk/settableView/patternOf`, `OverridesBackups.save/get/list/markRolledBack/byPath`, `performAction/ActionWho/ActionOutcome/projectPush`, `configHandlers/cameraHandlers/undoLocal/compactView`, `Done.after/action`, `journalBudgetOf`, `Journal.countSince` are used with the same names in Tasks 3–11.
