# Camera move — cam-proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A proxy can hand one of its cameras to another proxy of the same account on the LAN (source side) and take one over (target side): settings, password, certificate, capture, then the old content, newest first within a time budget, resumable, audited.

**Architecture:** cams-admin orchestrates with short `move.*` commands; the proxy reports with signed `move.*` events (cams-admin plan Task 1 contract). The source serves the camera's content and a sealed password on `/api/moves/<moveId>/…`, guarded by a per-move bearer token bound to the target's address. The target adds the camera live through `overrides.json` (no restart), pulls the files with a rate-limited, checksummed, resumable copier and imports the catalog rows with remapped ids. The source hides the camera with a per-camera `moved` override until cleanup purges its content.

**Tech Stack:** TypeScript (Node ≥ 26, CommonJS), Express 5, `node:sqlite` catalog, Node `crypto` (X25519, HKDF, AES-256-GCM, SHA-256), Svelte 5, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-21-camera-move-design.md` (cited **S §n**). Contract: cams-admin plan `docs/superpowers/plans/2026-10-21-camera-move-cams-admin.md` Task 1 (cited **C**). Fact sheet of the code: see "Code facts" below.

**Prerequisite:** cams-admin plan Task 1 merged (contract v1 with `move.*`).

## Global Constraints

- Never print, log, audit or serve a camera password, the move token, a sealed blob or an X25519 private key. `data/admin/*` and `data/tls/*.key` are never read by hand, copied or logged.
- Audit detail keys must not end in `key` or contain `token|password|secret` unless meant to be redacted (the redactor matches names): use `publicKeyFingerprint`, never `publicKey`.
- Every new audit action literal goes into `src/audit/actions.ts` AUDIT_ACTIONS, `web/src/lib/audit.ts` ACTIONS and a row in `docs/audit-log.md` (test/audit-actions.test.ts).
- Every new Express route goes into `openapi.yaml` (test/openapi.test.ts).
- New admin files are added to `ADMIN_FILES` (and `moves/` gets its own sweep) in `src/fleet/private-file.ts`.
- A new setting is classified in `src/fleet/remote-settable.ts` (deny wins) and `UI_CONFIG_LOCAL` (src/api/auth.ts:149).
- The Pi path is untouched: no `tls.site` → every move refuses with `no_site_ca`; `test/pi-compat.test.ts` stays green.
- Content travels in clear on the LAN (S §8.1, Klaus); the password only sealed (S §9.3).
- Real camera only with Klaus's OK, after the livestack passes.
- CHANGELOG.md: lines under `## Unreleased`.

## Code facts that change the spec's "how" (rulings)

- **P1 — No restart.** Cameras added through `overrides.json` start live (`applyOverrides` → `setLoaded` → `reconcile()`, src/proxy.ts:1033; test/cameras-add-remove.test.ts). The target adds the camera that way. S §9.1 allowed restarts; none are needed. — Cost if wrong: none; a restart path would only be slower.
- **P2 — Hiding a config.json camera.** The proxy never writes config.json and `removeOverride` refuses config.json cameras. New per-camera setting `cameras.<id>.moved: string|null` (a moveId); `reconcile()` treats a camera with `moved` set like a removed one (worker stopped, go2rtc stream removed, not listed by the APIs, FTP user refused) while its config and content stay. Cancel clears it; cleanup keeps it (the config.json entry stays hidden; Settings shows "Moved to <target> by <moveId>; you can delete it from config.json"). For an overrides-added camera, cleanup removes the camera override instead. — Cost: one leftover config.json entry per moved camera until the admin deletes it.
- **P3 — Passwords.** The proxy holds one camera password per camera (the proxy user's). Only that password moves. New file `data/admin/camera-passwords.json` (`{v:1, cameras:{<id>:{password}}}`, mode 600) read by `loadSecrets` after the environment (env wins, S §9.3). FTP uses the target's own FTP user and password. — Cost: none for a source on the shared default password (the value is sent per camera).
- **P4 — Retention is host-wide.** `retention.*`, `stills.maxGB`, `previews.maxGB`, `ftp.maxGB`, `storage.*` are host settings. The camera's per-camera node moves (S §7 "keeps its settings" applies to these); the space option "change limits on the target" proposes host-wide `stills.maxGB`/`previews.maxGB`/`ftp.maxGB` raises that the disk can hold. The panel says "on <target>".
- **P5 — Checksums per chunk on demand.** No file hashes exist. The source hashes a chunk's files when the target first asks for that chunk's manifest (one camera day of one kind) and caches the result in the move journal. The manifest frozen at approval lists chunks with sizes; hashes follow per chunk. — Cost: a file changed between listing and hashing is hashed as it is then (only retention deletes files; a deleted file is `skipped (expired)`).
- **P6 — Chunks.** Kinds and their chunk content: `stills` = stills packs + previews (sprite + sidecar) of one UTC day; `clips` = clip files + snapshot JPEGs + `clips` rows; `events` = `events` rows + `analyses` rows + analysis images; `checks` = `still_checks` rows + images; `archive` = archive folders + rows by `created_at` day. Not moved: `stream_log`, `analytics_usage`, `clip_arrivals` (rebuilt), recordings cache. Chunk id `<kind>:<YYYY-MM-DD>` (C).
- **P7 — `camera_limit`.** No such setting exists. New host setting `moves.maxCameras: number|null` (default null = no limit; local only).
- **P8 — Cert guard.** New `Extra.expected: string|null` (a leaf fingerprint) in src/tls/camera-certs.ts, persisted in state.json: a served cert equal to `expected` is not "unexpected"; and the camera's TLS trust (`setTrust`, src/proxy.ts:306) accepts it. Set on the source by `move.go` (target's leaf); cleared at `done`/`cancelled`. On cancel the target gets no expected leaf: it drops the camera before the source pushes its own leaf back (ruling B36).
- **P9 — Starting a move from a cams-admin sign-in.** The move routes are allowed to managed sessions when the local allow list has `move.send` (new `UI_UNLOCKS` entry keyed on `move.send`). S §4, Klaus: a one-time link is enough.
- **P11 — Chunk order within a day:** `clips, events, checks, archive, stills` (small and most-opened first); days newest first (S §8.2).
- **P12 — The target starts copying right after `switched`;** it does not wait for the source's `released`. The source keeps serving its endpoints in `released`, and anything it captured during the overlap is in the switch-over day's chunks, which the source re-lists at `released` (Task 5 manifest refresh) and the target fetches last. — Cost: a few minutes of overlap stills may arrive twice; `importRows` skips duplicates by `(cam, ts)` for stills and by `path` for clips.
- **P10 — Source-side refusals before any event:** `no_site_ca` (no `tls.site`), `external_cert` (camera has `tlsName`, i.e. mode public), `moves_not_allowed` (no `move.send`).

## Review Focus

1. The source restarts while serving a file to the target: the target's partial file is discarded (temp name), retried, verified — Task 9 `source restart mid-file`.
2. A file listed in a chunk was deleted by the source's retention before it was copied: chunk ends `verified` with that file counted `skipped (expired)`, no error loop — Task 9 `expired file is skipped`.
3. The target's disk reaches `storage.minFreeBytes` during the copy (storage paused): copying pauses, does not fail files, resumes when space returns — Task 9 `pauses while storage is paused`.
4. A camera with the same id exists on the target only as a hidden `moved` leftover from an earlier move away: the offer treats it as `id_taken` unless the leftover belongs to a finished move of this same camera — Task 6 `leftover moved entry`.
5. The move token is presented from another address, or after `done`: 403, audited once per 10 min — Task 5 `token from another address`.

---

### Task 1: Contract, allow entries, move commands skeleton, event emission

**Files:**
- Copy: cams-admin `contract/v1` → `test/contract/cams-admin-v1/` (scripts/contract-drift.sh; update `SOURCE`)
- Modify: `src/fleet/policy.ts` (ALLOW_ENTRIES + `move.send`, `move.receive`; ENTRY_TEXT; `entryFor(command, args): string` mapping per C/R3; IMPLEMENTED gets the nine commands), `src/fleet/command-check.ts` (allow check uses `entryFor`; `CommandLimits` window `move.*` 60/min), `src/fleet/command-args.ts` (validators for the nine args), `src/fleet/client.ts` + `src/fleet/service.ts` (`emitEvent(body: MoveEvent): void`: signed `event` without cmdId; buffered up to 256 while offline, oldest dropped with a log line; flushed after `welcome`), `src/api/cams-admin-api.ts` (GROUPS `moves`), `web/src/components/CamsAdminCommands.svelte`, `web/src/lib/cams-admin.ts`
- Create: `src/moves/types.ts` (MoveEvent, MovePlan, MoveSummary, Space, Settings types matching C), `src/moves/commands.ts` (`moveHandlers(deps: MoveDeps): Record<string, Handler>` — each handler a stub answering `failed/internal` until its task)
- Test: `test/fleet-move-contract.test.ts`; update the enumerating tests listed in Code facts (fleet-control.test.ts:162, fleet-config.test.ts:61, managed-ui-unlock, pi-compat, fleet-isolation)

**Interfaces:**
- Produces: `entryFor`; `CamsAdmin.emitEvent(body)`; `MoveDeps` (filled in later tasks: `journal`, `catalog`, `storage`, `certs`, `config`, `secrets`, `audit`, `emit`); handler names exactly the C command names; card group label `Camera moves` with ENTRY_TEXT `move.send`: "cams-admin may move a camera from this proxy to another proxy of the account, after you approve the move here or in a cams-admin sign-in"; `move.receive`: "cams-admin may hand this proxy a camera from another proxy of the account: it adds the camera, its password and certificate, and copies its content".
- [ ] **Step 1: Failing tests:** `every move fixture validates against IMPLEMENTED` (no pending fixtures); `move.offer without move.receive is refused not_allowed`; `move.cancel role source needs move.send`; `emitEvent while offline is sent after welcome, in order`; `emitEvent buffer keeps the newest 256`.
- [ ] **Step 2: Run** `npx vitest run test/fleet-move-contract.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run lint:types` — PASS.
- [ ] **Step 5: Commit** `feat(fleet): move commands, allow entries and proxy events`.

### Task 2: Move journal and camera password store

**Files:**
- Create: `src/moves/journal.ts`, `src/config/camera-passwords.ts`
- Modify: `src/config/secrets.ts` (`loadSecrets` reads the store after env), `src/fleet/private-file.ts` (ADMIN_FILES + `camera-passwords.json`; `tightenAdminFiles` also sweeps `moves/*.json`)
- Test: `test/move-journal.test.ts`, `test/camera-passwords.test.ts`

**Interfaces:**
- Produces:
  - `class MoveJournal { constructor(dir: string /* <dataDir>/admin/moves */); load(id): MoveRecord|null; save(r: MoveRecord): void; active(): MoveRecord[]; remove(id): void }` — `writePrivateJson`/`readPrivateJson`; a corrupt file is renamed `.bad-<ts>` and reported as a problem.
  - `MoveRecord = {v:1, id, role:'source'|'target', camera, phase, plan|null, peer:{proxyId, name, url?, caFingerprints?, ip?}, tokenHash?|token?, x25519?: {privatePkcs8: string, publicSpki: string} /* target only */, expectedLeaf?, manifest?: ChunkMeta[], chunks: Record<chunkId, {state, files?: Record<path,{size, sha256, state}>}>, bytesDone, startedAt, approvedAt?, budgetS?, budgetExceeded?:boolean, copied?:'delete'|'age-out'}`.
  - `cameraPasswordStore(dir)`: `get(id): string|undefined`, `set(id, pw): void`, `delete(id): void`.
  - `loadSecrets`: `cameraPasswords[id]` = env (`CAMPROXY_CAMERA_PASSWORD_<ID>`/`_FILE`) else store else default.
- [ ] **Step 1: Failing tests:** `journal round-trips and lists active`; `journal file is 600 and a 644 file is tightened`; `corrupt journal is set aside, not thrown`; `store password is used when no env var`; `env var wins over the store`; `a live-added camera with a stored password starts without CAMPROXY_CAMERA_PASSWORD` (extends test/cameras-add-remove.test.ts pattern).
- [ ] **Step 2–4:** run (FAIL) → implement → `npm test` PASS.
- [ ] **Step 5: Commit** `feat(moves): move journal and stored camera passwords`.

### Task 3: Per-camera `moved` state and purge

**Files:**
- Modify: `src/config/schema.ts` (CAMERA_NODE `moved`, host `moves.maxCameras`), `src/fleet/remote-settable.ts` (both NEVER_FROM_CAMS_ADMIN), `src/api/auth.ts` UI_CONFIG_LOCAL, `src/proxy.ts` `reconcile()` (:1033) and `restartCameraSide` (:1068) skip `moved` cameras, `src/clips/side.ts` (FTP user of a moved camera refused), `src/api/*` camera lists (`cameraIds` filter), `npm run schema`
- Create: `src/moves/purge.ts`
- Test: `test/move-hidden-camera.test.ts`, `test/move-purge.test.ts`

**Interfaces:**
- Produces:
  - `activeCameraIds(c: Config): string[]` (cameras without `moved`) — used wherever `cameraIds` feeds workers, APIs, FTP.
  - `purgeCamera(deps: {catalog, dataDir, storage, archive}, cam: string): {deleted: Record<Kind, {files:number, bytes:number}>}` — catalog deletes `WHERE cam = ?` for events (cascade analyses), clips, still_checks, archive, stream_log, analytics_usage, clip_arrivals in one transaction; then removes `stills|previews|clips|recordings|analytics|still-checks|archive/<cam>` folders; then `storage.recount()`. Idempotent.
- [ ] **Step 1: Failing tests:** `setting moved stops the worker live and hides the camera from /api/cameras`; `clearing moved starts it again`; `restartCameraSide does not start a moved camera`; `FTP login of a moved camera's user is refused`; `purge removes every row and folder of the camera and nothing of another camera` (two-camera fixture with rows in every table); `purge twice is a no-op`; `moved and moves.maxCameras are refused from cams-admin (not_remote_settable)`.
- [ ] **Step 2–4:** run (FAIL) → implement → `npm test` PASS.
- [ ] **Step 5: Commit** `feat(moves): hidden moved cameras and per-camera purge`.

### Task 4: Inventory, chunks and manifests

**Files:**
- Create: `src/moves/inventory.ts`
- Test: `test/move-inventory.test.ts`

**Interfaces:**
- Produces:
  - `summarize(deps, cam): MoveSummary` — per kind `{files, bytes, rows, oldest, newest}` from catalog + Storage units.
  - `listChunks(deps, cam, kinds: Kind[]): ChunkMeta[]` — `{id, kind, day, files, bytes, rows}`, sorted newest day first, then kind order `clips, events, checks, archive, stills` (small/most-used first within a day — Ruling P11).
  - `chunkManifest(deps, cam, chunkId): {files: {path /* relative to dataDir, posix */, size, sha256}[], rows: number}` — hashes streamed with `createHash('sha256')`; paths validated to stay under the camera's folders.
  - `chunkRows(deps, cam, chunkId): {table: string, rows: object[]}[]` — rows in insert order (events before analyses).
- [ ] **Step 1: Failing tests:** `summary counts per kind match the fixture`; `chunks are newest day first`; `manifest hashes match sha256 of the files`; `manifest never lists a path outside the camera's folders`; `rows of an events chunk include its analyses after the events`.
- [ ] **Step 2–4:** run (FAIL) → implement → `npm test` PASS.
- [ ] **Step 5: Commit** `feat(moves): inventory, chunks and manifests`.

### Task 5: Source endpoints and the move-token guard

**Files:**
- Create: `src/api/moves-api.ts` (`movesSourceApi(deps): express.Router` mounted at `/api/moves` BEFORE `app.use('/api', requireAccess('client'…))` in src/proxy.ts), `src/moves/token-guard.ts`, `src/moves/seal.ts`
- Modify: `src/proxy.ts`, `openapi.yaml`
- Test: `test/move-source-api.test.ts`, `test/move-seal.test.ts`

**Interfaces:**
- Produces (all need `Authorization: Bearer <move token>`; guard: sha256 matches the source journal's `tokenHash` via `tokenMatches`, `clientIp(req)` equals `peer.ip`, move phase not ended; else 403 `move_token` and audit `move-token-refused` throttled per move per 10 min):
  - `GET /api/moves/:id/probe?bytes=N` → N random bytes (N ≤ 67108864).
  - `GET /api/moves/:id/manifest` → `{chunks: ChunkMeta[]}` (frozen at `move.go`; plus a final chunk list refresh at `released`: chunks of the switch-over day are re-listed).
  - `GET /api/moves/:id/chunks/:chunkId` → `chunkManifest`.
  - `GET /api/moves/:id/chunks/:chunkId/rows` → `chunkRows`.
  - `GET /api/moves/:id/file?path=` → the file (Range supported via `sendFileOr`); 404 `expired` when gone.
  - `GET /api/moves/:id/secrets` → `{sealed: base64}`; 409 `not_ready` until `move.go` stored the target key.
  - `seal(publicSpkiB64: string, plaintext: Buffer): string` / `unseal(privatePkcs8B64: string, sealed: string): Buffer` — ephemeral X25519 + HKDF-SHA256 (info `cam-proxy move v1`) + AES-256-GCM; format `v1.<ephemeralSpki>.<iv>.<ciphertext+tag>`.
- [ ] **Step 1: Failing tests:** `seal/unseal round-trip`; `unseal with another key fails`; `tampered ciphertext fails`; `probe streams N bytes`; `token from another address` → 403 and one audit record; `token after done is refused`; `file path outside the camera folder is 400`; `deleted file answers 404 expired`; `secrets before move.go is 409 not_ready`; `no route answers without the token` (also not to the local admin token).
- [ ] **Step 2–4:** run (FAIL) → implement → `npm test` PASS (openapi included).
- [ ] **Step 5: Commit** `feat(moves): source endpoints, token guard and sealed passwords`.

### Task 6: Target evaluation (`move.offer`)

**Files:**
- Create: `src/moves/evaluate.ts`
- Modify: `src/moves/commands.ts` (`move.offer` handler)
- Test: `test/move-offer.test.ts`

**Interfaces:**
- Produces: `evaluate(deps, args: OfferArgs): Promise<{accept:true, space: Space, probeBps: number} | {accept:false, reason}>` — order: `moves_not_allowed` (no `move.receive`; normally already refused by the check), `busy` (journal has an active move), `no_site_ca`, `id_taken` (Review Focus 4), `camera_limit` (`moves.maxCameras`), `incompatible` (`planOverrides` rejects the camera node built from `camera` + `settings`), `ca_does_not_cover_camera` (`!ca.covers(ip) || !ca.coversName(<id>.<site>.internal)`), `camera_unreachable` (TCP connect to the camera's HTTPS port, 3 s); then `space = spaceFor(summary)` (P4: per-kind headroom under `*.maxGB` and disk free above `storage.minFreeBytes`; `retentionProposal` raises `stills.maxGB`/`previews.maxGB`/`ftp.maxGB` only when the disk can hold it, else null); then a probe: GET source `/probe?bytes=67108864` with a 5 s cap, `probeBps = bytes / seconds`. The token from the args is saved in a target journal record (`phase: 'offered'`).
- [ ] **Step 1: Failing tests:** one per reason (fixture proxies via `startProxy`/`startMultiProxy` with sims); `space fits`; `space short lists perKind and a retentionProposal when the disk has room`; `retentionProposal null when the disk is short`; `probe measures a rate > 0`; `leftover moved entry` (Review Focus 4); `a busy target answers busy`.
- [ ] **Step 2–4:** run (FAIL) → implement → `npm test` PASS.
- [ ] **Step 5: Commit** `feat(moves): target evaluation`.

### Task 7: Source side — starting, answering, go, release

**Files:**
- Modify: `src/moves/commands.ts` (`move.targets`, `move.open`, `move.answer`, `move.go`, `move.release` handlers), `src/tls/camera-certs.ts` (P8 `expected`), `src/proxy.ts` (`setTrust` honours `expected`)
- Create: `src/api/moves-control-api.ts` (mounted under `/control`, admin; managed sessions via the `move.send` UI unlock, P9)
- Modify: `src/api/auth.ts` (UI_UNLOCKS entry `move.send`), test/auth-managed-routes.test.ts, `openapi.yaml`
- Test: `test/move-source.test.ts`, `test/move-cert-expected.test.ts`

**Interfaces:**
- Produces (control routes, CSRF for sessions):
  - `POST /control/moves/targets` `{camera}` → emits `move.targets`; 202 `{requestId}`. `GET /control/moves/targets/:requestId` → `{targets|null}` (filled by the `move.targets` command).
  - `POST /control/moves` `{camera, target}` → P10 refusals (409 with `reason`), else emits `move.request` (summary, settings, camera connection fields from config; never a password) → 202 `{requestId}`.
  - `GET /control/moves` → `{items: MoveView[]}`: per move `{id|requestId, camera, target, phase, answer?: {accept, reason?, space?, estimateS?}, settings, summary, progress?: {bytesDone, bytesTotal, rateBps, etaS}, budgetExceeded}`.
  - `POST /control/moves/:id/approve` `{plan}` → validates (`budgetS ≥ estimateS`, `kinds` ⊂ summary kinds, `space` option consistent with `answer.space`) → emits `move.approve`; audit `move-approve`.
  - `POST /control/moves/:id/cancel` `{copied}` → emits `move.cancel`.
  - Handlers: `move.targets` stores the list for the request; `move.open` writes the source journal (`tokenHash`, `peer.ip`) — phase `opened`; `move.answer` stores the answer (journal or the pending request); `move.go` stores `plan`, target key, `expectedLeaf` (sets `Extra.expected`), freezes the manifest — phase `switching`; `move.release` sets `cameras.<id>.moved = moveId` (live), FTP expectation off — emits `move.phase released`.
  - Audit (source): `move-request`, `move-approve`, `move-phase`.
- [ ] **Step 1: Failing tests** (FakeAdmin drives the commands): `request emits move.request with summary and settings and no password`; `request on a proxy without tls.site is refused no_site_ca`; `request for a camera with tlsName is refused external_cert`; `approve with budget below the estimate is 400`; `managed session may start a move only when move.send is allowed`; `go stores the expected leaf and the camera's cert check accepts it` (sim serving the target leaf); `an unrelated cert is still unexpected`; `release hides the camera live and emits released`; `every handler is idempotent (same cmdId twice → duplicate; same moveId new cmdId → same state)`.
- [ ] **Step 2–4:** run (FAIL) → implement → `npm test` PASS.
- [ ] **Step 5: Commit** `feat(moves): source side start, answer, go and release`.

### Task 8: Target side — start and switch-over

**Files:**
- Create: `src/moves/target.ts` (`class MoveTarget`: the background runner per active target move)
- Modify: `src/moves/commands.ts` (`move.start`), `src/proxy.ts` (construct and resume `MoveTarget` from the journal at start)
- Test: `test/move-switch.test.ts`

**Interfaces:**
- Produces:
  - `move.start` handler: generates the X25519 pair (journal), issues the leaf for `<id>.<site>.internal` + camera IP (not pushed yet) and stores it, returns `{publicKey, leafFingerprint}` within the command; then `MoveTarget.run(moveId)` in the background.
  - `MoveTarget.run` steps (each idempotent, journal phase after each): `secrets` (GET source `/secrets` with backoff on 409; unseal; `cameraPasswordStore.set`) → `camera` (apply overrides `cameras.<id>` = connection fields + settings (+ `targetSettings` when `plan.space==='retention'`); live start) → `cert` (push the stored leaf) → `ftp` (`setupCameraFtp` to itself, `verifyFtp`) → emit `move.phase switched` → `copying` at once (Task 9, P12).
  - Audit (target): `move-offer`, `move-switch` (one per step with outcome), `move-phase`.
- [ ] **Step 1: Failing tests** (two proxies + one sim + FakeAdmin acting for cams-admin): `start returns a public key and the leaf fingerprint`; `switch-over adds the camera live with the source's settings and password`; `camera serves the target's leaf after the cert step`; `camera FTP points at the target`; `stills of the target start before the source is released` (no gap); `a target restart during switch-over resumes at the failed step`; `move.start resent with the same moveId does not issue a second key or leaf`.
- [ ] **Step 2–4:** run (FAIL) → implement → `npm test` PASS.
- [ ] **Step 5: Commit** `feat(moves): target switch-over`.

### Task 9: The copier

**Files:**
- Create: `src/moves/copier.ts`, `src/moves/rate.ts`, `src/moves/import.ts`
- Modify: `src/moves/target.ts`
- Test: `test/move-copier.test.ts`, `test/move-rate.test.ts`, `test/move-import.test.ts`

**Interfaces:**
- Produces:
  - `rateFor(remainingBytes, remainingS, probeBps, pressure: boolean, budgetOver: boolean, lastRate): number` — `min(probeBps, remainingBytes / max(remainingS, 60))`; after the budget is over: `min(lastRate, probeBps)` (never faster, S §8.3); halved under `pressure` (target storage paused or CPU load average > cores, or the source answering 503).
  - `class Copier { constructor(deps, record: MoveRecord); run(signal): Promise<void> }` — per chunk in manifest order: fetch chunk manifest → per file not `verified`: stream to `<final>.move-<id>.part` through a token-bucket at the current rate, hash while writing, compare size+sha256, rename; 3 failures → file `failed` (audit `move-file-failed` once per chunk, listing up to 50 paths); 404 `expired` → `skipped`; then rows (`importRows`); chunk state; journal save after every file; `move.progress` every 10 % of bytes or 60 s; audit `move-progress` at the same 10 % steps and at least hourly; budget over → audit `move-budget-exceeded` once and `budgetExceeded` in the journal; storage paused → wait (Review Focus 3).
  - `importRows(catalog, cam, rows): {inserted, skipped}` — inserts with new ids, maps `analyses.event_id` through the events' old→new id map (kept in the journal per chunk for resume), skips rows whose files are not `verified`; idempotent per chunk (delete the chunk's previously imported rows by the journal's id list before re-import).
  - End: `move.phase copied` with counts `{verified, skipped, failed, bytes}`.
- [ ] **Step 1: Failing tests:** `rate stays under probe and fits the budget`; `rate never rises after the budget is over`; `pressure halves the rate`; `newest chunk first`; `file hash mismatch retried 3 times then failed`; `source restart mid-file` (Review Focus 1); `expired file is skipped` (Review Focus 2); `pauses while storage is paused` (Review Focus 3); `resume after a target restart skips verified files and re-imports nothing twice`; `analyses keep pointing at their events after import`; `a clip row is not imported when its file failed`; `budget exceeded is audited once`.
- [ ] **Step 2–4:** run (FAIL) → implement → `npm test` PASS.
- [ ] **Step 5: Commit** `feat(moves): rate-limited, verified, resumable copier`.

### Task 10: Finish and cancel

**Files:**
- Modify: `src/moves/commands.ts` (`move.finish`, `move.cancel`), `src/moves/target.ts`
- Test: `test/move-finish-cancel.test.ts`

**Interfaces:**
- Produces:
  - Source `move.finish {abandoned}`: `purgeCamera`; config: overrides-added camera → `removeOverride('cameras.<id>')`; config.json camera → keep `moved` (P2); `cameraPasswordStore.delete`; delete the camera's TLS leaf files and state entry; clear `Extra.expected`; journal phase `finished` then removed; result `{deleted}`; emit `move.phase finished`; audit `move-cleanup`, `move-done`.
  - Target `move.cancel {role:'target', copied}`: stop the copier; remove the camera override (live stop); delete its stored password; `copied==='delete'` → `purgeCamera`; set `Extra.expected` to the source's leaf? (no: the target no longer has the camera) — journal phase `cancelled`; emit `move.phase cancelled`.
  - Source `move.cancel {role:'source', expectedLeaf}`: set `Extra.expected = expectedLeaf` (the target's leaf the camera serves), clear `moved` (camera restarts live), push the source's own leaf (manual push, expected honoured), `setupCameraFtp` back to itself, then clear `expected`; emit `move.phase cancelled`; audit `move-cancel`.
- [ ] **Step 1: Failing tests:** `finish purges content and hides or removes the camera`; `finish keeps the audit files`; `finish twice is a no-op`; `cancel after switch-over gives the camera back to the source with its own leaf and FTP`; `cancel with copied delete purges the target's copy`; `cancel with age-out keeps the target's copy and its retention removes it later` (retention dry run lists it); `cancel before switch-over leaves the source untouched`.
- [ ] **Step 2–4:** run (FAIL) → implement → `npm test` PASS.
- [ ] **Step 5: Commit** `feat(moves): finish and cancel`.

### Task 11: The UI

**Files:**
- Create: `web/src/components/MoveCameraDialog.svelte`, `web/src/components/MovePanel.svelte`, `web/src/components/MoveStatusCard.svelte`, `web/src/lib/moves.ts` (`estimateText(s)`, `budgetDefault(estimateS)`, `spaceOptions(space)`, `planFrom(form)`)
- Modify: `web/src/pages/Settings.svelte` (per-camera "Move to another proxy…" button, hidden without `move.send` or for `moved` cameras; a moved leftover shows "Moved to <target> (<moveId>). You can delete it from config.json."), `web/src/pages/Status.svelte` (MoveStatusCard while a move is active, both roles), `web/src/lib/rights.ts`
- Test: `test/move-ui-lib.test.ts` (imports web/src/lib/moves.ts), `e2e/move.spec.ts` (fake cams-admin answering `move.answer`)
- Copy (exact):
  - Button: `Move to another proxy…`
  - Dialog step 1: title `Move <camera name>`; `Move to` select; `Continue`.
  - Waiting: `Asking <target>…`
  - Rejected: `<target> can't take this camera: <reason text>` with reason texts: `moves_not_allowed` "it doesn't accept camera moves (its local admin can allow them on its Cams-Admin page)", `camera_unreachable` "it can't reach the camera", `camera_limit` "it already has as many cameras as it may", `id_taken` "it already has a camera with this id", `busy` "it is in another move", `incompatible` "it can't use this camera's settings (update it first)", `no_site_ca` "it has no site certificate authority", `ca_does_not_cover_camera` "its site certificate authority doesn't cover <camera address>", `external_cert` "this camera's certificate is managed elsewhere", `target_failed` "it didn't answer", `other_account` "it belongs to another account", `target_offline` "it is offline", `not_routed` "cams can't reach it the way it reaches this proxy (ask for the route in cams-admin first)", `host_overridden` "cams uses a different address for this camera (remove the override in cams-admin first)", `offer_expired` "the offer expired after 30 minutes; start again".
  - Panel: heading `Move <camera> to <target>`; section `Settings that move with the camera`; `Transfer content` Yes/No; content table `Kind | Size | Files | From | To`; when short: `Not everything fits on <target> (<needed> needed, <available> free).` with options `Leave out:` (checkboxes per kind), `Raise the limits on <target>` (shows the proposed values), `Copy as much as fits, newest first`; `Estimated time: <estimate>`; `Time budget` (minutes, min = estimate); note `When the move ends, this proxy deletes all of this camera's content, copied or not. Audit records stay.`; buttons `Approve move`, `Cancel`.
  - Status card: `Moving <camera> to <target>: <phase text>, <done> of <total> (<percent>%), about <eta> left`; `Over the time budget; still copying` when over; button `Cancel move…` (choice "Delete what was copied on <target>" / "Let it age out there").
- [ ] **Step 1: Failing tests:** `budgetDefault rounds the estimate up to whole minutes`; `planFrom refuses a budget below the estimate`; `spaceOptions offers retention only with a proposal`; e2e `move dialog → rejected reason shown`; e2e `move dialog → panel → approve emits move.approve` (data-testids `move-open`, `move-target`, `move-approve`, `move-budget`, `move-status`).
- [ ] **Step 2–4:** run (FAIL) → implement → `npm test`, `npm run check`, `npm run build && npm run test:e2e` PASS.
- [ ] **Step 5: Commit** `feat(web): move a camera to another proxy`.

### Task 12: Docs and the end-to-end test

**Files:**
- Create: `docs/camera-move.md` (operator guide: allow entries, what moves, panel, cancel, end transfer, leftovers in config.json, what the audit shows)
- Modify: `docs/audit-log.md` (rows for `move-request`, `move-offer`, `move-approve`, `move-phase`, `move-switch`, `move-progress`, `move-budget-exceeded`, `move-file-failed`, `move-cancel`, `move-cleanup`, `move-done`, `move-token-refused`), `docs/cams-admin.md` (command table, entries), `CHANGELOG.md`, `README.md` docs list
- Test: `test/move-e2e.test.ts`
- [ ] **Step 1: Failing test** `test/move-e2e.test.ts`: two proxies (both site CA covering one sim), FakeAdmin scripted as cams-admin per the cams-admin plan's sequence: request → open/offer → answer → approve → start/go → switched → release → copy → copied → finish → done; asserts no gap in stills (every minute of the switch-over present on source or target), content count on the target equals the source's before, source purged, every audit action present on the right side, no password/token in any audit file (grep the JSONL for the test password and token).
- [ ] **Step 2: Run** `npx vitest run test/move-e2e.test.ts` — FAIL until Tasks 1–10 are wired, then PASS.
- [ ] **Step 3:** Docs; `npm test && npm run lint:types && npm run check` — PASS.
- [ ] **Step 4: Commit** `docs(moves): operator guide and audit actions; e2e move test`.
