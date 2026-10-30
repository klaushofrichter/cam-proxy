# PTZ positions in moves and move cleanup (cam-proxy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A camera's PTZ positions travel with it when it moves to another proxy (content kind `ptz`), and the proxy it left also deletes its positions and its `CAMPROXY_CAMERA_PASSWORD_<ID>` env-file line, and reports what it can't remove as `moveLeftovers`.

**Architecture:** `ptz` becomes a move kind next to the five file kinds. The source lists it as one chunk without files whose rows (the camera's `ptz_positions` rows) go through the copier's existing rows request; the target replaces that camera's rows with them. The source adds `ptz` to the plan only when the target's offer answer lists it among the kinds it takes (relayed by cams-admin). `MoveSource.finish()` gains the positions delete, the env-file line removal and a small leftovers store, shown in `GET /control/status`, the heartbeat and the Status page.

**Tech Stack:** TypeScript (Node 26, CommonJS), Express 5, node:sqlite, vitest, Svelte 5 admin UI.

**Spec:** `docs/superpowers/specs/2026-10-30-ptz-capabilities-design.md` §7 (on branch `feat/ptz` until plan B merges). This is plan D. It builds on plan B (`docs/superpowers/plans/2026-10-30-ptz-capabilities.md`): **start from `main` after plan B is merged**; the names below (`ptz_positions`, `PtzPositionRow`, `checkName`, `POSITIONS_MAX`, `CameraWorker.ptz`) are plan B's. The cams-admin half is cams-admin's plan `docs/superpowers/plans/2026-10-30-ptz-move-kind.md`.

**Release order:** cams-admin first (its contract takes `ptz`, the offer's `kinds`, the heartbeat's `moveLeftovers`; an older cams-admin refuses a target's offer result that carries `kinds`). Then this plan, which vendors that released contract (Task 8). Then the hosts. The PR that implements this plan must not be released before cams-admin's.

## Global Constraints

- Kinds: `FILE_KINDS = ['stills', 'clips', 'events', 'checks', 'archive']` (unchanged meaning); `MOVE_KINDS = [...FILE_KINDS, 'ptz']`. `summary`, `space.perKind`, `Purged`/`deleted`, purge, the copy back (`RETURN_PLAN`) and the time estimate cover `FILE_KINDS` only; `plan.kinds`, `bounds.kinds`, check counts and chunk ids may name `ptz`.
- `ptz` chunk id: `ptz:<YYYY-MM-DD>`, the UTC day of the newest `updated_at` of the camera's rows; 0 files, 0 bytes, `rows` = row count; no chunk when the camera has no rows. Ordered before every other chunk.
- Rows on the wire: one `TableRows` `{ table: 'ptz_positions', rows }`, each row the `PtzPositionRow` **without `cam`** (`id, name, sort_order, home, slot, preset_name, created_at, updated_at`); no serial (plan B stores none).
- Accepted kinds: the target's offer result and `move.answer` carry optional `kinds: MoveKind[]`; absent means the five file kinds. The hello's `capabilities` gains `'move-ptz'` (cams-admin relays `kinds` only to a source that announces it).
- `ptz` is not a choice: neither the panel nor `bounds` offers it; the source adds it to the approved plan whenever the answer's `kinds` include `ptz` and the camera has rows, also when `transfer` is false.
- Target: the camera's rows are **replaced** (deleted, then the copied ones inserted, one transaction). Invalid rows → the chunk fails (`failed.ptz = 1` in the check), the target's rows stay as they were.
- Leftover items, exact strings: `config.json entry`, `env CAMPROXY_CAMERA_PASSWORD_<ID>`, `env CAMPROXY_CAMERA_PASSWORD_<ID>_FILE` (`<ID>` from `cameraPasswordEnv`). `moveLeftovers: [{camera, moveId, items}]`, `[]` when none; at most 16 entries, 4 items each.
- The env file is changed only through `src/config/env-file.ts` (backup, temp file, rename, 5 backups kept); every other byte stays; values never reach a log, audit record, error or response.
- Public repo: tests and docs use `192.0.2.x`, ids like `cam4`, `pos_0123456789abcdef`; no real addresses, serials or tokens.
- `npm test` and `npm run lint:types` pass at every commit; `npm run check` too when `web/` changes.

## Decisions beyond the spec

- **The "one JSON file" is the chunk's rows document.** The copier already fetches each chunk's rows as JSON (`GET /api/moves/:id/chunks/:chunkId/rows`) and verifies the chunk only with them; a `ptz` chunk is a chunk with no files and the positions as its rows. No snapshot file is written, hashed, landed or cleaned up, and there is still no new message type. (Flag for Klaus: the spec says "one JSON file … through the existing file copier".)
- **Kinds exchange:** the target's `move.offer` accept result gets `kinds`; cams-admin relays it in `move.answer` only to sources announcing `move-ptz` (an older source's closed `move.answer` check would refuse the unknown key). `summary` stays the five file kinds, so an older target never sees `ptz`.
- **Positions travel even without content transfer** (`transfer: false`, plan `kinds: ['ptz']`): they describe the camera's presets, which go with the camera anyway.
- **"The move report says so"**: the source's `move-approve` record says `positions stay behind: the target does not take them (N)` and `details.positions` is `'carried' | 'not_taken' | 'none'`; the panel shows the same line.
- **Copy back:** carries no `ptz` (`RETURN_PLAN` stays the five kinds). The source keeps its rows until `finish`, so a cancel needs nothing; the target deletes the camera's rows when a cancel drops the camera.
- **The source deletes its rows at `finish` even when they did not travel** (the presets stay on the camera; the target can save them again).
- **Leftovers are stored** in `data/admin/move-leftovers.json` at `finish` and re-checked on every read: `config.json entry` while `config.json` still has the camera hidden with that `moveId`; `env NAME` / `env NAME_FILE` while the process environment has it. An env line removed from the file stays listed until the container is recreated (the process keeps its environment; the target's `stale_leftover` check sees it too). An entry whose camera runs here again is dropped.
- The heartbeat carries `moveLeftovers` only when non-empty (the profile's pattern: optional, also when truncated).

## Review Focus

1. **Version skew.** A new source and a target from before this plan (no `kinds`), or a cams-admin that doesn't relay them: the move must run as today, without `ptz` in the plan, and the approve record says the positions stay behind. Test in Task 4 (`an answer without kinds: no ptz in the plan, the move-approve record says not_taken`).
2. **A camera without positions** (every fixed camera): no `ptz` chunk, no `ptz` in the plan, no empty replace on the target. Tests in Task 3 (`no rows → no ptz chunk`) and Task 4 (`no rows → plan unchanged`).
3. **The env file in odd shapes** (the key twice, `export KEY=…`, an inline comment, CRLF, no trailing newline, not writable, `CAMPROXY_ENV_FILE` unset): every other byte unchanged; a failure leaves `env NAME` listed and the move still finishes. Tests in Task 6 and Task 7 (`an unwritable env file: finish ok, leftover listed, audit says failed`).
4. **A camera coming back** (A → B → A) to a proxy that still holds old rows for that id: replaced, not merged; its leftover entry disappears once it runs here. Tests in Task 5 (`replace drops the old rows of that camera only`) and Task 7 (`a camera running here again has no leftover`).
5. **Bad rows from a source** (21 rows, a duplicate slot, two homes, a control character in a name, `preset_name` over 31 bytes): the chunk fails, the target's rows stay. Test in Task 2 (`ptzRowsProblem refuses …`) and Task 5 (`invalid rows: chunk failed, rows unchanged`).

---

### Task 1: The `ptz` kind next to the file kinds

**Files:**
- Modify: `src/moves/types.ts`, `src/moves/done.ts`, `src/moves/purge.ts` (`Purged`, the loops), `src/moves/evaluate.ts` (`spaceFor`), `src/moves/copier.ts` (`fits`), `src/moves/inventory.ts` (`summarize`, `FOLDERS` gains `ptz: []`), `src/moves/returns.ts` (`RETURN_PLAN`), `src/moves/plan.ts` (`KINDS` = `FILE_KINDS`), `src/fleet/command-args.ts` (`summaryProblem`, `spaceProblem` use `FILE_KINDS`; plan and bounds kinds `MOVE_KINDS`, at most `MOVE_KINDS.length`)
- Test: `test/fleet-commands.test.ts`, `test/move-return.test.ts`

**Interfaces:**
- Produces (`src/moves/types.ts`):

```ts
export type FileKind = 'stills' | 'clips' | 'events' | 'checks' | 'archive';
export const FILE_KINDS: readonly FileKind[];          // the five, in this order
export type MoveKind = FileKind | 'ptz';
export const MOVE_KINDS: readonly MoveKind[];          // [...FILE_KINDS, 'ptz']
export type MoveSummary = Record<FileKind, KindSummary>;
// Space.perKind: Partial<Record<FileKind, number>>; CheckCounts stays Partial<Record<MoveKind, number>>
// MoveAnswer gains: kinds?: MoveKind[]   (filled in Task 4)
```
- `Purged = Record<FileKind, { files: number; bytes: number }>`; `zeros()` over `FILE_KINDS`.

Every existing `MOVE_KINDS` use that iterates a summary, a space, a purge or `Purged` switches to `FILE_KINDS` (`grep -rn MOVE_KINDS src web/src`); the type checker finds the rest.

- [ ] **Step 1: Write the failing tests** (`test/fleet-commands.test.ts`):
  - `move.start accepts a plan with ptz` — `validateMoveStart({ …valid, plan: { …plan, kinds: ['clips', 'ptz'] } })` passes; `kinds` with 7 entries or `'ptz'` twice → `plan.kinds`.
  - `a summary with a ptz key is refused` — `summaryProblem({ …fiveKinds, ptz: {files: 0, bytes: 0, rows: 1, oldest: null, newest: null} })` → `'summary'`.
  - `move-return.test.ts`: `RETURN_PLAN.kinds` equals `['stills', 'clips', 'events', 'checks', 'archive']`.
- [ ] **Step 2: Run** `npx vitest run test/fleet-commands.test.ts test/move-return.test.ts` — Expected: FAIL (`ptz` refused).
- [ ] **Step 3: Implement** the Interfaces block and the switch to `FILE_KINDS`.
- [ ] **Step 4: Run** `npm test && npm run lint:types && npm run check` — Expected: PASS (no other test changes: nothing lists `ptz` yet).
- [ ] **Step 5: Commit** `git add src/moves src/fleet/command-args.ts test/fleet-commands.test.ts test/move-return.test.ts && git commit -m "feat: ptz move kind next to the five file kinds"`

---

### Task 2: Positions rows for a move (catalog and checks)

**Files:**
- Modify: `src/catalog/ptz-positions.ts` (plan B's module)
- Create: `src/moves/ptz.ts`
- Test: `test/catalog-ptz-positions.test.ts`, `test/move-ptz.test.ts`

**Interfaces:**
- Consumes: plan B's `PtzPositionRow`, `listPositions`, `checkName` (`src/ptz/positions.ts`), `POSITIONS_MAX` (`src/camera/capabilities.ts`); `TableRows` (`src/moves/inventory.ts`).
- Produces:

```ts
// src/catalog/ptz-positions.ts
export function deleteCameraPositions(c: Catalog, cam: string): number;                 // rows deleted
export function replaceCameraPositions(c: Catalog, cam: string, rows: PtzPositionRow[]): void; // one transaction: delete cam's rows, insert these

// src/moves/ptz.ts
export type PtzWireRow = Omit<PtzPositionRow, 'cam'>;
export const PTZ_TABLE = 'ptz_positions';
export function ptzWireRows(rows: PtzPositionRow[]): PtzWireRow[];                     // drops cam
export function ptzRowsProblem(rows: unknown): string | null;                           // null = valid
export function importPtz(c: Catalog, cam: string, tables: TableRows[]): { inserted: number }; // throws on ptzRowsProblem; replace
```

`ptzRowsProblem` (the field name that failed, e.g. `'rows'`, `'rows.3.slot'`): an array of at most `POSITIONS_MAX` closed objects with exactly the `PtzWireRow` keys; `id` `/^pos_[0-9a-f]{16}$/`, unique; `checkName(name) === name`; `sort_order` a permutation of `0..n-1`; `home` 0|1, exactly one 1 when n > 0; `slot` integer 0–63, unique; `preset_name` a non-empty string of at most 31 UTF-8 bytes; `created_at`, `updated_at` safe integers ≥ 0. `importPtz` takes the rows of the `PTZ_TABLE` entry (none → zero rows: the camera's rows are deleted) and ignores other tables.

- [ ] **Step 1: Write the failing tests**
  - catalog: `deleteCameraPositions deletes that camera's rows only and counts them`; `replaceCameraPositions drops the old rows of that camera only` (cam `e1` has 3 rows, `cam2` 1; replace `e1` with 2 → `e1` has exactly those 2, `cam2` untouched); `a failing insert leaves the old rows` (two rows with the same slot → throws, the 3 old rows still there).
  - `move-ptz.test.ts`: `ptzWireRows drops cam`; `ptzRowsProblem accepts a valid set and []`; `ptzRowsProblem refuses …` (`it.each`: 21 rows, a duplicate id, a duplicate slot, slot 64, two homes, no home, `sort_order` [0, 2], a name `'a\nb'`, a `preset_name` of 32 bytes, an extra key `cam`, a missing `updated_at`); `importPtz replaces and returns inserted`; `importPtz with invalid rows throws and changes nothing`.
- [ ] **Step 2: Run** `npx vitest run test/catalog-ptz-positions.test.ts test/move-ptz.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces block (prepared statements; `BEGIN`/`COMMIT`/`ROLLBACK` as plan B's module does).
- [ ] **Step 4: Run** the same tests and `npm run lint:types` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/catalog/ptz-positions.ts src/moves/ptz.ts test/catalog-ptz-positions.test.ts test/move-ptz.test.ts && git commit -m "feat: replace and delete a camera's PTZ positions for moves"`

---

### Task 3: The source lists and serves the `ptz` chunk

**Files:**
- Modify: `src/moves/inventory.ts` (`items()` for `ptz`, `CHUNK_ID`, `ORDER`, `chunkOrder`)
- Test: `test/move-inventory.test.ts`

**Interfaces:**
- Consumes: Task 1's `MoveKind`, Task 2's `PTZ_TABLE`, `ptzWireRows`.
- Produces: `listChunks(d, cam, kinds)` with `'ptz'` in `kinds` yields `{ id: 'ptz:<day>', kind: 'ptz', day, files: 0, bytes: 0, rows: n }` when the camera has rows; `chunkRows(d, cam, 'ptz:<day>')` → `[{ table: 'ptz_positions', rows: PtzWireRow[] }]` (by `sort_order`); `chunkManifest` → `{ files: [], rows: n, expired: 0 }`; `parseChunkId('ptz:2026-10-30')` works; `chunkOrder` puts `ptz` before Archive. The move API routes (`src/api/moves-api.ts`) serve it unchanged.

`items(c, 'ptz', range?)`: one item `{ ts: max(updated_at), files: [], rows: [{ table: 'ptz_positions', row }] … }` read from `ptz_positions` of `cam` (the `range` filter applies to `ts`); no rows → no item. `summarize` never sees `ptz` (Task 1).

- [ ] **Step 1: Write the failing tests**
  - `a camera with positions has one ptz chunk on the day of its newest change` (3 rows, `updated_at` on 2026-10-29 and 2026-10-30 → `ptz:2026-10-30`, `rows: 3`, `files: 0`).
  - `no rows → no ptz chunk` (also with `'ptz'` in `kinds`).
  - `chunkRows of the ptz chunk: the rows without cam, by sort_order`.
  - `chunkOrder: ptz first, then Archive, then the rest`.
  - `the manifest route serves a ptz chunk with no files` (through the existing route test helper in this file or `test/move-source-api.test.ts`).
- [ ] **Step 2: Run** `npx vitest run test/move-inventory.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run test/move-inventory.test.ts test/move-source-api.test.ts && npm run lint:types` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/moves/inventory.ts test/move-inventory.test.ts test/move-source-api.test.ts && git commit -m "feat: the source lists a camera's PTZ positions as a ptz chunk"`

---

### Task 4: Kinds exchange and the approved plan

**Files:**
- Modify: `src/moves/evaluate.ts` (`Evaluation` accept gains `kinds`), `src/moves/target.ts` (the `move.offer` result carries it), `src/fleet/command-args.ts` (`MoveAnswerArgs.kinds`, `validateMoveAnswer`), `src/moves/source.ts` (`answer()` keeps `kinds`; `approve()`; `MoveView.positions`; `go` lists `ptz` also when `transfer` is false), `src/fleet/client.ts:480` (hello `capabilities` gains `'move-ptz'`), `web/src/lib/moves.ts` + `web/src/components/MovePanel.svelte` (one line)
- Test: `test/move-offer.test.ts`, `test/fleet-commands.test.ts`, `test/move-source.test.ts`, `test/move-auto-approve.test.ts`, `test/move-ui-lib.test.ts`, the hello test (`grep -rln "'status', 'commands'" test`)

**Interfaces:**
- Consumes: Tasks 1–3; plan B's `listPositions`.
- Produces:

```ts
// evaluate.ts
export type Evaluation = { accept: true; space: Space; probeBps: number; kinds: MoveKind[] } | { accept: false; reason: MoveReason; detail?: string };
// accept → kinds: [...MOVE_KINDS]; the offer result: { accept: true, space, probeBps, kinds }
// command-args.ts
export interface MoveAnswerArgs { /* as today */ kinds?: MoveKind[] }   // unique, each in MOVE_KINDS, at most MOVE_KINDS.length; else 'kinds'
// source.ts
export type PositionsTravel = 'carried' | 'not_taken' | 'none';
export function withPositions(plan: MovePlan, answer: MoveAnswer, positions: number): { plan: MovePlan; positions: PositionsTravel };
// MoveView gains: positions: { count: number; travel: PositionsTravel } | null   (null before an accepted answer)
```

- `withPositions`: `positions === 0` → plan unchanged, `'none'`; `answer.kinds?.includes('ptz')` → `kinds` gets `'ptz'` appended, `'carried'`; else unchanged, `'not_taken'`.
- `approve()`: after `approveProblem` (which still refuses a `ptz` the panel sent: it has no summary entry), `p = withPositions(plan, r.answer, listPositions(catalog, cam).length)`; the "same plan again" comparison and the stored `r.plan` use the result. The `move-approve` message appends `; positions: N go with the camera` or `; positions stay behind: the target does not take them (N)`; `details.positions` = the `PositionsTravel`. The auto-approval goes through the same `approve()`.
- `go`: `r.manifest = listChunks(inventory, cam, r.plan.transfer ? r.plan.kinds : r.plan.kinds.filter((k) => k === 'ptz'))`.
- Panel line (`web/src/lib/moves.ts` `positionsText(v: MoveView['positions']): string`): `'carried'` → `"3 PTZ positions go with the camera."`; `'not_taken'` → `"3 PTZ positions stay behind: the target's cam-proxy is older. They stay saved on the camera."`; `'none'`/null → `''`.

- [ ] **Step 1: Write the failing tests**
  - `move-offer.test.ts`: `an accepted offer lists all six kinds` (`result.kinds` equals `MOVE_KINDS`).
  - `fleet-commands.test.ts`: `move.answer takes kinds`; `kinds ['ptz','ptz'] or ['video'] → 'kinds'`; `an answer without kinds still passes`.
  - `move-source.test.ts`: `an answer with ptz: the approved plan adds ptz, the move.approve event carries it`; `an answer without kinds: no ptz in the plan, the move-approve record says not_taken` (message contains `positions stay behind`, `details.positions === 'not_taken'`); `no rows → plan unchanged, positions 'none'`; `approving the same panel plan twice re-sends the event (not already_approved)`; `transfer false with positions: plan kinds ['ptz'], the manifest lists only the ptz chunk`; `a panel plan naming ptz is refused (plan.kinds)`.
  - `move-auto-approve.test.ts`: `auto-approval adds ptz the same way`.
  - `move-ui-lib.test.ts`: `positionsText` for the three cases.
  - hello test: capabilities `['status', 'commands', 'move-ptz']` with commands on, `['status', 'move-ptz']` without.
- [ ] **Step 2: Run** those files with `npx vitest run …` — Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces block.
- [ ] **Step 4: Run** `npm test && npm run lint:types && npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/moves/evaluate.ts src/moves/target.ts src/moves/source.ts src/fleet web/src/lib/moves.ts web/src/components/MovePanel.svelte test && git commit -m "feat: the source carries PTZ positions when the target takes them"`

---

### Task 5: The target imports the positions

**Files:**
- Modify: `src/moves/copier.ts` (`fetchManifest` id pattern from `MOVE_KINDS`; `copy()`; `chunk()` for `ptz`; deps `ptzImported`), `src/moves/target.ts` (cancel), `src/proxy.ts` (wiring: `ptzImported`, `end.deletePositions`)
- Test: `test/move-copier.test.ts`, `test/move-finish-cancel.test.ts`

**Interfaces:**
- Consumes: Task 2's `importPtz`, `deleteCameraPositions`; plan B's `CameraWorker.ptz.positions.invalidate()` and the `ptz-positions` stream type.
- Produces:
  - `CopierDeps.ptzImported?: (cam: string) => void` — wired in `src/proxy.ts` to the worker's `ptz.positions.invalidate()` and `log.append(cam, 'ptz-positions', {})`.
  - `TargetDeps.end.deletePositions?: (cam: string) => number`.

Copier rules: `fetchManifest` accepts `^(stills|clips|events|checks|archive|ptz):\d{4}-\d{2}-\d{2}$` (built from `MOVE_KINDS`). `copy()` returns early only when `!plan.transfer && !plan.kinds.includes('ptz')`. `chunk()` for a `ptz` chunk: no files; `rows(c)` as today; `importPtz(catalog, camera, rows)` with the same 3 attempts instead of `importRows`; success → verified, `ptzImported(camera)`; failure (invalid or throwing) → the chunk ends failed through the existing `importFailed` path (check: `failed.ptz = 1`). Target cancel: where it drops a written camera (`fresh.cameraWritten`), also `end.deletePositions(cam)`.

- [ ] **Step 1: Write the failing tests**
  - `move-copier.test.ts` (its fake source): `a ptz chunk replaces the camera's rows and calls ptzImported once`; `replace drops the old rows of that camera only`; `invalid rows: chunk failed, rows unchanged` (two homes; `check.failed.ptz === 1`); `transfer false with ptz: only the ptz chunk is copied`; `a target plan without ptz skips a listed ptz chunk`.
  - `move-finish-cancel.test.ts`: `a cancel after the camera step deletes the camera's positions on the target`.
- [ ] **Step 2: Run** `npx vitest run test/move-copier.test.ts test/move-finish-cancel.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run lint:types` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/moves/copier.ts src/moves/target.ts src/proxy.ts test/move-copier.test.ts test/move-finish-cancel.test.ts && git commit -m "feat: the target replaces a moved camera's PTZ positions"`

---

### Task 6: Removing a key from the env file

**Files:**
- Modify: `src/config/env-file.ts`
- Test: `test/env-file.test.ts`

**Interfaces:**
- Produces:

```ts
// Every assignment line of `key` removed (with its line end); null when the file sets none (nothing written, no backup).
export function removeEnvKey(path: string, key: string, now?: Date): { removed: number; backup: string } | null;
// Pure: the text without key's assignment lines.
export function withoutEnvKey(text: string, key: string): string;
```

Extract the backup + temp file + rename + prune of `writeEnvKey` into one private `replaceEnvFile(path, next, now): string /* backup name */` used by both; `writeEnvKey`'s behaviour and errors stay as they are. Comment lines that mention the key (`# CAMPROXY_CAMERA_PASSWORD_CAM4=…`) are not assignments and stay.

- [ ] **Step 1: Write the failing tests**
  - `withoutEnvKey removes every assignment, keeps every other byte` (`it.each`: plain, `export KEY=v`, `KEY = v # note`, quoted, twice, CRLF, last line without newline, a commented-out line stays, a key that is a prefix of another (`…_CAM4` vs `…_CAM40`) leaves the other).
  - `removeEnvKey writes a backup and keeps the mode`; `a file without the key: null, no backup`; `not set / bad path / not writable → EnvFileError with that code` (reuse the existing helpers of this file).
  - `writeEnvKey is unchanged` (the existing tests stay green).
- [ ] **Step 2: Run** `npx vitest run test/env-file.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run test/env-file.test.ts test/config-env.test.ts && npm run lint:types` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/config/env-file.ts test/env-file.test.ts && git commit -m "feat: remove a key from the env file"`

---

### Task 7: The source's cleanup and the leftovers store

**Files:**
- Create: `src/moves/leftovers.ts`
- Modify: `src/moves/source.ts` (`SourceDeps.end`, `finish()`), `src/proxy.ts` (wiring)
- Test: `test/move-leftovers.test.ts`, `test/move-finish-cancel.test.ts`

**Interfaces:**
- Consumes: Task 2's `deleteCameraPositions`; Task 6's `removeEnvKey`; `cameraPasswordEnv` (`src/config/password-env.ts`); `Loaded` (`src/config/load.ts`).
- Produces:

```ts
// src/moves/leftovers.ts
export interface MoveLeftover { camera: string; moveId: string; items: string[] }
export const LEFTOVERS_MAX = 16;
export type EnvCleanup = { outcome: 'removed'; key: string; backup: string } | { outcome: 'not_in_file' | 'not_managed'; key: string } | { outcome: 'failed'; key: string; code: string };
// The line removed when CAMPROXY_ENV_FILE is set and read (loaded.envFile?.read); errors become 'failed' with the EnvFileError code.
export function removePasswordLine(loaded: Loaded, cam: string, now?: Date): EnvCleanup;
// What is left of a camera that moved away, as seen now.
export function leftoverItems(loaded: Loaded, cam: string, moveId: string): string[];
export class MoveLeftovers {
  constructor(dataDir: string);                        // data/admin/move-leftovers.json, 0600, written atomically
  add(entry: MoveLeftover): void;                      // replaces an entry of that camera; keeps the newest LEFTOVERS_MAX
  current(loaded: Loaded): MoveLeftover[];             // each entry's items re-checked with leftoverItems; empty ones and cameras running here dropped
}
// SourceDeps.end gains:
//   deletePositions: (cam: string) => number;
//   envCleanup: (cam: string) => EnvCleanup;
//   leftovers: Pick<MoveLeftovers, 'add'>;
```

`leftoverItems`: `config.json entry` when `loaded.order.includes(cam)` and `loaded.config.cameras[cam]?.moved === moveId`; `env NAME` when `(loaded.env[NAME] ?? '').trim() !== ''`; `env NAME_FILE` when `loaded.env[NAME_FILE]` is set; `NAME = cameraPasswordEnv(cam)`. `current` drops an entry when `loaded.config.cameras[cam]` exists without `moved` (the camera runs here again).

`finish()`, after the existing purge and override removal and before `move-cleanup` is written: `positions = end.deletePositions(cam)`; `env = end.envCleanup(cam)`; `items = leftoverItems(this.d.loaded(), cam, r.id)`; when `items.length`, `end.leftovers.add({ camera: cam, moveId: r.id, items })`. The `move-cleanup` record gains `details.ptzPositions` (count), `details.env` (the `EnvCleanup`, never the value) and `details.leftovers` (items), and its message `…; N PTZ positions deleted; CAMPROXY_CAMERA_PASSWORD_CAM4 removed from the env file (backup .env.bak-…)` / `… could not be removed from the env file (not_writable)` / `; still to remove by hand: config.json entry, env …`. `outcome` stays `success` (the move is done); a failed env removal is in the message, details and leftovers. A repeated finish (tombstone) does none of it again.

- [ ] **Step 1: Write the failing tests**
  - `move-leftovers.test.ts`: `leftoverItems: a hidden config.json entry, an env password, an env _FILE` (a `Loaded` built as the existing move tests build one, env `{ CAMPROXY_CAMERA_PASSWORD_CAM4: 'x', CAMPROXY_CAMERA_PASSWORD_CAM4_FILE: '/run/secrets/x' }`); `an overrides-added camera has no config.json entry`; `current drops resolved items and a camera running here again`; `add keeps one entry per camera and at most 16`; `removePasswordLine: removed / not_in_file / not_managed (no CAMPROXY_ENV_FILE) / failed (read-only dir)`; `the store file is 0600 and survives a new instance`.
  - `move-finish-cancel.test.ts`: `finish deletes the camera's PTZ positions and audits the count`; `finish removes the password line from a managed env file, other lines byte for byte`; `an unwritable env file: finish ok, leftover listed, audit says failed`; `a config.json camera: leftover "config.json entry"`; `no env value appears in the audit record` (grep the record for the test value); `a repeated finish does not touch the env file again`; `a camera running here again has no leftover` (after a later move brings it back).
- [ ] **Step 2: Run** `npx vitest run test/move-leftovers.test.ts test/move-finish-cancel.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces block; wire `end.deletePositions` (catalog), `end.envCleanup` (`removePasswordLine(loaded(), cam)`) and one `MoveLeftovers` instance in `src/proxy.ts`.
- [ ] **Step 4: Run** `npm test && npm run lint:types` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/moves/leftovers.ts src/moves/source.ts src/proxy.ts test/move-leftovers.test.ts test/move-finish-cancel.test.ts && git commit -m "feat: move cleanup deletes PTZ positions and the env password line, keeps leftovers"`

---

### Task 8: `moveLeftovers` in the status, the heartbeat and the Status page

**Files:**
- Modify: `src/api/control-api.ts` (`/status` gains `moveLeftovers`; deps `moveLeftovers: () => MoveLeftover[]`), `src/fleet/heartbeat.ts` (`buildHeartbeat` gains `moveLeftovers`), `src/fleet/client.ts` (passes `d.moveLeftovers?.()`), `src/proxy.ts` (wiring: `leftovers.current(loaded)`)
- Modify: `test/contract/cams-admin-v1/**` (vendor cams-admin's released `contract/v1`, `SOURCE` = its commit on `main`)
- Create: `web/src/lib/move-leftovers.ts`, `web/src/components/MoveLeftoversCard.svelte`
- Modify: `web/src/pages/Status.svelte` (the card after the `MoveStatusCard`s, only when the list is non-empty)
- Test: `test/control-api.test.ts`, `test/fleet-heartbeat.test.ts` (or the file that tests `buildHeartbeat`: `grep -ln buildHeartbeat test`), `test/fleet-contract.test.ts`, `test/fleet-move-contract.test.ts`, `test/move-ui-lib.test.ts`

**Interfaces:**
- Consumes: Task 7's `MoveLeftover`, `MoveLeftovers.current`.
- Produces:
  - `GET /control/status` → `{ …, moveLeftovers: MoveLeftover[] }` (always present).
  - `buildHeartbeat(summary, proxy, maxBytes?, profile?, moveLeftovers?: MoveLeftover[])`: `moveLeftovers` in the body only when non-empty, kept when truncated; entries cut to 16, items to 4, strings to 80 characters.
  - `web/src/lib/move-leftovers.ts`: `leftoverAdvice(cam: string, item: string): string` —
    - `config.json entry` → `Delete cameras.<cam> from config.json, then restart the proxy.`
    - `env NAME` → `Remove NAME from the proxy's environment (compose file or .env), then recreate the container (docker compose up -d). If this proxy already removed it from its .env (see the audit log), recreating is enough.`
    - `env NAME_FILE` → `Remove NAME_FILE and its secret from the compose file, then recreate the container (docker compose up -d).`
  - `MoveLeftoversCard.svelte`: title "Left over from camera moves", one block per entry (camera, move id, one advice line per item).

- [ ] **Step 1: Vendor the contract**: copy cams-admin `main`'s `contract/v1/` over `test/contract/cams-admin-v1/` and update `SOURCE` (the drift check `scripts/contract-drift.sh` compares against it). Run `npm test -- contract` — Expected: PASS (Task 4 already takes `kinds`). A vendored fixture that fails names a wire shape this plan missed: fix it in the owning task's code before going on.
- [ ] **Step 2: Write the failing tests**
  - `control-api.test.ts`: `status lists moveLeftovers ([] when none)`.
  - heartbeat: `moveLeftovers only when non-empty, kept when truncated, clamped to 16 × 4`.
  - `fleet-contract.test.ts` / `fleet-move-contract.test.ts`: a heartbeat with `moveLeftovers`, an offer result with `kinds`, a `move.answer` with `kinds`, a `move.approve` plan with `ptz`, a `move.progress` with a `ptz:` chunk all validate against the vendored strict schemas.
  - `move-ui-lib.test.ts`: `leftoverAdvice` for the three item shapes.
- [ ] **Step 3: Run** them — Expected: FAIL.
- [ ] **Step 4: Implement** the Interfaces block.
- [ ] **Step 5: Run** `npm test && npm run lint:types && npm run check` — Expected: PASS.
- [ ] **Step 6: Commit** `git add src/api/control-api.ts src/fleet src/proxy.ts test/contract/cams-admin-v1 web/src test && git commit -m "feat: moveLeftovers in the status, the heartbeat and the Status page"`

---

### Task 9: A whole move with positions, docs, changelog

**Files:**
- Modify: `test/move-e2e.test.ts`
- Modify: `docs/camera-move.md` ("What moves, and what doesn't", "Leftovers"), `docs/audit-log.md` (`move-approve`, `move-cleanup` details), `README.md` (`GET /control/status` row: `moveLeftovers`), `CHANGELOG.md` (Unreleased)

**Interfaces:**
- Consumes: Tasks 1–8.

- [ ] **Step 1: Write the failing test** in `move-e2e.test.ts` (its two in-process proxies): `PTZ positions travel and the source cleans up` — seed 3 rows for `cam3` on the source (Task 2's `replaceCameraPositions`), source env file in the test's temp dir with `CAMPROXY_CAMERA_PASSWORD_CAM3=test-only` plus two other lines and `CAMPROXY_ENV_FILE` pointing at it; run the move as the first e2e test does; expect: the target's `listPositions(…, 'cam3')` equals the source's rows (ids, names, order, home, slot, preset_name); the source has none; the env file lost exactly that line; the source's process env in the test also sets `CAMPROXY_CAMERA_PASSWORD_CAM3` (as compose's `env_file` would), so its `GET /control/status` `moveLeftovers` is `[{ camera: 'cam3', moveId, items: ['env CAMPROXY_CAMERA_PASSWORD_CAM3'] }]`; `move-cleanup` details `ptzPositions: 3`.
- [ ] **Step 2: Run** `npx vitest run test/move-e2e.test.ts` — Expected: FAIL only if wiring is missing; fix the wiring in `src/proxy.ts` until it passes.
- [ ] **Step 3: Docs**: camera-move.md — PTZ positions move with the camera when both proxies are on this version (else they stay saved on the camera and the approve record says so); the target replaces the camera's positions; at the end the source deletes its positions and removes `CAMPROXY_CAMERA_PASSWORD_<ID>` from its `CAMPROXY_ENV_FILE` (backup kept) and lists what it can't remove under "Left over from camera moves" on the Status page, in `GET /control/status` and in cams-admin's diagnostics; replace the sentence "the source's `.env` value is not deleted at the end". audit-log.md: the new details. README: the status row. CHANGELOG: one user-terms entry.
- [ ] **Step 4: Run** `npm test && npm run lint:types && npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** `git add test/move-e2e.test.ts docs/camera-move.md docs/audit-log.md README.md CHANGELOG.md && git commit -m "docs: PTZ positions in moves, move leftovers"`
