import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { StreamLog, STREAM_TYPES } from '../src/stream/log';
import { CameraPtz } from '../src/ptz/camera-ptz';
import type { Capabilities } from '../src/camera/capabilities';

const E1: Capabilities = { schema: 1, ptz: { move: true, zoom: true, focus: true, speed: true, positions: { max: 20 } } };

let catalog: Catalog | undefined;
afterEach(() => catalog?.close());

// A camera that answers the preset commands from 64 slots in memory.
function setup(caps: Capabilities | null = E1, failStops = 0) {
  catalog = openCatalog(join(mkdtempSync(join(tmpdir(), 'camproxy-ptzcam-')), 'catalog.sqlite'));
  const log = new StreamLog(catalog);
  const slots = Array.from({ length: 64 }, (_, id) => ({ channel: 0, id, enable: 0, name: `pos${id + 1}` }));
  const sent: [string, Record<string, unknown> | undefined][] = [];
  const command = async (cmd: string, param?: object) => {
    const p = param as Record<string, unknown> | undefined;
    sent.push([cmd, p]);
    if (cmd === 'GetPtzPreset') return { PtzPreset: slots.map((s) => ({ ...s })) };
    if (cmd === 'SetPtzPreset') {
      const x = (p as { PtzPreset: { id: number; enable: number; name: string } }).PtzPreset;
      slots[x.id] = { channel: 0, id: x.id, enable: x.enable, name: x.name };
    }
    if (cmd === 'PtzCtrl' && (p as { op: string }).op === 'Stop' && failStops > 0) {
      failStops--;
      throw new Error('refused');
    }
    return { rspCode: 200 };
  };
  const ptz = new CameraPtz({ cam: 'e1', command, capabilities: () => caps, online: () => true, catalog, log });
  return { ptz, log, sent };
}

describe('CameraPtz', () => {
  it('ptz-positions is a stream type', () => expect(STREAM_TYPES).toContain('ptz-positions'));

  it('a position change appends one ptz-positions message {cam}', async () => {
    const { ptz, log } = setup();
    expect(log.latest('e1', 'ptz-positions')).toBeUndefined();
    await ptz.positions.save('Gate');
    const m = log.latest('e1', 'ptz-positions');
    expect(m).toMatchObject({ cam: 'e1', type: 'ptz-positions', data: {} });
    expect(log.since(0, { types: ['ptz-positions'] }, 10)).toHaveLength(1);
  });

  it('moves send the camera speed only when the camera takes one', async () => {
    const a = setup();
    await a.ptz.camera.move('left', 5);
    expect(a.sent.at(-1)).toEqual(['PtzCtrl', { channel: 0, op: 'Left', speed: 29 }]);
    catalog!.close();
    const b = setup({ schema: 1, ptz: { move: true, zoom: false, focus: false, speed: false } });
    await b.ptz.camera.move('left', 5);
    expect(b.sent.at(-1)).toEqual(['PtzCtrl', { channel: 0, op: 'Left' }]);
  });

  it('the lease stops through the camera', async () => {
    const { ptz, sent } = setup();
    await ptz.lease.stop();
    expect(sent).toEqual([['PtzCtrl', { channel: 0, op: 'Stop' }]]);
  });

  it('halt sends Stop only while a move is leased', async () => {
    const { ptz, sent } = setup();
    await ptz.halt();
    expect(sent).toEqual([]);
    await ptz.lease.move(() => ptz.camera.move('up', 5), 2000);
    await ptz.halt();
    expect(sent.map(([, p]) => (p as { op: string }).op)).toEqual(['Up', 'Stop']);
    expect(ptz.lease.active()).toBe(false);
  });

  it('halt sends Stop while a failed timer Stop waits for its retry', async () => {
    const { ptz, sent } = setup(E1, 1);
    await ptz.lease.move(() => ptz.camera.move('up', 5), 100);
    const stops = () => sent.filter(([, p]) => (p as { op?: string }).op === 'Stop').length;
    const t0 = Date.now();
    while (stops() < 1 && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setImmediate(r));
    expect(ptz.lease.active()).toBe(false);
    await ptz.halt();
    expect(stops()).toBe(2);
  });

  it('halt swallows a refused Stop', async () => {
    const { ptz } = setup(E1, 99);
    await ptz.lease.move(async () => undefined, 2000);
    await expect(ptz.halt()).resolves.toBeUndefined();
  });
});
