# Camera capabilities and PTZ (cam-proxy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cam-proxy tells clients per camera what it can do (`capabilities`, PTZ first) and offers a maker-neutral PTZ API (moves with a lease, zoom, focus, up to 20 saved positions) that it maps onto Reolink `PtzCtrl` and preset slots.

**Architecture:** One module derives our capabilities object from Reolink's `GetAbility`; the worker re-reads it when the camera comes online or changes model or firmware. A Reolink mapping module (`src/camera/ptz.ts`) is the only place that knows `PtzCtrl`, ops and slots; a move lease (`src/ptz/lease.ts`) serializes a camera's PTZ commands and stops every move after its duration; a positions service (`src/ptz/positions.ts`) keeps positions in the catalog (`ptz_positions`, migration 10) and in camera preset slots. A new router `src/api/ptz-api.ts` exposes it under `/api/cameras/:cam/ptz`.

**Tech Stack:** TypeScript (Node 26, CommonJS), Express 5, node:sqlite, vitest, supertest, cam-sim in process.

**Spec:** `docs/superpowers/specs/2026-10-30-ptz-capabilities-design.md` — this plan covers §4, §5, §6 and the cam-proxy part of §8.3. §7 (moves and move cleanup) is plan D, which builds on the names in the Interfaces blocks of Tasks 5 and 6.

## Global Constraints

- No Reolink terms in the client API or its docs: no `PtzCtrl`, op names, preset slots or slot ids in any response, error or SSE message (spec §2 anti-goals).
- `capabilities`: `{ "schema": 1, "ptz": { "move": true, "zoom", "focus", "speed", "positions": { "max": 20 } } }`; `ptz` is `null` without pan/tilt control; `positions` absent when the camera can't store presets; `capabilities` is `null` while the camera was never read.
- Features list gains `ptz` (appended: `['sse-cam-list', 'ptz']`). cams treats `capabilities.ptz` as present only when the camera's `features` contain `ptz`.
- Move: `direction` one of `left right up down left-up left-down right-up right-down`; `speed` integer 1–10, default 5; `durationMs` integer 100–2000, default 400. Zoom `in|out`, focus `near|far`, same `durationMs`. 204 on success.
- Camera speed = `Math.round(1 + (s - 1) * 63 / 9)` (1→1, 2→8, 5→29, 10→64); camera range 1–64.
- Errors: no capability 404 `{"error":"not_supported"}`; offline 503 `camera_offline`; camera refusal 502 `camera_error`; bad input 400 `invalid` (the existing `bad()`); unknown position 404 `not_found`; 409 `limit_reached`, `no_free_slot`, `position_missing`, `home_position`, `name_taken`.
- At most **20** positions per camera; names trimmed, 1–40 characters, unique per camera ignoring case; the camera copy is cut to **31 bytes** (UTF-8, whole characters).
- Preset slots are ids **0–63**; a slot enabled on the camera that no row of this camera owns is never written or cleared.
- SSE type `ptz-positions` with data `{}` (the frame carries `cam`); audit action `ptz-position` with `details.op` one of `save`, `resave`, `rename`, `home`, `order`, `delete`. Moves are not audited.
- Real camera: whole-object sets only (`SetPtzPreset` always sends `{channel, enable, id, name}`), re-read after writing.
- Public repo: fixtures and docs carry no real addresses, serials, MACs or ids.
- Tests: `npm test` (vitest) and `npm run lint:types` must pass at every commit.

## Decisions beyond the spec

- **No serial check (spec §6 "replaced or reset camera").** `GetDevInfo.serial` changes on every reboot (cams `docs/reolink-api.md`; `src/camera/reboot.ts` uses exactly that to see a reboot; cam-sim draws a new one per reboot), so storing it would mark every position `missing` after each reboot. Instead each row stores the name it wrote to the camera (`preset_name`), and a position is `missing` unless its slot is enabled **with that name**. A replaced camera has empty slots or foreign presets with other names; a reset camera has empty slots. The column for plan D's rows is therefore `preset_name`, not `serial`. (If Klaus wants a hardware identity too, the MAC from `GetLocalLink` is stable, but cam-sim does not answer `GetLocalLink` today.)
- Capabilities are read when the camera comes online (every reconnect, which is when the proxy logs in again) and when model or firmware changes, not at each hourly token renewal.
- `capabilities === null` → PTZ routes answer 503 `camera_offline`.
- `GET …/positions` with the camera offline uses the last preset read (any age); with none, 503 `camera_offline`. Writes and `go` need the camera online (503).
- The lease runs all of a camera's PTZ commands one after another (a `Stop` never overtakes its move on the client's two parallel connections); its timer starts when the request is accepted; a failed `Stop` is retried once; the worker sends `Stop` before logging out on restart or stop.
- `save` of a `missing` position whose slot now holds a foreign preset takes a new free slot; `delete` clears the camera slot only when it still holds this position's preset.
- Renaming never touches the camera (re-sending `SetPtzPreset` would also re-save the current view); the camera keeps the name from the last save.
- Zoom, focus and `ToPos` are sent with camera speed 32 (as measured) when the camera has `supportPtzSpeed`. Focus `far` → `FocusInc`, `near` → `FocusDec`: not measured; the real-camera script prints the focus value so Klaus can confirm by eye.
- Names with control characters are refused (400). A duplicate name is 409 `name_taken`.
- Managed client tokens (cams via cams-admin) may use PTZ: these are client routes, and `MANAGED_ALLOWED` only narrows admin writes under `/control`.
- The real-camera script checks "the slot is free again" through the API (position gone, a new save succeeds); slot ids stay internal. The sim integration test checks slots directly.

## Review Focus

1. **A `Stop` that overtakes its move.** The camera client sends up to two requests at once; a hold that ends while the last move request is still in flight must leave the camera stopped. Test in Task 4 (`stop() queued behind a slow move still runs after it`).
2. **A foreign preset in a position's slot** (Reolink app saved over it). Re-saving or deleting that position must never overwrite or clear it. Tests in Task 6 (`resave moves off a foreign slot`, `delete leaves a foreign slot alone`).
3. **Long or non-ASCII names** ("Einfahrt Süd – Tor 🌳 …"). Cut to 31 bytes without splitting a character, and the read-back check compares with the cut name, or every such save fails with 502. Tests in Task 3 (`presetName`) and Task 6 (`a 40-character umlaut name saves and reads back ok`).
4. **Proxy stop or camera-side restart during a hold.** The camera must get `Stop` before the session is dropped. Test in Task 7 (`stopParts sends Stop while a move is leased`).
5. **Two viewers saving at the same moment.** They must get distinct slots, distinct names, and the limit of 20 must hold. Test in Task 6 (`concurrent saves get different slots; the 21st is limit_reached`).

---

### Task 1: Capability derivation and fixtures

**Files:**
- Create: `src/camera/capabilities.ts`
- Create: `test/fixtures/abilities/e1-outdoor-pro.json`, `test/fixtures/abilities/rlc-1224a.json`, `test/fixtures/abilities/cx820.json`
- Test: `test/camera-capabilities.test.ts`

**Interfaces:**
- Produces:
  - `export const POSITIONS_MAX = 20`
  - `export interface PtzCapability { move: true; zoom: boolean; focus: boolean; speed: boolean; positions?: { max: number } }`
  - `export interface Capabilities { schema: 1; ptz: PtzCapability | null }`
  - `export function deriveCapabilities(ability: unknown): Capabilities`
  - `export type CameraCommand = (cmd: string, param?: object) => Promise<unknown>` (also used by Tasks 3 and 6)
  - `export async function readCapabilities(command: CameraCommand, user: string): Promise<Capabilities>` — `GetAbility` with `{ User: { userName: user } }`, then `deriveCapabilities`.

Fixtures are the `value` of a `GetAbility` reply, i.e. `{ "Ability": { … } }`: copy the E1 from `/Volumes/SSD-WDBlack-1T/claude-work/e1-reference/GetAbility.json` (`.value`), the RLC-1224A from `~/Development/cam-sim/src/profile/ability.json` and the CX820 from `~/Development/cam-sim/src/profile/cx820-ability.json` (both already `{Ability}`).

Derivation from `Ability.abilityChn[0]`, each flag "set" when its `permit > 0`: `ptzCtrl` set → `ptz` object, else `ptz: null`; inside it `zoom` ← `supportZoom`, `focus` ← `supportFocus`, `speed` ← `supportPtzSpeed`, `positions: { max: POSITIONS_MAX }` when `ptzPreset` is set. Fixed cameras report `supportZoom`/`supportFocus` permit 6 too, which is why they only count inside `ptz`. A missing or malformed ability (no `abilityChn`) derives `{ schema: 1, ptz: null }`.

- [ ] **Step 1: Write the failing tests**

```ts
const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'abilities', `${n}.json`), 'utf8'));
it('E1 Outdoor Pro: move, zoom, focus, speed and 20 positions', () => {
  expect(deriveCapabilities(fx('e1-outdoor-pro'))).toEqual({ schema: 1, ptz: { move: true, zoom: true, focus: true, speed: true, positions: { max: 20 } } });
});
it.each(['rlc-1224a', 'cx820'])('%s: no ptz, although supportZoom/supportFocus are set', (n) => {
  expect(deriveCapabilities(fx(n))).toEqual({ schema: 1, ptz: null });
});
it('ptzCtrl without ptzPreset: no positions key', () => { /* E1 fixture with ptzPreset.permit = 0 */ expect(caps.ptz).not.toHaveProperty('positions'); });
it('speed false when supportPtzSpeed.permit is 0', …);
it('garbage → ptz null', () => { for (const v of [null, {}, { Ability: {} }, { Ability: { abilityChn: [] } }]) expect(deriveCapabilities(v)).toEqual({ schema: 1, ptz: null }); });
it('readCapabilities sends GetAbility with the user', async () => { /* stub command records ['GetAbility', { User: { userName: 'proxy' } }] */ });
it('the fixtures carry no addresses or identifiers', () => {
  for (const n of ['e1-outdoor-pro', 'rlc-1224a', 'cx820']) {
    const s = readFileSync(…, 'utf8');
    expect(s).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    expect(s).not.toMatch(/"(serial|mac|uid|UID)"\s*:/);
  }
});
```

- [ ] **Step 2: Run** `npx vitest run test/camera-capabilities.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Add the fixtures and implement `src/camera/capabilities.ts`** per the Interfaces block.
- [ ] **Step 4: Run** `npx vitest run test/camera-capabilities.test.ts && npm run lint:types` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/camera/capabilities.ts test/camera-capabilities.test.ts test/fixtures/abilities/
git commit -m "feat: derive camera capabilities from GetAbility"
```

---

### Task 2: Capabilities on the worker and in the camera list

**Files:**
- Modify: `src/camera/status.ts` (emit `'device'`)
- Modify: `src/cameras/worker.ts` (hold and refresh capabilities)
- Modify: `src/api/client-api.ts:73` (`info()` gains `capabilities`)
- Modify: `src/stream/sse.ts:10` (`FEATURES`)
- Modify: `openapi.yaml` (camera item schema: `capabilities`; `features` description)
- Test: `test/camera-status.test.ts`, `test/camera-worker.test.ts`, `test/client-api.test.ts:39,53-54`

**Interfaces:**
- Consumes: `readCapabilities`, `Capabilities` (Task 1).
- Produces:
  - `StatusPoller` emits `'device'` with `{ model: string; firmware: string }` when a successful check reads a model or firmware different from the previous **known** one (not on the first read).
  - `CameraWorker.capabilities(): Capabilities | null`
  - `CameraWorker.refreshCapabilities(): Promise<void>` — reads, keeps the result in memory; when it differs (deep-equal) from the current one, appends a `camera` stream message `{ ...(toldName ? { name } : {}), address: cam().host, capabilities }`. A failed read keeps the previous value and logs `capabilities_read_failed` (warn, `cameraId`, `err`).
  - `FEATURES = ['sse-cam-list', 'ptz']`
  - `GET /api/cameras[/:cam]` items gain `capabilities: Capabilities | null`.

The worker calls `refreshCapabilities()` from its existing `status.on('change')` listener when `s.online`, and from a new `status.on('device')` listener. Both are fire-and-forget like `ftpWatch.checkNow()`.

- [ ] **Step 1: Write the failing tests**
  - `camera-status.test.ts`: `'device' fires when the firmware changes, not on the first read`. Use the sim's `firmware` option for the first read, then change `sim.engine.config.firmVer` (or restart the sim with another firmware) and `checkNow()`; expect one `'device'` event with the new firmware.
  - `camera-worker.test.ts`: `capabilities: null before the first read, {schema:1, ptz:null} once online (RLC-1224A sim)`, and `a changed capability appends one camera message with capabilities` (stub `readCapabilities` through a worker whose second read differs: spy with `vi.spyOn(capabilitiesModule, 'readCapabilities')`, then expect `log.latest('cam1','camera')?.data.capabilities` to equal the new value; a read with no change appends nothing).
  - `client-api.test.ts:39`: the expected item gains `capabilities: { schema: 1, ptz: null }` and `features: ['sse-cam-list', 'ptz']`; lines 53–54 likewise.
- [ ] **Step 2: Run** `npx vitest run test/camera-status.test.ts test/camera-worker.test.ts test/client-api.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces block. In `StatusPoller.set`, emit `'device'` when `this.current.model !== undefined` and model or firmware differ. Document `capabilities` in `openapi.yaml` under the camera item schema (nullable object, `schema` const 1, `ptz` nullable with the five fields, `positions.max`).
- [ ] **Step 4: Run** `npm test && npm run lint:types` — Expected: PASS (openapi and multi-camera tests included).
- [ ] **Step 5: Commit**

```bash
git add src/camera/status.ts src/cameras/worker.ts src/api/client-api.ts src/stream/sse.ts openapi.yaml test/camera-status.test.ts test/camera-worker.test.ts test/client-api.test.ts
git commit -m "feat: per-camera capabilities in the camera list"
```

---

### Task 3: Reolink PTZ mapping

**Files:**
- Create: `src/camera/ptz.ts`
- Test: `test/camera-ptz.test.ts`

**Interfaces:**
- Consumes: `CameraCommand` (Task 1).
- Produces:
  - `export const PTZ_DIRECTIONS = ['left','right','up','down','left-up','left-down','right-up','right-down'] as const; export type PtzDirection = (typeof PTZ_DIRECTIONS)[number]`
  - `export type ZoomDirection = 'in' | 'out'; export type FocusDirection = 'near' | 'far'`
  - `export const PRESET_SLOTS = 64` (ids 0–63)
  - `export const PRESET_NAME_BYTES = 31`
  - `export function cameraSpeed(speed: number): number` — the Global Constraints formula.
  - `export function presetName(name: string): string` — at most 31 UTF-8 bytes, cut at a code-point boundary.
  - `export interface PresetSlot { id: number; enabled: boolean; name: string }`
  - `export class ReolinkPtz { constructor(command: CameraCommand, speed: () => boolean)`:
    - `move(d: PtzDirection, speed: number): Promise<void>`: `PtzCtrl {channel:0, op, speed: cameraSpeed(speed)}`; no `speed` key when `speed()` is false.
    - `zoom(d: ZoomDirection): Promise<void>`: `ZoomInc`/`ZoomDec`. `focus(d: FocusDirection): Promise<void>`: `FocusInc` (far) / `FocusDec` (near). `goTo(slot: number): Promise<void>`: `ToPos` with `id: slot`. All three with `speed: 32` when `speed()`.
    - `stop(): Promise<void>`: `PtzCtrl {channel:0, op:'Stop'}`.
    - `presets(): Promise<PresetSlot[]>`: `GetPtzPreset {channel:0}`, `value.PtzPreset`, only ids 0–63, `enabled = enable === 1`.
    - `savePreset(slot: number, name: string): Promise<void>`: `SetPtzPreset {PtzPreset:{channel:0, enable:1, id:slot, name: presetName(name)}}`.
    - `clearPreset(slot: number): Promise<void>`: `SetPtzPreset {PtzPreset:{channel:0, enable:0, id:slot, name:''}}`.

Op table: left `Left`, right `Right`, up `Up`, down `Down`, left-up `LeftUp`, left-down `LeftDown`, right-up `RightUp`, right-down `RightDown`. `PtzCtrl` errors come back as `CameraError` from `command` (rspCode −4 included) and are not caught here.

- [ ] **Step 1: Write the failing tests** with a recording stub `command`:

```ts
it('cameraSpeed maps 1–10 onto 1–64', () => { expect([1, 2, 5, 10].map(cameraSpeed)).toEqual([1, 8, 29, 64]); });
it('presetName: ASCII cut to 31', () => expect(presetName('x'.repeat(40))).toBe('x'.repeat(31)));
it('presetName: never splits a character', () => {
  const n = presetName('Einfahrt Süd – Tor 🌳🌳🌳🌳🌳');
  expect(Buffer.byteLength(n)).toBeLessThanOrEqual(31);
  expect(n).not.toContain('�');
  expect('Einfahrt Süd – Tor 🌳🌳🌳🌳🌳'.startsWith(n)).toBe(true);
});
it('move sends the op and the camera speed', async () => { await p.move('left-up', 10); expect(sent).toEqual([['PtzCtrl', { channel: 0, op: 'LeftUp', speed: 64 }]]); });
it('without speed support no speed key', …);
it('zoom/focus/goTo use speed 32; stop has none', …); // ZoomInc, FocusDec for near, ToPos id 5
it('presets: ids 0–63 only, enabled from enable', async () => { /* reply with ids 0, 63, 64 → two slots */ });
it('savePreset sends the whole object with the cut name; clearPreset enable 0 and empty name', …);
```

- [ ] **Step 2: Run** `npx vitest run test/camera-ptz.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement `src/camera/ptz.ts`** per the Interfaces block.
- [ ] **Step 4: Run** `npx vitest run test/camera-ptz.test.ts && npm run lint:types` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/camera/ptz.ts test/camera-ptz.test.ts && git commit -m "feat: Reolink PTZ commands and preset slots"`

---

### Task 4: The move lease

**Files:**
- Create: `src/ptz/lease.ts`
- Test: `test/ptz-lease.test.ts`

**Interfaces:**
- Produces:

```ts
export interface LeaseDeps {
  stop: () => Promise<void>;                              // the camera's Stop
  schedule?: (ms: number, fn: () => void) => () => void;   // test seam; default setTimeout + unref
  retryMs?: number;                                        // a failed timer Stop is retried once after this (default 250)
}
export class MoveLease {
  constructor(d: LeaseDeps);
  move(start: () => Promise<void>, durationMs: number): Promise<void>;
  stop(): Promise<void>;
  then(cmd: () => Promise<void>): Promise<void>;
  active(): boolean;
}
```

Semantics:
- All camera commands of one lease run one after another (a promise chain). One failing command doesn't break the chain for the next.
- `move`: cancels the pending timer, queues `start`, and arms a new timer of `durationMs` right away. When it fires it queues `stop`. Resolves or rejects with `start`'s outcome. If `start` rejects, the lease queues one best-effort `stop` and ends.
- `stop()`: cancels the timer and queues `stop` (always, even when not active), resolving with its outcome.
- `then(cmd)`: cancels the timer, queues `stop` if a move is active, then queues `cmd` (used by `go`, so a pending `Stop` can't cut a travel to a position short).
- `active()`: a move was started and no `stop` queued since.
- A timer `stop` that fails is retried once after `retryMs`; a second failure is logged (`ptz_stop_failed`, warn, `err`) and the lease ends.

- [ ] **Step 1: Write the failing tests** with a manual scheduler (`schedule` captures `fn`s; `fire()` runs due ones) and a command log:

```ts
it('stops after the duration', async () => { await lease.move(cmd('Left'), 400); fire(400); await idle(); expect(log).toEqual(['Left', 'Stop']); });
it('a second move replaces the first: one Stop, after the second duration', …); // ['Left','Right','Stop'], timer 1 cancelled
it('stop() stops at once and cancels the timer', …); // later fire() adds nothing
it('stop() queued behind a slow move still runs after it', async () => {
  const slow = deferred(); void lease.move(() => (log.push('Left'), slow.promise), 400);
  const s = lease.stop(); slow.resolve(); await s; expect(log).toEqual(['Left', 'Stop']);
});
it('then(cmd) during a move: Stop, then cmd, and no later Stop', …); // ['Left','Stop','ToPos']
it('a failed start rejects and sends one Stop', …);
it('a failed timer Stop is retried once', …); // stop fails once → two Stop attempts
it('never more than 2000 ms between the last move and its Stop', …); // move(…, 2000): timer armed with 2000
```

- [ ] **Step 2: Run** `npx vitest run test/ptz-lease.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement `src/ptz/lease.ts`.**
- [ ] **Step 4: Run** `npx vitest run test/ptz-lease.test.ts && npm run lint:types` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/ptz/lease.ts test/ptz-lease.test.ts && git commit -m "feat: PTZ move lease"`

---

### Task 5: Catalog table `ptz_positions` (migration 10)

**Files:**
- Modify: `src/catalog/migrations.ts` (append entry 10)
- Create: `src/catalog/ptz-positions.ts`
- Test: `test/catalog-ptz-positions.test.ts`

**Interfaces (plan D builds on these):**
- Migration 10, appended after 9, with a comment naming this spec §6:

```sql
CREATE TABLE ptz_positions (
  id TEXT PRIMARY KEY,          -- pos_<16 hex>
  cam TEXT NOT NULL,
  name TEXT NOT NULL,           -- as the user wrote it (trimmed)
  sort_order INTEGER NOT NULL,  -- 0..n-1 per camera, contiguous
  home INTEGER NOT NULL,        -- 1 for exactly one row per camera while any exist
  slot INTEGER NOT NULL,        -- camera preset slot 0-63
  preset_name TEXT NOT NULL,    -- the name written to the camera at the last save (presetName(name))
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (cam, slot)
);
CREATE INDEX ptz_positions_cam ON ptz_positions (cam, sort_order);
```

- `src/catalog/ptz-positions.ts` exports:
  - `export interface PtzPositionRow { id: string; cam: string; name: string; sort_order: number; home: 0 | 1; slot: number; preset_name: string; created_at: number; updated_at: number }`
  - `listPositions(c: Catalog, cam: string): PtzPositionRow[]` (by `sort_order`)
  - `positionById(c: Catalog, cam: string, id: string): PtzPositionRow | undefined`
  - `insertPosition(c: Catalog, row: PtzPositionRow): void`
  - `updatePosition(c: Catalog, cam: string, id: string, patch: Partial<Pick<PtzPositionRow, 'name' | 'slot' | 'preset_name' | 'updated_at'>>): void`
  - `setHomePosition(c: Catalog, cam: string, id: string, now: number): void` (one transaction: this row 1, the others 0)
  - `setPositionOrder(c: Catalog, cam: string, ids: string[], now: number): void` (one transaction; `ids` already validated)
  - `deletePosition(c: Catalog, cam: string, id: string): void` (one transaction; the rest renumbered 0..n-1 in their order)
  - Plan D adds `deleteCameraPositions(c, cam)` and `replaceCameraPositions(c, cam, rows)` here.

- [ ] **Step 1: Write the failing tests**
  - `migrates a version 9 catalog to 10 with ptz_positions` (build from `MIGRATIONS.slice(0, 9)` as `test/catalog-usage.test.ts` does, open, `schemaVersion() === 10`, the table exists).
  - `the same slot twice for one camera is refused; another camera may use it` (UNIQUE).
  - `list is by sort_order; delete renumbers 0..n-1`.
  - `setHomePosition leaves exactly one home`.
  - `setPositionOrder writes the given order`.
- [ ] **Step 2: Run** `npx vitest run test/catalog-ptz-positions.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** migration 10 and the module (prepared statements, `BEGIN`/`COMMIT`/`ROLLBACK` as `openCatalog` does).
- [ ] **Step 4: Run** `npm test -- catalog && npm run lint:types` — Expected: PASS (existing catalog migration tests included).
- [ ] **Step 5: Commit** `git add src/catalog/migrations.ts src/catalog/ptz-positions.ts test/catalog-ptz-positions.test.ts && git commit -m "feat: ptz_positions catalog table (migration 10)"`

---

### Task 6: The positions service

**Files:**
- Create: `src/ptz/positions.ts`
- Test: `test/ptz-positions.test.ts` (an in-memory fake camera of 64 slots + a real catalog in a temp folder; no cam-sim)

**Interfaces:**
- Consumes: `ReolinkPtz`, `PresetSlot`, `presetName`, `PRESET_SLOTS` (Task 3); `MoveLease` (Task 4); the Task 5 module; `POSITIONS_MAX` (Task 1).
- Produces:

```ts
export type PositionState = 'ok' | 'missing';
export interface PtzPositionJson { id: string; name: string; order: number; home: boolean; state: PositionState }
export class PtzError extends Error { constructor(readonly status: 400 | 404 | 409 | 503, readonly code: string, message?: string) }
// Pure helpers (exported for tests and plan D):
export function positionState(row: Pick<PtzPositionRow, 'slot' | 'preset_name'>, slots: PresetSlot[]): PositionState; // ok iff slot enabled with name === preset_name
export function freeSlot(slots: PresetSlot[], owned: number[]): number | null;   // lowest id 0..63 neither enabled nor owned
export function checkName(raw: unknown): string;                                  // trimmed 1–40 chars, no control chars; throws PtzError(400,'invalid')
export interface PositionsDeps {
  cam: string; catalog: Catalog; ptz: ReolinkPtz; lease: MoveLease;
  online: () => boolean;
  changed: () => void;                       // append the ptz-positions stream message
  now?: () => number; cacheMs?: number;      // default 30_000
}
export class PtzPositions {
  constructor(d: PositionsDeps);
  list(): Promise<{ max: number; positions: PtzPositionJson[] }>;
  save(name: unknown): Promise<PtzPositionJson>;          // new position here
  resave(id: string): Promise<PtzPositionJson>;           // overwrite with where it points now
  rename(id: string, name: unknown): Promise<PtzPositionJson>;
  makeHome(id: string): Promise<PtzPositionJson>;
  reorder(ids: unknown): Promise<PtzPositionJson[]>;
  remove(id: string): Promise<void>;
  goTo(id: string): Promise<void>;
  invalidate(): void;                                      // drop the cached slot read (camera came online)
}
```

Rules (spec §5.2, §6, and this plan's decisions):
- Every mutating method runs under one per-camera mutex (a promise chain); `list` and `goTo` don't take it.
- Slot read cache: `list` and `goTo` use a read no older than `cacheMs`; offline uses the last read of any age, none → `PtzError(503,'camera_offline')`. Every write re-reads and replaces the cache.
- `save`: `checkName`; duplicate (case-insensitive, `toLowerCase()`) → 409 `{"error":"name_taken"}` (cams relies on this code); 20 rows → 409 `limit_reached`; offline → 503; fresh read; `freeSlot(slots, rows' slots)` null → 409 `no_free_slot`; `ptz.savePreset`; re-read; slot not enabled with `presetName(name)` → `CameraError('camera_error', …)` (502), no row; insert with `sort_order` = count, `home` = 1 when first, `id` = `pos_` + 16 hex (`randomBytes(8)`); `changed()`.
- `resave`: slot target = own slot if it is empty or holds `row.preset_name`; else (foreign) a new `freeSlot` (excluding own) or 409 `no_free_slot`; save, confirm, update `slot`, `preset_name`, `updated_at`.
- `rename`: `checkName`, uniqueness excluding itself (409 `name_taken`, as for `save`); catalog only (camera untouched).
- `makeHome`: `setHomePosition`. (`home: false` is refused in the router.)
- `reorder`: `ids` must be an array holding every id of this camera exactly once, else 400 `invalid`.
- `remove`: Home while others exist → 409 `home_position`; offline → 503; if the fresh read shows the slot enabled with `row.preset_name`, `clearPreset` and re-read; still enabled → 502 and the row stays; then `deletePosition`. A slot already empty or foreign: row deleted, camera untouched.
- `goTo`: unknown → 404 `not_found`; offline → 503; state `missing` → 409 `position_missing`; else `lease.then(() => ptz.goTo(row.slot))`.
- Unknown id anywhere → 404 `not_found`. Every successful change calls `changed()` once.

- [ ] **Step 1: Write the failing tests** (fake camera: `slots: PresetSlot[]`, `savePreset`/`clearPreset` mutate it, a `foreign(id, name)` helper, counters for calls):

```ts
it('freeSlot skips enabled and owned slots', () => expect(freeSlot(slotsWith({ 0: 'Garden' }), [1])).toBe(2));
it('freeSlot: none left → null', …);
it('first save is Home in slot 0; a foreign preset in slot 0 is skipped', async () => {
  cam.foreign(0, 'Garden'); const p = await svc.save('Gate');
  expect(p).toMatchObject({ name: 'Gate', order: 0, home: true, state: 'ok' }); expect(cam.slot(1)).toEqual({ id: 1, enabled: true, name: 'Gate' }); expect(cam.slot(0).name).toBe('Garden');
});
it('names: trimmed, 1–40, unique ignoring case, no control characters', …); // ' gate ' ok; 'GATE' → 409 name_taken; '' / 41 chars / 'a\nb' → 400
it('a 40-character umlaut name saves and reads back ok', …); // state 'ok', camera name ≤ 31 bytes
it('a camera that doesn't keep the name → 502, nothing stored', …); // fake stores 'pos2' instead
it('concurrent saves get different slots; the 21st is limit_reached', async () => {
  const r = await Promise.allSettled(Array.from({ length: 21 }, (_, i) => svc.save(`P${i}`)));
  expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(20);
  expect((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 409, code: 'limit_reached' });
  expect(new Set(cam.enabledIds()).size).toBe(20);
});
it('no free slot → 409 no_free_slot', …); // 64 foreign presets
it('missing: slot emptied on the camera, or holding another name', …); // cam.clear(slot) / cam.foreign(slot, 'Other') → state 'missing' after cache expiry
it('list uses a read at most 30 s old; offline uses the last read; never read + offline → 503', …);
it('resave fixes a missing position in its own empty slot', …);
it('resave moves off a foreign slot', async () => { /* foreign took slot 0 → resave writes slot 1, slot 0 still 'Other' */ });
it('delete clears our slot; delete leaves a foreign slot alone', …);
it('Home: delete refused while others exist (home_position); the last one may go', …);
it('makeHome moves the mark; reorder needs every id once', …);
it('goTo a missing position → 409 position_missing and no ToPos sent', …);
it('goTo runs through the lease (Stop first while a move is active)', …);
it('each change calls changed() once; a refused one not at all', …);
```

- [ ] **Step 2: Run** `npx vitest run test/ptz-positions.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement `src/ptz/positions.ts`.**
- [ ] **Step 4: Run** `npx vitest run test/ptz-positions.test.ts && npm run lint:types` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/ptz/positions.ts test/ptz-positions.test.ts && git commit -m "feat: PTZ positions on camera preset slots"`

---

### Task 7: Worker wiring and stream type

**Files:**
- Create: `src/ptz/camera-ptz.ts`
- Modify: `src/cameras/worker.ts` (member `ptz`, online → `invalidate`, `stopParts` → `halt`)
- Modify: `src/stream/log.ts:4` (`STREAM_TYPES` gains `'ptz-positions'`)
- Test: `test/camera-worker.test.ts`, `test/ptz-camera.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces:

```ts
export class CameraPtz {
  constructor(d: { cam: string; command: CameraCommand; capabilities: () => Capabilities | null; online: () => boolean; catalog: Catalog; log: StreamLog });
  readonly lease: MoveLease;          // stop → ReolinkPtz.stop
  readonly positions: PtzPositions;   // changed → log.append(cam, 'ptz-positions', {})
  readonly camera: ReolinkPtz;        // speed → capabilities()?.ptz?.speed === true
  halt(): Promise<void>;              // lease.stop() when lease.active(), errors swallowed (logged)
}
```

- `CameraWorker.ptz: CameraPtz`, made once in the constructor with `command: (cmd, param) => this.client.command(cmd, param)` (the client is read at use, so a restart's new client is used).
- The worker's `status.on('change')` listener calls `this.ptz.positions.invalidate()` when `s.online`.
- `stopParts()` awaits `this.ptz.halt()` before `this.client.logout()`.
- `STREAM_TYPES = [..., 'archive', 'ptz-positions']` (appended). Search for other hard-coded type lists (`grep -rn "'still-check', 'archive'" src web/src openapi.yaml README.md`) and add it there too.

- [ ] **Step 1: Write the failing tests**
  - `ptz-camera.test.ts`: `a position change appends one ptz-positions message {cam}` (a fake `command` that answers `GetPtzPreset`/`SetPtzPreset`; `log.latest('e1','ptz-positions')` is set); `halt sends Stop only while a move is leased`.
  - `camera-worker.test.ts`: `stopParts sends Stop while a move is leased`. Use the default sim: `w.ptz.lease.move(async () => undefined, 2000)`, then `await w.stop()`, then expect the sim's call log to contain `PtzCtrl` `Stop` (the RLC-1224A sim answers it with an error; `halt` swallows it). If the released cam-sim exposes no call log, spy on `w.client.command` instead.
- [ ] **Step 2: Run** `npx vitest run test/ptz-camera.test.ts test/camera-worker.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces block.
- [ ] **Step 4: Run** `npm test && npm run lint:types` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/ptz/camera-ptz.ts src/cameras/worker.ts src/stream/log.ts test/ptz-camera.test.ts test/camera-worker.test.ts && git commit -m "feat: PTZ side per camera worker"`

---

### Task 8: The PTZ API, audit and openapi

**Files:**
- Create: `src/api/ptz-api.ts`
- Modify: `src/proxy.ts:1139-1143` (mount before `clientApi`, same `requireAccess('client', access)`)
- Modify: `src/audit/actions.ts` (append `'ptz-position'` after `'composition'`), `docs/audit-log.md` (a row), `test/audit-actions.test.ts` (a case)
- Modify: `openapi.yaml` (nine paths below, schemas `PtzPosition`, `PtzPositionList`, the errors, SSE type `ptz-positions`)
- Test: `test/ptz-api.test.ts` (supertest on an Express app with `ptzApi` and a fake registry and worker; no cam-sim)

**Interfaces:**
- Consumes: `CameraWorker.capabilities()`, `CameraWorker.ptz` (Tasks 2, 7), `PtzError` (Task 6), `cameraParam`/`workerOf`, `bad`, `clientIp`, `withCamera`.
- Produces: `export function ptzApi(d: { cameras: CameraRegistry; audit: Pick<AuditLog, 'write'> }): express.Router` with:

| Route | Body | Answer |
|---|---|---|
| `POST /cameras/:cam/ptz/move` | `{direction, speed?, durationMs?}` | 204 |
| `POST /cameras/:cam/ptz/zoom` | `{direction: in\|out, durationMs?}` | 204 |
| `POST /cameras/:cam/ptz/focus` | `{direction: near\|far, durationMs?}` | 204 |
| `POST /cameras/:cam/ptz/stop` | — | 204 |
| `GET /cameras/:cam/ptz/positions` | — | 200 `{max, positions}` |
| `POST /cameras/:cam/ptz/positions` | `{name}` | 201 position |
| `PUT /cameras/:cam/ptz/positions/order` | `{ids}` | 200 `{max, positions}` |
| `PATCH /cameras/:cam/ptz/positions/:id` | `{name?, home?}` | 200 position |
| `POST /cameras/:cam/ptz/positions/:id/save` | — | 200 position |
| `POST /cameras/:cam/ptz/positions/:id/go` | — | 204 |
| `DELETE /cameras/:cam/ptz/positions/:id` | — | 204 |

(`/positions/order` is registered before `/positions/:id`.)

Gate, in this order, for every route: `capabilities()` null → 503 `camera_offline`; `ptz` null → 404 `not_supported`; zoom without `ptz.zoom`, focus without `ptz.focus`, positions routes without `ptz.positions` → 404 `not_supported`; moves with the camera offline → 503. Validation answers `bad(res, detail)`: unknown direction; `speed`/`durationMs` not an integer in range; PATCH with neither field, or `home` other than `true` (`home: false` → 400 `home is only ever set to true`). Errors: `PtzError` → its status and `{error: code}`; `CameraError` `camera_offline` → 503, any other → 502 `camera_error`.

Audit, on success and on 502 only (400/404/409/503 write nothing), through `withCamera(d.audit, w.id)`: `action: 'ptz-position'`, `category: ['configuration']`, `type: ['creation']` (save), `['deletion']` (delete), else `['change']`; `user` `admin` or `client` as `compose-api.ts:119-130` does; `ip`, `userAgent`; `details: { op, id, name, requestedBy }` (`op` ∈ save, resave, rename, home, order, delete; rename adds `from`; `order` adds `ids`); message like `PTZ position "Gate" saved`. Never a slot id.

- [ ] **Step 1: Write the failing tests** (`ptz-api.test.ts`; the fake worker's `ptz` records calls, its `capabilities()` is settable):

```ts
it('a camera without ptz: every PTZ route 404 not_supported', …);
it('capabilities not read yet: 503 camera_offline', …);
it('move defaults: speed 5, durationMs 400 → lease.move(…, 400) with camera speed 29', …);
it.each([[{ direction: 'north' }], [{ direction: 'left', speed: 0 }], [{ direction: 'left', speed: 11 }], [{ direction: 'left', speed: 2.5 }], [{ direction: 'left', durationMs: 99 }], [{ direction: 'left', durationMs: 2001 }]])('move %j → 400', …);
it('focus on a camera without focus → 404 not_supported', …);
it('offline move → 503 camera_offline; camera refusal → 502 camera_error', …);
it('positions: 201 on save; PtzError codes pass through (409 limit_reached …)', …);
it('PATCH home:false → 400; {} → 400', …);
it('PUT order is not taken as an :id', …);
it('audit: save writes ptz-position op save with the camera label; a 409 writes nothing; no slot in details', …);
it('no response or error carries Reolink terms', () => { /* every body in this file: no /PtzCtrl|ToPos|slot|preset/i */ });
```

  `audit-actions.test.ts`: add `'ptz-position'` to the "includes" list.
- [ ] **Step 2: Run** `npx vitest run test/ptz-api.test.ts test/audit-actions.test.ts test/openapi.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the router and mount it. Add the audit action and its `docs/audit-log.md` row (user `client` or `admin`; `op`, `id`, `name`, `from`, `ids`, `requestedBy`; a failure has `error.message` `camera_error`; 400/404/409/503 write nothing). Document all eleven operations and the `ptz-positions` SSE type in `openapi.yaml`.
- [ ] **Step 4: Run** `npm test && npm run lint:types` — Expected: PASS (`openapi.test.ts`, `auth-managed-routes.test.ts`: the new routes are `/api`, so the managed admin list is unchanged).
- [ ] **Step 5: Commit**

```bash
git add src/api/ptz-api.ts src/proxy.ts src/audit/actions.ts docs/audit-log.md openapi.yaml test/ptz-api.test.ts test/audit-actions.test.ts
git commit -m "feat: PTZ API under /api/cameras/:cam/ptz"
```

---

### Task 9: Integration against cam-sim's E1 Outdoor Pro

**Ordering dependency:** this task starts only after cam-sim has **released** the E1 profile (plan A). Until then Tasks 1–8 and 10 stand on stubs and the default-model sim.

**Files:**
- Modify: `package.json` / `package-lock.json` (the `cam-sim` tarball URL → the release with the E1 profile; `npm install`)
- Modify: `test/helpers/sim.ts` (`startSim({ model? })` passes `model` to `createCamSim`; export `E1_MODEL = 'E1-Outdoor-Pro' as const` (cam-sim's model id, same style as `RLC-1224A`/`CX820`); `startSim` also takes `faults?: FaultSpec[]`)
- Test: `test/ptz-integration.test.ts`

**Interfaces:**
- Consumes: the whole stack; cam-sim's `createCamSim({ users, model: 'E1-Outdoor-Pro' })`; its state through `sim.sim.engine.ptz?.view()` (type `PtzView`, exported by cam-sim): `{ pan, tilt, zoom, focus, moving, presets: [{ id, name, pan, tilt, zoom }] }` (the same as `GET /sim/api/ptz`); `POST /sim/api/reset`; faults `settings.fail` / `settings.ignore` with `cmds: ['SetPtzPreset']`.

- [ ] **Step 1: Write the failing tests** (`startSim({ model: E1_MODEL })` + `startProxy`, client token; a second sim with the default model for the fixed camera):
  - `GET /api/cameras/cam1 has the E1 capabilities` (`ptz.positions.max` 20, `features` contains `ptz`); the default sim: `ptz: null`, and `POST …/ptz/move` → 404 `not_supported`.
  - `a move turns the camera and stops by itself`: `move` right, `durationMs` 300; `view().pan` changes; within 600 ms `view().moving` is false.
  - `hold: moves every 250 ms keep it turning; stop ends it at once` (`moving` true during the hold, false right after `stop`).
  - `zoom in changes the zoom` (`view().zoom` grows).
  - `SetPtzPreset refused or ignored by the camera → 502 camera_error, no position stored` (`faults: [{ name: 'settings.fail', cmds: ['SetPtzPreset'] }]`, then `settings.ignore`).
  - `save, move away, go back`: save "Gate" (201, home); move left 500 ms; `go` → 204; `view()` pan/tilt/zoom equal the saved ones (the preset entry in `view().presets`).
  - `a foreign preset is never touched`: write slot 0 as `admin` straight to the sim (`new ReolinkClient({ id: 'x', host: sim.camera.host, protocol: 'http', user: 'admin', password: 'admin-pw' }).command('SetPtzPreset', …)`); save → `view().presets` has our name at id 1; delete → id 1 gone, id 0 still the foreign one.
  - `a reset camera shows missing; go → 409 position_missing; save again → ok`: `POST /sim/api/reset`, then restart the camera side (`POST /control/cameras/cam1/actions/restart`, admin token) so the slot cache is dropped when the camera is online again; `GET positions` shows `missing`.
  - `the stream sends ptz-positions on save` (`test/helpers/sse.ts`).
  - `a managed client token may move` (tokens.json with a `kind: 'client'` token, as `test/auth-managed.test.ts:52`).
- [ ] **Step 2: Run** `npx vitest run test/ptz-integration.test.ts` — Expected: FAIL only where the stack is wrong. Fix the stack, not the expectations, unless the sim's measured behaviour says otherwise.
- [ ] **Step 3: Run** `npm test && npm run lint:types` — Expected: PASS.
- [ ] **Step 4: Commit** `git add package.json package-lock.json test/helpers/sim.ts test/ptz-integration.test.ts && git commit -m "test: PTZ against cam-sim's E1 Outdoor Pro"`

---

### Task 10: Real-camera check script, README, CHANGELOG

**Files:**
- Create: `scripts/ptz-real-check.sh` (executable)
- Modify: `README.md` (new section `## PTZ (pan, tilt, zoom)` after `## Client API`; the camera list example gains `capabilities` and `"features":["sse-cam-list","ptz"]`; `## Event stream (SSE)` lists `ptz-positions`)
- Modify: `CHANGELOG.md` (`## Unreleased`)
- Test: `test/ptz-real-check.test.ts` (runs the script against an in-process proxy + E1 sim; only after Task 9's dependency bump, else `it.skip` with the reason until then)

**Interfaces:**
- Script usage: `CAMPROXY_URL=http://<proxy>:8480 CAMPROXY_TOKEN=… scripts/ptz-real-check.sh <cam>`. It needs `bash`, `curl`, `node`. The token goes to curl only through a header file made with `mktemp` (mode 600, removed by the trap), never on a command line, in output or in `set -x`. JSON is read with `node -e`. It prints one `ok …`/`FAIL …` line per step and exits non-zero on the first failure.

Steps of the script (spec §8.3):
1. `GET /api/cameras/<cam>`: `capabilities.ptz` non-null, camera online; else exit 2 "not a PTZ camera / offline".
2. `GET …/positions`: at least two places free below `max`, else exit 2 (it never deletes anything it did not create).
3. Save `ptz-check start <unix s>` → `START` (the view to restore, zoom included).
4. Each of the 8 directions for 400 ms at speed 5, 700 ms apart; zoom in 400 ms, zoom out 400 ms; focus far and near when `ptz.focus` (printing nothing about focus direction beyond "sent"); `stop`.
5. Save `ptz-check test` → `TEST`; move left 1500 ms; `go TEST` → 204; rename `TEST` to `ptz-check renamed`, the list shows it; `DELETE TEST` → 204, the list no longer has it; save `ptz-check again` → 201 (a slot is free again), delete it.
6. `go START`, wait 3 s, `DELETE START`.
7. `trap … EXIT`: best effort `stop`, then `go START` and delete every position this run created that still exists, then remove the header file. If `START` became Home (the camera had no positions), the others are deleted first so the last delete is allowed.

- [ ] **Step 1: Write the failing test** `test/ptz-real-check.test.ts`: spawn the script with `CAMPROXY_URL` = the test proxy, `CAMPROXY_TOKEN` = `CLIENT_TOKEN`; expect exit 0, every line `ok`, the output not containing the token, and afterwards the positions list equal to the one before.
- [ ] **Step 2: Run** `npx vitest run test/ptz-real-check.test.ts` — Expected: FAIL (no script).
- [ ] **Step 3: Write the script.** README section: what `capabilities` is, the eleven routes with one-line bodies and answers, the lease rule (a tap is one call; hold = a move every ~250 ms with `durationMs` 600, then `stop`; a lost client stops the camera within 2 s), positions (max 20, Home rules, names, `missing` and how to fix it with save), the 404/409/502/503 codes, the `ptz-positions` message, and the script's usage, noting the camera moves while it runs. CHANGELOG `## Unreleased`: one entry for capabilities and PTZ in user terms (capability list per camera; PTZ API with positions; works with the E1 Outdoor Pro; the real-camera check script).
- [ ] **Step 4: Run** `npm test && npm run lint:types && bash -n scripts/ptz-real-check.sh` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add scripts/ptz-real-check.sh test/ptz-real-check.test.ts README.md CHANGELOG.md
git commit -m "feat: PTZ real-camera check script; docs"
```

Running the script against the real E1 (on the Pi's proxy) is by hand, by Klaus or with his OK, after the release; it is not part of CI.
