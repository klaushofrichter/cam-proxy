import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditLog, type AuditInput } from '../src/audit/audit-log';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { StreamLog } from '../src/stream/log';
import { outagesFor, OUTAGE_MS } from '../src/inventory/gap-causes';

// The client API's outages (cams' blank thumbnails, 2026-11-03): the stills
// inventory's sources, as {cause, from, to} over a window.
const T = Date.UTC(2026, 10, 3, 15, 0); // 2026-11-03 09:00 CST
const MIN = 60_000;
const at = (m: number, s = 0) => T + m * MIN + s * 1000;

let dir: string;
let clock: number;
let audit: AuditLog;
let catalog: Catalog;
let log: StreamLog;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-gap-causes-'));
  clock = 0;
  audit = new AuditLog({ dir: join(dir, 'audit'), version: 't', now: () => clock });
  catalog = openCatalog(join(dir, 'catalog.sqlite'));
  log = new StreamLog(catalog, () => clock);
});
afterEach(() => {
  catalog.close();
  rmSync(dir, { recursive: true, force: true });
});

const write = (t: number, i: Partial<AuditInput> & { action: string }) => {
  clock = t;
  audit.write({ category: ['host'], type: ['change'], outcome: 'success', user: 'system', message: i.action, ...i });
};
const status = (t: number, cam: string, data: Record<string, unknown>) => {
  clock = t;
  log.append(cam, 'camera-status', data);
};
const run = (from: number, to: number, cam = 'cam1', now = at(120)) => outagesFor({ audit, catalog, cam, now }, from, to);

describe('outagesFor', () => {
  it('an empty log: nothing', async () => {
    expect(await run(at(0), at(60))).toEqual([]);
  });

  // cam4 on 2026-11-03: unplugged at 09:17:53, offline until it was readdressed at about 09:20.
  it('the camera offline, then its address changed: both, oldest first', async () => {
    status(at(18, 40), 'cam1', { online: false, reason: 'timeout', clockOffsetMs: null });
    status(at(18, 41), 'cam1', { online: false, stream: 'down', reason: 'no_frames', clockOffsetMs: null });
    write(at(20, 10), { action: 'camera-host-change', camera: 'cam1', type: ['change'], details: { from: '192.168.1.50', to: '10.1.0.50', outcome: 'changed' } });
    status(at(20, 25), 'cam1', { online: true, reason: null, clockOffsetMs: 0 });
    expect(await run(at(0), at(60))).toEqual([
      { cause: 'offline', from: at(18, 40), to: at(20, 25) },
      { cause: 'address', from: at(20, 10), to: at(20, 10) },
    ]);
  });

  it("another camera's records explain nothing; a host-wide proxy start does", async () => {
    status(at(5), 'cam2', { online: false, reason: 'timeout', clockOffsetMs: null });
    write(at(6), { action: 'camera-host-change', camera: 'cam2', details: { outcome: 'changed' } });
    write(at(10), { action: 'proxy-start', category: ['process'], type: ['start'], details: { previousStop: new Date(at(8)).toISOString(), uncleanStop: false } });
    expect(await run(at(0), at(60))).toEqual([{ cause: 'stop', from: at(8), to: at(10) }]);
  });

  it('a crash start is a moment; a refused address change or reboot is nothing', async () => {
    write(at(30), { action: 'proxy-start', category: ['process'], type: ['start'], details: { previousStop: null, uncleanStop: true } });
    write(at(31), { action: 'camera-host-change', camera: 'cam1', outcome: 'failure', details: { to: 'x' } });
    write(at(32), { action: 'camera-reboot', camera: 'cam1', outcome: 'failure', details: { phase: 'requested' } });
    expect(await run(at(0), at(60))).toEqual([{ cause: 'crash', from: at(30), to: at(30) }]);
  });

  it('a reboot to its end record; a power-cycle from its cut; one without an end lasts OUTAGE_MS', async () => {
    write(at(10), { action: 'camera-reboot', camera: 'cam1', details: { phase: 'requested', confirmed: true } });
    write(at(11), { action: 'camera-reboot', camera: 'cam1', type: ['end'], details: { phase: 'back', downSec: 60 } });
    write(at(20, 5), { action: 'camera-powercycle', camera: 'cam1', details: { phase: 'requested', offAt: at(20), onAt: at(20, 5) } });
    write(at(40), { action: 'camera-reboot', camera: 'cam1', details: { phase: 'requested', confirmed: true } });
    expect(await run(at(0), at(60))).toEqual([
      { cause: 'reboot', from: at(10), to: at(11) },
      { cause: 'powercycle', from: at(20), to: at(20) + OUTAGE_MS },
      { cause: 'reboot', from: at(40), to: at(40) + OUTAGE_MS },
    ]);
  });

  it('spans that began before the window or last past it; an open one has to null', async () => {
    status(at(-30), 'cam1', { online: false, reason: 'timeout', clockOffsetMs: null });
    status(at(5), 'cam1', { online: true, reason: null, clockOffsetMs: 0 });
    write(at(50), { action: 'storage-paused', category: ['host'] });
    status(at(55), 'cam1', { online: false, reason: 'timeout', clockOffsetMs: null });
    status(at(90), 'cam1', { online: true, reason: null, clockOffsetMs: 0 });
    expect(await run(at(0), at(60))).toEqual([
      { cause: 'offline', from: at(-30), to: at(5) },
      { cause: 'paused', from: at(50), to: null },
      { cause: 'offline', from: at(55), to: at(90) },
    ]);
    // A stop before the window, explained by a start after it.
    write(at(70), { action: 'proxy-start', category: ['process'], type: ['start'], details: { previousStop: new Date(at(58)).toISOString(), uncleanStop: false } });
    expect((await run(at(0), at(60))).map((o) => o.cause)).toEqual(['offline', 'paused', 'offline', 'stop']);
    // Outside the window: nothing.
    expect(await run(at(10), at(40))).toEqual([]);
  });
});
