// Saved PTZ positions of one camera (spec 2026-10-30-ptz-capabilities-design
// §5.2, §6): rows in the catalog, each in a camera preset slot the proxy
// wrote. A slot enabled on the camera that no row owns (someone's Reolink-app
// preset) is never written or cleared; a position whose slot no longer holds
// the name the proxy wrote is `missing` and is never re-created by itself.
import { randomBytes } from 'crypto';
import { POSITIONS_MAX } from '../camera/capabilities';
import { CameraError } from '../camera/client';
import { presetName, PRESET_SLOTS, type PresetSlot, type ReolinkPtz } from '../camera/ptz';
import type { Catalog } from '../catalog/db';
import { deletePosition, insertPosition, listPositions, positionById, setHomePosition, setPositionOrder, updatePosition, type PtzPositionRow } from '../catalog/ptz-positions';
import type { MoveLease } from './lease';

export type PositionState = 'ok' | 'missing';
export interface PtzPositionJson { id: string; name: string; order: number; home: boolean; state: PositionState }

// A refusal in the client API's terms (never a slot or a Reolink name).
export class PtzError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const NAME_MAX = 40;

export function positionState(row: Pick<PtzPositionRow, 'slot' | 'preset_name'>, slots: PresetSlot[]): PositionState {
  const s = slots.find((x) => x.id === row.slot);
  return s?.enabled && s.name === row.preset_name ? 'ok' : 'missing';
}

// The lowest slot neither enabled on the camera nor owned by a row.
export function freeSlot(slots: PresetSlot[], owned: number[]): number | null {
  for (let id = 0; id < PRESET_SLOTS; id++) {
    if (owned.includes(id)) continue;
    if (slots.some((s) => s.id === id && s.enabled)) continue;
    return id;
  }
  return null;
}

// Trimmed, 1–40 characters, no control characters.
export function checkName(raw: unknown): string {
  if (typeof raw !== 'string') throw new PtzError(400, 'invalid', 'name must be a string');
  const name = raw.trim();
  const n = [...name].length;
  if (n < 1 || n > NAME_MAX) throw new PtzError(400, 'invalid', `name must be 1 to ${NAME_MAX} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new PtzError(400, 'invalid', 'name must not contain control characters');
  return name;
}

export interface PositionsDeps {
  cam: string;
  catalog: Catalog;
  ptz: ReolinkPtz;
  lease: MoveLease;
  online: () => boolean;
  changed: () => void; // append the ptz-positions stream message
  now?: () => number;
  cacheMs?: number; // default 30_000
}

const noop = () => undefined;
const OFFLINE = () => new PtzError(503, 'camera_offline');
const NOT_FOUND = () => new PtzError(404, 'not_found');

export class PtzPositions {
  private chain: Promise<unknown> = Promise.resolve();
  private cache: { at: number; slots: PresetSlot[] } | undefined;
  private readonly now: () => number;

  constructor(private readonly d: PositionsDeps) {
    this.now = d.now ?? Date.now;
  }

  // Changes and go one at a time (two viewers saving at once get distinct
  // slots; a go never races a delete).
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.then(noop, noop);
    return p;
  }

  // The camera's slots: fresh, or a read at most cacheMs old; offline the last
  // read of any age, none → 503.
  private async slots(fresh: boolean): Promise<PresetSlot[]> {
    if (!this.d.online()) {
      if (fresh || !this.cache) throw OFFLINE();
      return this.cache.slots;
    }
    if (!fresh && this.cache && this.now() - this.cache.at <= (this.d.cacheMs ?? 30_000)) return this.cache.slots;
    const slots = await this.d.ptz.presets();
    this.cache = { at: this.now(), slots };
    return slots;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  private rows(): PtzPositionRow[] {
    return listPositions(this.d.catalog, this.d.cam);
  }

  private row(id: string): PtzPositionRow {
    const r = positionById(this.d.catalog, this.d.cam, id);
    if (!r) throw NOT_FOUND();
    return r;
  }

  private json(r: PtzPositionRow, slots: PresetSlot[]): PtzPositionJson {
    return { id: r.id, name: r.name, order: r.sort_order, home: r.home === 1, state: positionState(r, slots) };
  }

  private nameTaken(name: string, except?: string): boolean {
    const n = name.toLowerCase();
    return this.rows().some((r) => r.id !== except && r.name.toLowerCase() === n);
  }

  // Writes the preset and reads it back; a camera that didn't keep it is a camera error.
  private async write(slot: number, name: string): Promise<PresetSlot[]> {
    await this.d.ptz.savePreset(slot, name);
    const slots = await this.slots(true);
    if (positionState({ slot, preset_name: presetName(name) }, slots) !== 'ok') throw new CameraError('camera_error', 'the camera did not keep the preset');
    return slots;
  }

  // A position's stored name (for audit records); no camera read.
  name(id: string): string | undefined {
    return positionById(this.d.catalog, this.d.cam, id)?.name;
  }

  async list(): Promise<{ max: number; positions: PtzPositionJson[] }> {
    const rows = this.rows();
    if (rows.length === 0) return { max: POSITIONS_MAX, positions: [] };
    const slots = await this.slots(false);
    return { max: POSITIONS_MAX, positions: rows.map((r) => this.json(r, slots)) };
  }

  // A new position where the camera points now.
  save(raw: unknown): Promise<PtzPositionJson> {
    return this.lock(async () => {
      const name = checkName(raw);
      if (this.nameTaken(name)) throw new PtzError(409, 'name_taken');
      const rows = this.rows();
      if (rows.length >= POSITIONS_MAX) throw new PtzError(409, 'limit_reached');
      if (!this.d.online()) throw OFFLINE();
      const slot = freeSlot(await this.slots(true), rows.map((r) => r.slot));
      if (slot === null) throw new PtzError(409, 'no_free_slot');
      const slots = await this.write(slot, name);
      const t = this.now();
      const row: PtzPositionRow = { id: `pos_${randomBytes(8).toString('hex')}`, cam: this.d.cam, name, sort_order: rows.length, home: rows.length === 0 ? 1 : 0, slot, preset_name: presetName(name), created_at: t, updated_at: t };
      insertPosition(this.d.catalog, row);
      this.d.changed();
      return this.json(row, slots);
    });
  }

  // Overwrites a position with where the camera points now (also the fix for
  // a missing one). Its slot is kept unless someone else's preset took it.
  resave(id: string): Promise<PtzPositionJson> {
    return this.lock(async () => {
      const row = this.row(id);
      if (!this.d.online()) throw OFFLINE();
      const current = await this.slots(true);
      const own = current.find((s) => s.id === row.slot);
      let slot: number | null = row.slot;
      if (own?.enabled && own.name !== row.preset_name) slot = freeSlot(current, this.rows().map((r) => r.slot));
      if (slot === null) throw new PtzError(409, 'no_free_slot');
      const slots = await this.write(slot, row.name);
      updatePosition(this.d.catalog, this.d.cam, id, { slot, preset_name: presetName(row.name), updated_at: this.now() });
      this.d.changed();
      return this.json(this.row(id), slots);
    });
  }

  // Rename, Home and order change the catalog only (re-sending the preset
  // would also re-save the view). Their answer carries each state, so the
  // slots are read first: offline with no read at all → 503, nothing changed
  // (a state is never guessed).
  rename(id: string, raw: unknown): Promise<PtzPositionJson> {
    return this.lock(async () => {
      this.row(id);
      const name = checkName(raw);
      if (this.nameTaken(name, id)) throw new PtzError(409, 'name_taken');
      const slots = await this.slots(false);
      updatePosition(this.d.catalog, this.d.cam, id, { name, updated_at: this.now() });
      this.d.changed();
      return this.json(this.row(id), slots);
    });
  }

  makeHome(id: string): Promise<PtzPositionJson> {
    return this.lock(async () => {
      this.row(id);
      const slots = await this.slots(false);
      setHomePosition(this.d.catalog, this.d.cam, id, this.now());
      this.d.changed();
      return this.json(this.row(id), slots);
    });
  }

  reorder(ids: unknown): Promise<PtzPositionJson[]> {
    return this.lock(async () => {
      const rows = this.rows();
      const known = new Set(rows.map((r) => r.id));
      if (!Array.isArray(ids) || ids.length !== rows.length || new Set(ids).size !== ids.length || !ids.every((x) => typeof x === 'string' && known.has(x))) {
        throw new PtzError(400, 'invalid', 'ids must list every position of the camera once');
      }
      const slots = await this.slots(false);
      setPositionOrder(this.d.catalog, this.d.cam, ids as string[], this.now());
      this.d.changed();
      return this.rows().map((r) => this.json(r, slots));
    });
  }

  remove(id: string): Promise<void> {
    return this.lock(async () => {
      const row = this.row(id);
      if (row.home === 1 && this.rows().length > 1) throw new PtzError(409, 'home_position');
      if (!this.d.online()) throw OFFLINE();
      // Our preset is cleared; an empty slot or someone else's preset is left alone.
      if (positionState(row, await this.slots(true)) === 'ok') {
        await this.d.ptz.clearPreset(row.slot);
        if (positionState(row, await this.slots(true)) === 'ok') throw new CameraError('camera_error', 'the camera kept the preset');
      }
      deletePosition(this.d.catalog, this.d.cam, id);
      this.d.changed();
    });
  }

  // Under the lock and against a fresh read: never a travel to a slot that was
  // just cleared or taken over. Through the lease: a running move is stopped
  // first, and no Stop cuts the travel short.
  goTo(id: string): Promise<void> {
    return this.lock(async () => {
      const row = this.row(id);
      if (!this.d.online()) throw OFFLINE();
      if (positionState(row, await this.slots(true)) === 'missing') throw new PtzError(409, 'position_missing');
      await this.d.lease.then(() => this.d.ptz.goTo(row.slot));
    });
  }
}
