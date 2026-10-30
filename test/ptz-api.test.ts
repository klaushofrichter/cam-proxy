import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ptzApi } from '../src/api/ptz-api';
import { CameraRegistry } from '../src/cameras/registry';
import type { CameraWorker } from '../src/cameras/worker';
import type { Capabilities } from '../src/camera/capabilities';
import { CameraError } from '../src/camera/client';
import { ReolinkPtz } from '../src/camera/ptz';
import { PtzError, type PtzPositionJson } from '../src/ptz/positions';
import type { AuditInput } from '../src/audit/audit-log';

const E1: Capabilities = { schema: 1, ptz: { move: true, zoom: true, focus: true, speed: true, positions: { max: 20 } } };
const FIXED: Capabilities = { schema: 1, ptz: null };

let caps: Capabilities | null;
let online: boolean;
let sent: [string, unknown][];
let leased: number[];
let stops: number;
let camFails: CameraError | undefined;
let calls: string[];
let posError: Error | undefined;
let audits: AuditInput[];
let bodies: string[];
let app: express.Express;

const pos = (o: Partial<PtzPositionJson> = {}): PtzPositionJson => ({ id: 'pos_0123456789abcdef', name: 'Gate', order: 0, home: true, state: 'ok', ...o });

function fakeWorker(): CameraWorker {
  const camera = new ReolinkPtz(async (cmd, param) => {
    sent.push([cmd, param]);
    if (camFails) throw camFails;
    return { rspCode: 200 };
  }, () => true);
  const call = <T>(name: string, v: T) => async (...args: unknown[]): Promise<T> => {
    calls.push(`${name} ${JSON.stringify(args)}`);
    if (posError) throw posError;
    return v;
  };
  return {
    id: 'e1',
    phase: () => 'ready',
    capabilities: () => caps,
    status: { state: () => ({ online, since: 0 }) },
    ptz: {
      camera,
      lease: {
        move: async (start: () => Promise<void>, ms: number) => (leased.push(ms), start()),
        stop: async () => (stops++, camera.stop()),
        active: () => false,
      },
      positions: {
        name: (id: string) => (id === 'pos_0123456789abcdef' ? 'Gate' : undefined),
        list: call('list', { max: 20, positions: [pos()] }),
        save: call('save', pos()),
        resave: call('resave', pos()),
        rename: call('rename', pos({ name: 'Front' })),
        makeHome: call('makeHome', pos()),
        reorder: call('reorder', [pos()]),
        remove: call('remove', undefined),
        goTo: call('goTo', undefined),
      },
    },
  } as unknown as CameraWorker;
}

beforeEach(() => {
  caps = E1;
  online = true;
  sent = [];
  leased = [];
  stops = 0;
  camFails = undefined;
  calls = [];
  posError = undefined;
  audits = [];
  bodies = [];
  const cams = new CameraRegistry(() => ['e1']);
  cams.add(fakeWorker());
  app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    const json = res.json.bind(res);
    res.json = (b: unknown) => (bodies.push(JSON.stringify(b)), json(b));
    next();
  });
  app.use('/api', ptzApi({ cameras: cams, audit: { write: (i) => (audits.push(i), null) } }));
});

const base = '/api/cameras/e1/ptz';
const ROUTES: [string, string, object?][] = [
  ['post', `${base}/move`, { direction: 'left' }],
  ['post', `${base}/zoom`, { direction: 'in' }],
  ['post', `${base}/focus`, { direction: 'far' }],
  ['post', `${base}/stop`],
  ['get', `${base}/positions`],
  ['post', `${base}/positions`, { name: 'Gate' }],
  ['put', `${base}/positions/order`, { ids: ['pos_0123456789abcdef'] }],
  ['patch', `${base}/positions/pos_0123456789abcdef`, { name: 'Front' }],
  ['post', `${base}/positions/pos_0123456789abcdef/save`],
  ['post', `${base}/positions/pos_0123456789abcdef/go`],
  ['delete', `${base}/positions/pos_0123456789abcdef`],
];
const send = (method: string, path: string, body?: object) => {
  const r = (request(app) as unknown as Record<string, (p: string) => request.Test>)[method](path);
  return body ? r.send(body) : r;
};

describe('PTZ API', () => {
  it('an unknown camera → 404', async () => {
    expect((await request(app).post('/api/cameras/zz/ptz/stop')).status).toBe(404);
  });

  it('a camera without ptz: every PTZ route 404 not_supported', async () => {
    caps = FIXED;
    for (const [m, p, b] of ROUTES) {
      const r = await send(m, p, b);
      expect([m, p, r.status, r.body]).toEqual([m, p, 404, { error: 'not_supported' }]);
    }
    expect(sent).toEqual([]);
  });

  it('capabilities not read yet: 503 camera_offline', async () => {
    caps = null;
    for (const [m, p, b] of ROUTES) expect((await send(m, p, b)).body).toEqual({ error: 'camera_offline' });
  });

  it('move defaults: speed 5, durationMs 400 → lease.move(…, 400) with camera speed 29', async () => {
    const r = await request(app).post(`${base}/move`).send({ direction: 'right-down' });
    expect(r.status).toBe(204);
    expect(leased).toEqual([400]);
    expect(sent).toEqual([['PtzCtrl', { channel: 0, op: 'RightDown', speed: 29 }]]);
    await request(app).post(`${base}/move`).send({ direction: 'up', speed: 10, durationMs: 2000 });
    expect(leased).toEqual([400, 2000]);
    expect(sent.at(-1)).toEqual(['PtzCtrl', { channel: 0, op: 'Up', speed: 64 }]);
  });

  it.each([[{}], [{ direction: 'north' }], [{ direction: 'left', speed: 0 }], [{ direction: 'left', speed: 11 }], [{ direction: 'left', speed: 2.5 }], [{ direction: 'left', speed: '5' }], [{ direction: 'left', durationMs: 99 }], [{ direction: 'left', durationMs: 2001 }]])('move %j → 400', async (b) => {
    const r = await request(app).post(`${base}/move`).send(b);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid');
    expect(sent).toEqual([]);
  });

  it('zoom and focus go through the lease; bad directions → 400', async () => {
    expect((await request(app).post(`${base}/zoom`).send({ direction: 'out', durationMs: 600 })).status).toBe(204);
    expect((await request(app).post(`${base}/focus`).send({ direction: 'near' })).status).toBe(204);
    expect(leased).toEqual([600, 400]);
    expect(sent.map(([, p]) => (p as { op: string }).op)).toEqual(['ZoomDec', 'FocusDec']);
    expect((await request(app).post(`${base}/zoom`).send({ direction: 'left' })).status).toBe(400);
    expect((await request(app).post(`${base}/focus`).send({ direction: 'in' })).status).toBe(400);
  });

  it('stop → 204 through the lease', async () => {
    expect((await request(app).post(`${base}/stop`)).status).toBe(204);
    expect(stops).toBe(1);
    expect(sent).toEqual([['PtzCtrl', { channel: 0, op: 'Stop' }]]);
  });

  it('focus on a camera without focus → 404 not_supported; zoom likewise; positions without positions', async () => {
    caps = { schema: 1, ptz: { move: true, zoom: false, focus: false, speed: true } };
    expect((await request(app).post(`${base}/focus`).send({ direction: 'far' })).body).toEqual({ error: 'not_supported' });
    expect((await request(app).post(`${base}/zoom`).send({ direction: 'in' })).body).toEqual({ error: 'not_supported' });
    expect((await request(app).get(`${base}/positions`)).body).toEqual({ error: 'not_supported' });
    expect((await request(app).post(`${base}/move`).send({ direction: 'left' })).status).toBe(204);
  });

  it('offline move → 503 camera_offline; camera refusal → 502 camera_error', async () => {
    online = false;
    for (const p of ['move', 'zoom', 'focus', 'stop']) {
      const r = await request(app).post(`${base}/${p}`).send({ direction: p === 'zoom' ? 'in' : p === 'focus' ? 'far' : 'left' });
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ error: 'camera_offline' });
    }
    online = true;
    camFails = new CameraError('camera_error', 'param error', true, -4);
    const r = await request(app).post(`${base}/move`).send({ direction: 'left' });
    expect([r.status, r.body]).toEqual([502, { error: 'camera_error' }]);
    camFails = new CameraError('camera_offline', 'timeout');
    expect((await request(app).post(`${base}/stop`)).status).toBe(503);
  });

  it('positions: 201 on save; PtzError codes pass through (409 limit_reached …)', async () => {
    const r = await request(app).post(`${base}/positions`).send({ name: 'Gate' });
    expect([r.status, r.body]).toEqual([201, pos()]);
    expect(calls).toEqual(['save ["Gate"]']);
    expect((await request(app).get(`${base}/positions`)).body).toEqual({ max: 20, positions: [pos()] });
    for (const [status, code] of [[409, 'limit_reached'], [409, 'no_free_slot'], [409, 'name_taken'], [404, 'not_found'], [503, 'camera_offline']] as const) {
      posError = new PtzError(status, code);
      const x = await request(app).post(`${base}/positions`).send({ name: 'Gate' });
      expect([x.status, x.body]).toEqual([status, { error: code }]);
    }
    posError = new PtzError(400, 'invalid', 'name must be 1 to 40 characters');
    const x = await request(app).post(`${base}/positions`).send({ name: '' });
    expect([x.status, x.body]).toEqual([400, { error: 'invalid', detail: 'name must be 1 to 40 characters' }]);
    posError = new CameraError('camera_error', 'the camera did not keep the preset');
    expect((await request(app).post(`${base}/positions`).send({ name: 'Gate' })).body).toEqual({ error: 'camera_error' });
  });

  it('the other position routes call the service', async () => {
    const id = 'pos_0123456789abcdef';
    expect((await request(app).put(`${base}/positions/order`).send({ ids: [id] })).body).toEqual({ max: 20, positions: [pos()] });
    expect((await request(app).post(`${base}/positions/${id}/save`)).body).toEqual(pos());
    expect((await request(app).post(`${base}/positions/${id}/go`)).status).toBe(204);
    expect((await request(app).delete(`${base}/positions/${id}`)).status).toBe(204);
    expect((await request(app).patch(`${base}/positions/${id}`).send({ home: true })).body).toEqual(pos());
    expect(calls).toEqual([`reorder [["${id}"]]`, `resave ["${id}"]`, `goTo ["${id}"]`, `remove ["${id}"]`, `makeHome ["${id}"]`]);
  });

  it('PATCH home:false → 400; {} → 400; name and home both: rename, then Home', async () => {
    const id = 'pos_0123456789abcdef';
    expect((await request(app).patch(`${base}/positions/${id}`).send({ home: false })).body).toEqual({ error: 'invalid', detail: 'home is only ever set to true' });
    expect((await request(app).patch(`${base}/positions/${id}`).send({})).status).toBe(400);
    expect(calls).toEqual([]);
    const r = await request(app).patch(`${base}/positions/${id}`).send({ name: 'Front', home: true });
    expect(r.status).toBe(200);
    expect(calls).toEqual([`rename ["${id}","Front"]`, `makeHome ["${id}"]`]);
  });

  it('PUT order is not taken as an :id', async () => {
    await request(app).put(`${base}/positions/order`).send({ ids: [] });
    expect(calls).toEqual(['reorder [[]]']);
  });

  it('audit: save writes ptz-position op save with the camera label; a 409 writes nothing; no slot in details', async () => {
    await request(app).post(`${base}/positions`).set('user-agent', 'ua-test').send({ name: 'Gate' });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'ptz-position', category: ['configuration'], type: ['creation'], outcome: 'success', user: 'client', userAgent: 'ua-test', camera: 'e1', message: 'PTZ position "Gate" saved', details: { op: 'save', id: 'pos_0123456789abcdef', name: 'Gate', requestedBy: 'token' } });
    expect(JSON.stringify(audits[0])).not.toMatch(/slot/i);
    posError = new PtzError(409, 'limit_reached');
    await request(app).post(`${base}/positions`).send({ name: 'Gate' });
    posError = new PtzError(503, 'camera_offline');
    await request(app).delete(`${base}/positions/pos_0123456789abcdef`);
    expect(audits).toHaveLength(1);
  });

  it('audit: every op, and a 502 as a failure', async () => {
    const id = 'pos_0123456789abcdef';
    await request(app).patch(`${base}/positions/${id}`).send({ name: 'Front' });
    await request(app).patch(`${base}/positions/${id}`).send({ home: true });
    await request(app).put(`${base}/positions/order`).send({ ids: [id] });
    await request(app).post(`${base}/positions/${id}/save`);
    await request(app).delete(`${base}/positions/${id}`);
    await request(app).post(`${base}/positions/${id}/go`);
    expect(audits.map((a) => [a.details?.op, a.type[0]])).toEqual([['rename', 'change'], ['home', 'change'], ['order', 'change'], ['resave', 'change'], ['delete', 'deletion']]);
    expect(audits[0].details).toMatchObject({ from: 'Gate', name: 'Front' });
    expect(audits[2].details).toMatchObject({ ids: [id] });
    posError = new CameraError('camera_error', 'kept');
    await request(app).delete(`${base}/positions/${id}`);
    expect(audits.at(-1)).toMatchObject({ outcome: 'failure', error: 'camera_error', details: { op: 'delete', id, name: 'Gate' } });
  });

  it('audit: a managed client token is named by its label', async () => {
    const managed = express();
    managed.use(express.json());
    managed.use((_req, res, next) => ((res.locals.access = { access: 'client', viaCookie: false, tokenKind: 'client', origin: 'managed', tokenLabel: 'cams client' }), next()));
    const cams = new CameraRegistry(() => ['e1']);
    cams.add(fakeWorker());
    managed.use('/api', ptzApi({ cameras: cams, audit: { write: (i) => (audits.push(i), null) } }));
    await request(managed).post(`${base}/positions`).send({ name: 'Gate' });
    expect(audits.at(-1)?.user).toBe('token:cams client');
  });

  it('moves are not audited', async () => {
    await request(app).post(`${base}/move`).send({ direction: 'left' });
    await request(app).post(`${base}/stop`);
    expect(audits).toEqual([]);
  });

  it('no response or error carries Reolink terms', async () => {
    for (const [m, p, b] of ROUTES) await send(m, p, b);
    camFails = new CameraError('camera_error', 'PtzCtrl ToPos preset slot 4 refused');
    for (const [m, p, b] of ROUTES) await send(m, p, b);
    posError = new CameraError('camera_error', 'preset slot 4');
    for (const [m, p, b] of ROUTES) await send(m, p, b);
    expect(bodies.length).toBeGreaterThan(10);
    for (const b of bodies) expect(b).not.toMatch(/PtzCtrl|ToPos|slot|preset/i);
  });
});
