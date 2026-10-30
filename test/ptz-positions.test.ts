import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { listPositions } from '../src/catalog/ptz-positions';
import { presetName, PRESET_SLOTS, type PresetSlot, type ReolinkPtz } from '../src/camera/ptz';
import { MoveLease } from '../src/ptz/lease';
import { checkName, freeSlot, positionState, PtzError, PtzPositions } from '../src/ptz/positions';

// A camera of 64 preset slots in memory.
class FakeCam {
  slots: PresetSlot[] = Array.from({ length: PRESET_SLOTS }, (_, id) => ({ id, enabled: false, name: `pos${id + 1}` }));
  calls: string[] = [];
  keepsName = true;
  reads = 0;
  async presets(): Promise<PresetSlot[]> {
    this.reads++;
    return this.slots.map((s) => ({ ...s }));
  }
  async savePreset(slot: number, name: string): Promise<void> {
    this.calls.push(`save ${slot}`);
    this.slots[slot] = { id: slot, enabled: true, name: this.keepsName ? presetName(name) : `pos${slot + 1}` };
  }
  async clearPreset(slot: number): Promise<void> {
    this.calls.push(`clear ${slot}`);
    this.slots[slot] = { id: slot, enabled: false, name: '' };
  }
  async goTo(slot: number): Promise<void> {
    this.calls.push(`goto ${slot}`);
  }
  async stop(): Promise<void> {
    this.calls.push('stop');
  }
  foreign(id: number, name: string) {
    this.slots[id] = { id, enabled: true, name };
  }
  clear(id: number) {
    this.slots[id] = { id, enabled: false, name: '' };
  }
  slot(id: number) {
    return this.slots[id];
  }
  enabledIds() {
    return this.slots.filter((s) => s.enabled).map((s) => s.id);
  }
}

const slotsWith = (named: Record<number, string>): PresetSlot[] => Array.from({ length: PRESET_SLOTS }, (_, id) => ({ id, enabled: id in named, name: named[id] ?? '' }));

let catalog: Catalog;
let cam: FakeCam;
let online: boolean;
let now: number;
let changes: number;
let lease: MoveLease;
let svc: PtzPositions;

beforeEach(() => {
  catalog = openCatalog(join(mkdtempSync(join(tmpdir(), 'camproxy-ptzpos-')), 'catalog.sqlite'));
  cam = new FakeCam();
  online = true;
  now = 1_000_000;
  changes = 0;
  lease = new MoveLease({ stop: () => cam.stop() });
  svc = new PtzPositions({ cam: 'e1', catalog, ptz: cam as unknown as ReolinkPtz, lease, online: () => online, changed: () => void changes++, now: () => now });
});
afterEach(() => catalog.close());

const rejects = async (p: Promise<unknown>, status: number, code: string) => expect(p).rejects.toMatchObject({ status, code });

describe('helpers', () => {
  it('freeSlot skips enabled and owned slots', () => expect(freeSlot(slotsWith({ 0: 'Garden' }), [1])).toBe(2));
  it('freeSlot: none left → null', () => {
    expect(freeSlot(slotsWith(Object.fromEntries(Array.from({ length: 63 }, (_, i) => [i, 'x']))), [63])).toBeNull();
  });
  it('positionState: ok only with the slot enabled under our name', () => {
    expect(positionState({ slot: 1, preset_name: 'Gate' }, slotsWith({ 1: 'Gate' }))).toBe('ok');
    expect(positionState({ slot: 1, preset_name: 'Gate' }, slotsWith({ 1: 'Other' }))).toBe('missing');
    expect(positionState({ slot: 1, preset_name: 'Gate' }, slotsWith({}))).toBe('missing');
  });
  it('checkName', () => {
    expect(checkName('  Gate ')).toBe('Gate');
    for (const bad of ['', '   ', 'x'.repeat(41), 'a\nb', 'a\u0007b', 7, null]) expect(() => checkName(bad)).toThrow(PtzError);
    expect(checkName('ä'.repeat(40))).toHaveLength(40);
  });
});

describe('PtzPositions', () => {
  it('first save is Home in slot 0; a foreign preset in slot 0 is skipped', async () => {
    cam.foreign(0, 'Garden');
    const p = await svc.save('Gate');
    expect(p).toMatchObject({ name: 'Gate', order: 0, home: true, state: 'ok' });
    expect(p.id).toMatch(/^pos_[0-9a-f]{16}$/);
    expect(cam.slot(1)).toEqual({ id: 1, enabled: true, name: 'Gate' });
    expect(cam.slot(0).name).toBe('Garden');
    const q = await svc.save('Tree');
    expect(q).toMatchObject({ order: 1, home: false });
    expect(Object.keys(p).sort()).toEqual(['home', 'id', 'name', 'order', 'state']);
  });

  it('names: trimmed, 1–40, unique ignoring case, no control characters', async () => {
    expect((await svc.save(' gate ')).name).toBe('gate');
    await rejects(svc.save('GATE'), 409, 'name_taken');
    await rejects(svc.save(''), 400, 'invalid');
    await rejects(svc.save('x'.repeat(41)), 400, 'invalid');
    await rejects(svc.save('a\nb'), 400, 'invalid');
    const t = await svc.save('Tree');
    await rejects(svc.rename(t.id, 'Gate'), 409, 'name_taken');
    expect((await svc.rename(t.id, 'TREE')).name).toBe('TREE');
    expect(changes).toBe(3);
  });

  it('a 40-character umlaut name saves and reads back ok', async () => {
    let name = 'Einfahrt Süd – Tor Ö Ä Ü ß 🌳 Gärten';
    while ([...name].length < 40) name += 'ö';
    expect([...name]).toHaveLength(40);
    const p = await svc.save(name);
    expect(p.state).toBe('ok');
    expect(p.name).toBe(name);
    expect(Buffer.byteLength(cam.slot(0).name)).toBeLessThanOrEqual(31);
  });

  it("a camera that doesn't keep the name → 502, nothing stored", async () => {
    cam.keepsName = false;
    await expect(svc.save('Gate')).rejects.toMatchObject({ code: 'camera_error' });
    expect(listPositions(catalog, 'e1')).toEqual([]);
    expect(changes).toBe(0);
  });

  it('concurrent saves get different slots; the 21st is limit_reached', async () => {
    const r = await Promise.allSettled(Array.from({ length: 21 }, (_, i) => svc.save(`P${i}`)));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(20);
    expect((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 409, code: 'limit_reached' });
    expect(new Set(cam.enabledIds()).size).toBe(20);
    expect(listPositions(catalog, 'e1').filter((x) => x.home === 1)).toHaveLength(1);
  });

  it('no free slot → 409 no_free_slot', async () => {
    for (let i = 0; i < PRESET_SLOTS; i++) cam.foreign(i, `app ${i}`);
    await rejects(svc.save('Gate'), 409, 'no_free_slot');
  });

  it('offline: save → 503 camera_offline', async () => {
    online = false;
    await rejects(svc.save('Gate'), 503, 'camera_offline');
  });

  it('missing: slot emptied on the camera, or holding another name', async () => {
    const a = await svc.save('Gate');
    const b = await svc.save('Tree');
    cam.clear(0);
    cam.foreign(1, 'Other');
    now += 31_000;
    const l = await svc.list();
    expect(l.max).toBe(20);
    expect(l.positions.map((p) => [p.id, p.state])).toEqual([[a.id, 'missing'], [b.id, 'missing']]);
  });

  it('list uses a read at most 30 s old; offline uses the last read; never read + offline → 503', async () => {
    await svc.save('Gate');
    const reads = cam.reads;
    await svc.list();
    expect(cam.reads).toBe(reads);
    now += 31_000;
    await svc.list();
    expect(cam.reads).toBe(reads + 1);
    cam.clear(0);
    online = false;
    now += 3600_000;
    expect((await svc.list()).positions[0].state).toBe('ok');
    svc.invalidate();
    await rejects(svc.list(), 503, 'camera_offline');
  });

  it('list without positions needs no camera', async () => {
    online = false;
    expect(await svc.list()).toEqual({ max: 20, positions: [] });
  });

  it('resave fixes a missing position in its own empty slot', async () => {
    const p = await svc.save('Gate');
    cam.clear(0);
    const r = await svc.resave(p.id);
    expect(r.state).toBe('ok');
    expect(cam.slot(0)).toEqual({ id: 0, enabled: true, name: 'Gate' });
    expect(listPositions(catalog, 'e1')[0].slot).toBe(0);
  });

  it('resave moves off a foreign slot', async () => {
    const p = await svc.save('Gate');
    cam.foreign(0, 'Other');
    const r = await svc.resave(p.id);
    expect(r.state).toBe('ok');
    expect(cam.slot(0)).toEqual({ id: 0, enabled: true, name: 'Other' });
    expect(cam.slot(1)).toEqual({ id: 1, enabled: true, name: 'Gate' });
    expect(listPositions(catalog, 'e1')[0].slot).toBe(1);
  });

  it('resave after a rename writes the new name', async () => {
    const p = await svc.save('Gate');
    await svc.rename(p.id, 'Front gate');
    expect(cam.slot(0).name).toBe('Gate');
    expect((await svc.resave(p.id)).state).toBe('ok');
    expect(cam.slot(0).name).toBe('Front gate');
    expect(listPositions(catalog, 'e1')[0].preset_name).toBe('Front gate');
  });

  it('delete clears our slot; delete leaves a foreign slot alone', async () => {
    const a = await svc.save('Gate');
    const b = await svc.save('Tree');
    await svc.remove(b.id);
    expect(cam.slot(1).enabled).toBe(false);
    expect(cam.calls).toContain('clear 1');
    cam.foreign(0, 'Other');
    await svc.remove(a.id);
    expect(cam.slot(0)).toEqual({ id: 0, enabled: true, name: 'Other' });
    expect(cam.calls.filter((c) => c.startsWith('clear'))).toEqual(['clear 1']);
    expect(listPositions(catalog, 'e1')).toEqual([]);
  });

  it('delete: a camera that keeps the preset → 502 and the row stays', async () => {
    const a = await svc.save('Gate');
    cam.clearPreset = async () => undefined;
    await expect(svc.remove(a.id)).rejects.toMatchObject({ code: 'camera_error' });
    expect(listPositions(catalog, 'e1')).toHaveLength(1);
  });

  it('Home: delete refused while others exist (home_position); the last one may go', async () => {
    const a = await svc.save('Gate');
    const b = await svc.save('Tree');
    await rejects(svc.remove(a.id), 409, 'home_position');
    await svc.remove(b.id);
    await svc.remove(a.id);
    expect(listPositions(catalog, 'e1')).toEqual([]);
  });

  it('makeHome moves the mark; reorder needs every id once', async () => {
    const a = await svc.save('Gate');
    const b = await svc.save('Tree');
    const c = await svc.save('Door');
    expect((await svc.makeHome(b.id)).home).toBe(true);
    expect((await svc.list()).positions.map((p) => p.home)).toEqual([false, true, false]);
    for (const bad of [[a.id, b.id], [a.id, b.id, b.id], [a.id, b.id, 'pos_x'], 'x', null, [a.id, b.id, c.id, c.id]]) await rejects(svc.reorder(bad), 400, 'invalid');
    const r = await svc.reorder([c.id, a.id, b.id]);
    expect(r.map((p) => [p.id, p.order])).toEqual([[c.id, 0], [a.id, 1], [b.id, 2]]);
  });

  it('rename/Home/order offline: the last read; with none → 503 and nothing changed', async () => {
    const a = await svc.save('Gate');
    online = false;
    expect((await svc.rename(a.id, 'Gate 2')).state).toBe('ok');
    svc.invalidate();
    await rejects(svc.rename(a.id, 'Gate 3'), 503, 'camera_offline');
    await rejects(svc.makeHome(a.id), 503, 'camera_offline');
    await rejects(svc.reorder([a.id]), 503, 'camera_offline');
    expect(listPositions(catalog, 'e1')[0].name).toBe('Gate 2');
  });

  it('unknown id → 404 not_found', async () => {
    for (const p of [svc.resave('pos_x'), svc.rename('pos_x', 'A'), svc.makeHome('pos_x'), svc.remove('pos_x'), svc.goTo('pos_x')]) await rejects(p, 404, 'not_found');
  });

  it('goTo a missing position → 409 position_missing and no ToPos sent', async () => {
    const a = await svc.save('Gate');
    cam.clear(0);
    svc.invalidate();
    await rejects(svc.goTo(a.id), 409, 'position_missing');
    expect(cam.calls.filter((c) => c.startsWith('goto'))).toEqual([]);
  });

  it('goTo offline → 503', async () => {
    const a = await svc.save('Gate');
    online = false;
    await rejects(svc.goTo(a.id), 503, 'camera_offline');
  });

  it('goTo runs through the lease (Stop first while a move is active)', async () => {
    const a = await svc.save('Gate');
    await lease.move(async () => void cam.calls.push('move'), 2000);
    await svc.goTo(a.id);
    expect(cam.calls.slice(-3)).toEqual(['move', 'stop', 'goto 0']);
    expect(lease.active()).toBe(false);
  });

  it('each change calls changed() once; a refused one not at all', async () => {
    const a = await svc.save('Gate');
    const b = await svc.save('Tree');
    expect(changes).toBe(2);
    await svc.rename(a.id, 'Gate 2');
    await svc.makeHome(b.id);
    await svc.reorder([b.id, a.id]);
    await svc.resave(a.id);
    expect(changes).toBe(6);
    await rejects(svc.remove(b.id), 409, 'home_position');
    await rejects(svc.save('tree'), 409, 'name_taken');
    expect(changes).toBe(6);
    await svc.remove(a.id);
    await svc.goTo(b.id);
    expect(changes).toBe(7);
  });
});
