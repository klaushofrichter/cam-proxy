import { createHash, randomBytes } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../src/config/defaults';
import type { Backup } from '../src/fleet/backups';
import { DISRUPTIVE_ENTRIES } from '../src/fleet/policy';
import { writePrivateJson } from '../src/fleet/private-file';
import { runAdminCli } from '../src/fleet/cli';
import { Readable } from 'stream';
import { ADMIN_TOKEN, auth, CLIENT_TOKEN, freePort, startProxy } from './helpers/proxy';
import { startSim } from './helpers/sim';

// cams-admin's changes, visible and undoable on the proxy (plan P3 Task 11,
// R3-5, R3-14): GET /control/admin/changes, POST …/undo (local admin only),
// the Settings marker, the grouped allow entries, the CLI.
const CMD = (n: number) => `cmd_${String(n).padStart(20, '0')}`;
const tok = () => randomBytes(32).toString('base64url');
const hashOf = (t: string) => `sha256:${createHash('sha256').update(t).digest('hex')}`;
const MANAGED_ADMIN = tok();
const backup = (n: number, paths: Backup['paths'], at = 1_791_000_000_000 + n): Backup => ({ v: 1, cmdId: CMD(n), command: 'config.set', actor: 'admin@example.org', at, revisionBefore: `sha256:${'a'.repeat(64)}`, revisionAfter: `sha256:${'b'.repeat(64)}`, paths });

let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
const admin = auth(ADMIN_TOKEN);
const config = async () => (await request(p.base).get('/control/config').set(admin).expect(200)).body as Record<string, Record<string, unknown>>;
beforeAll(async () => {
  sim = await startSim();
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-changes-'));
  // As two config.set commands from cams-admin left them: the overrides and their backups.
  writeFileSync(join(dir, 'config.json'), '{}');
  const data = join(dir, 'data');
  writePrivateJson(join(data, 'admin', `overrides.bak-${CMD(1)}.json`), backup(1, [{ path: 'sse.pingS', before: { set: false }, after: { set: true, value: 7 } }]));
  writePrivateJson(join(data, 'admin', `overrides.bak-${CMD(2)}.json`), backup(2, [{ path: 'sse.maxClients', before: { set: false }, after: { set: true, value: 9 } }]));
  writePrivateJson(join(data, 'admin', 'tokens.json'), { v: 1, revision: 1, blocked: [], tokens: [{ id: `tok_${'1'.repeat(20)}`, kind: 'admin', hash: hashOf(MANAGED_ADMIN), label: 'cams cluster', retireAt: null }] });
  writeFileSync(join(data, 'overrides.json'), JSON.stringify({ sse: { pingS: 7, maxClients: 9 } }));
  // A P2 policy.json that listed P3 entries (they were 'not in this version' then).
  writePrivateJson(join(data, 'admin', 'policy.json'), { v: 1, allow: ['tokens.apply', 'config.set', 'proxy.restart'], changedAt: 1, changedBy: 'local' });
  // A backup whose actor carries a terminal escape (the CLI must not pass it on).
  writePrivateJson(join(data, 'admin', `overrides.bak-${CMD(3)}.json`), { ...backup(3, [{ path: 'sse.queuePerClient', before: { set: false }, after: { set: false } }], 1_791_000_000_000), actor: 'evil\u001b]52;c;QUJD\u0007@example.org' });
  p = await startProxy(sim, { dir });
}, 30_000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

describe('cams-admin changes on the proxy', () => {
  it('GET /control/admin/changes: newest first, the paths with from/to, never more', async () => {
    const r = await request(p.base).get('/control/admin/changes').set(admin).expect(200);
    expect(r.body.items.slice(0, 2)).toEqual([
      { cmdId: CMD(2), command: 'config.set', actor: 'admin@example.org', at: 1_791_000_000_002, paths: [{ path: 'sse.maxClients', to: 9 }], rolledBack: null },
      { cmdId: CMD(1), command: 'config.set', actor: 'admin@example.org', at: 1_791_000_000_001, paths: [{ path: 'sse.pingS', to: 7 }], rolledBack: null },
    ]);
    expect((await request(p.base).get('/control/admin/changes').set(auth(CLIENT_TOKEN))).status).toBe(403);
  });
  it('GET /control/config marks the overrides cams-admin set (by); a local edit drops the marker', async () => {
    const c = await config();
    expect(c['sse.pingS']).toMatchObject({ value: 7, source: 'override', by: { cmdId: CMD(1), actor: 'admin@example.org', at: 1_791_000_000_001 } });
    expect(c['sse.queuePerClient'].by).toBeUndefined();
  });
  it('the allow entries in groups; the disruptive ones say so', async () => {
    const r = (await request(p.base).get('/control/admin/commands').set(admin).expect(200)).body;
    expect(r.groups.read).toEqual(['config.get']);
    expect(r.groups.settings).toEqual(['config.set', 'config.unset', 'config.rollback']);
    expect([...r.groups.disruptive].sort()).toEqual([...DISRUPTIVE_ENTRIES].sort());
    expect(r.groups.camera).toContain('camera.action:camera-test');
    expect(r.groups.camera).toContain('camera.name.set');
    expect(r.groups.camera).not.toContain('camera.action:camera-reboot');
    for (const e of r.groups.disruptive) expect(r.known.find((k: { entry: string }) => k.entry === e).text, e).toMatch(/^DISRUPTIVE: /);
    expect(r.allow).toEqual(['tokens.apply']);
    // I3: the P3 entries a P2 version stored wait for a fresh local tick.
    expect(r.unconfirmed).toEqual(['config.set', 'proxy.restart']);
  });
  it('Undo: a managed admin token is refused (403); a bad id is 400, an unknown one 404', async () => {
    expect((await request(p.base).post(`/control/admin/changes/${CMD(1)}/undo`).set(auth(MANAGED_ADMIN))).status).toBe(403);
    expect((await request(p.base).post('/control/admin/changes/..%2Fx/undo').set(admin)).status).toBe(400);
    expect((await request(p.base).post(`/control/admin/changes/${CMD(9)}/undo`).set(admin)).body).toEqual({ error: 'no_backup' });
  });
  it('Undo after a local edit of the same path: 409 naming it, nothing restored', async () => {
    await request(p.base).put('/control/config').set(admin).send({ sse: { maxClients: 11 } }).expect(200);
    const r = await request(p.base).post(`/control/admin/changes/${CMD(2)}/undo`).set(admin);
    expect([r.status, r.body]).toEqual([409, { error: 'conflict', paths: ['sse.maxClients'] }]);
    expect((await config())['sse.maxClients'].value).toBe(11);
  });
  it('Undo restores the value before; audited as the local admin; a second undo is already_rolled_back', async () => {
    const r = await request(p.base).post(`/control/admin/changes/${CMD(1)}/undo`).set(admin).expect(200);
    expect(r.body.changes).toEqual([expect.objectContaining({ path: 'sse.pingS', from: 7, to: DEFAULTS.sse.pingS })]);
    const c = await config();
    expect(c['sse.pingS']).toMatchObject({ value: DEFAULTS.sse.pingS, source: 'default' });
    expect(c['sse.pingS'].by).toBeUndefined();
    expect(p.proxy.audit.list({ actions: ['config-change'], limit: 1 }).records[0]).toMatchObject({ user: { name: 'admin' }, cam_proxy: { undoOf: CMD(1) } });
    expect((await request(p.base).post(`/control/admin/changes/${CMD(1)}/undo`).set(admin)).body).toEqual({ error: 'already_rolled_back' });
    const items = (await request(p.base).get('/control/admin/changes').set(admin)).body.items;
    expect(items.find((x: { cmdId: string }) => x.cmdId === CMD(1)).rolledBack).toMatchObject({ by: 'local', user: 'admin' });
  });
});

describe('the CLI', () => {
  const stdin = () => Object.assign(Readable.from(['']), { isTTY: false });
  const ENV = { CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: 'x' };
  const run = async (argv: string[], proxyUrl: string, cwd = p.dir) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runAdminCli(argv, { env: ENV, cwd, stdin: stdin(), out: (s) => out.push(s), err: (s) => err.push(s), proxyUrl });
    return { code, out: out.join(''), err: err.join('') };
  };
  it('admin-commands changes: time, cmdId, actor and paths (never a value)', async () => {
    const r = await run(['admin-commands', 'changes'], p.base);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(CMD(2));
    expect(r.out).toContain('sse.maxClients');
    expect(r.out).toContain('admin@example.org');
    expect(r.out).toMatch(/undone/);
    expect(r.out).not.toMatch(/\b9\b.*sse|sse\.maxClients.*\b9\b/);
    expect(r.out + r.err).not.toContain(ADMIN_TOKEN);
    expect(r.out).not.toMatch(/\u001b|\u0007/);
    expect(r.out).toContain('evil ]52;c;QUJD @example.org');
  });
  it('admin-commands status: the entries waiting for a fresh confirmation (I3)', async () => {
    const r = await run(['admin-commands', 'status'], p.base);
    expect(r.out).toMatch(/allowed: tokens\.apply/);
    expect(r.out).toMatch(/needs re-confirming \(allowed before this version\): config\.set, proxy\.restart/);
  });
  it('admin-commands undo <cmdId>: through the running proxy; a conflict says which paths', async () => {
    const r = await run(['admin-commands', 'undo', CMD(2)], p.base);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/sse\.maxClients/);
    expect((await run(['admin-commands', 'undo', 'nope'], p.base)).code).toBe(2);
  });
  it('the proxy not running: undo is refused with a message, nothing written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-cli-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ camera: { host: '127.0.0.1' }, server: { logLevel: 'silent' } }));
    const r = await run(['admin-commands', 'undo', CMD(1)], `http://127.0.0.1:${await freePort()}`, dir);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not running/);
  });
});
