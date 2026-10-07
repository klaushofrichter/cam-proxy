import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { readEnvLayer } from '../src/config/env';
import type { ClientLog } from '../src/fleet/client';
import { SeenIds } from '../src/fleet/command-check';
import { cameraHandlers } from '../src/fleet/camera-commands';
import { CommandRunner, type ConnCtx, type Handler } from '../src/fleet/commands';
import { Journal } from '../src/fleet/journal';
import { CommandPolicy } from '../src/fleet/policy';
import { signEnvelope, type Envelope } from '../src/fleet/protocol';
import { TokenStore } from '../src/fleet/token-store';
import { vectors } from './helpers/contract';

// The journal budget survives restarts (plan P3 R3-9, Task 12 c, d): a
// compromised cams-admin can't restart the proxy, or reboot cameras, in a
// loop; each restart is a new runner on the same data/admin/commands.json.
const quiet: ClientLog = { info() {}, warn() {}, debug() {} };
const PRX = `prx_${'1'.repeat(20)}`;
let n = 0;
function proxyRun(dir: string, allow: string[], handlers: Record<string, Handler>) {
  const policy = new CommandPolicy({ base: () => ({ allow: [], paused: false }), file: join(dir, 'admin', 'policy.json'), env: () => readEnvLayer({}), log: quiet });
  policy.setAllow(allow, 'local');
  const audit: Record<string, any>[] = [];
  const runner = new CommandRunner({ proxyId: () => PRX, serverKeys: () => [vectors.keys.server.publicKey], policy, journal: new Journal(join(dir, 'admin', 'commands.json')), tokens: new TokenStore({ file: join(dir, 'admin', 'tokens.json'), localDigests: () => [] }), audit: { write: (r: Record<string, any>) => (audit.push(r), r) as never }, log: quiet, handlers });
  const conn: ConnCtx = { connId: `con_${String(++n).padStart(20, '0')}`, serverNow: () => Date.now(), seen: new SeenIds() };
  const sent: Record<string, any>[] = [];
  const send = async (command: string, args: Record<string, unknown>) => {
    n++;
    const m = { v: 1 as const, type: 'command', id: `0000000000000000000000${String(n).padStart(4, '0')}`, seq: n, ts: Date.now(), body: { proxyId: PRX, connId: conn.connId, cmdId: `cmd_${String(n).padStart(20, '0')}`, exp: Date.now() + 30_000, actor: 'mallory@example.org', command, args } };
    await runner.onCommand({ ...m, sig: signEnvelope(vectors.keys.server.privateKey, m as never) } as Envelope, conn, (_t, body) => (sent.push(body), true));
    await new Promise((r) => setImmediate(r));
    return sent.filter((b) => b.phase === 'done').at(-1)!;
  };
  return { send, audit };
}

describe('the journal budget across restarts', () => {
  it('(c) proxy.restart three times in an hour, a restart between each: the third is rate_limited; restartProcess ran twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'budget-'));
    const restartProcess = vi.fn();
    const handlers = () => cameraHandlers({ actions: {} as never, cameraIds: () => ['cam1'], cameraName: { current: () => '', write: async () => '' }, audit: { write: () => null }, restartProcess });
    expect(await proxyRun(dir, ['proxy.restart'], handlers()).send('proxy.restart', { v: 1 })).toMatchObject({ status: 'ok' });
    expect(await proxyRun(dir, ['proxy.restart'], handlers()).send('proxy.restart', { v: 1 })).toMatchObject({ status: 'ok' });
    const third = proxyRun(dir, ['proxy.restart'], handlers());
    expect(await third.send('proxy.restart', { v: 1 })).toMatchObject({ status: 'refused', code: 'rate_limited', retryAfterS: expect.any(Number) });
    expect(restartProcess).toHaveBeenCalledTimes(2);
    expect(third.audit.at(-1)).toMatchObject({ action: 'admin-command', outcome: 'failure', error: 'rate_limited' });
  });
  it('(d) seven camera reboots across two runners in an hour: the seventh is rate_limited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'budget-'));
    const reboot = vi.fn();
    const handlers: Record<string, Handler> = { 'camera.action': (args) => (reboot(), { status: 'ok', action: (args as { action: string }).action, result: {} }) };
    const allow = ['camera.action:camera-reboot', 'camera.action:camera-test'];
    const a = proxyRun(dir, allow, handlers);
    for (let i = 0; i < 4; i++) expect(await a.send('camera.action', { v: 1, camera: 'cam1', action: 'camera-reboot' })).toMatchObject({ status: 'ok' });
    const b = proxyRun(dir, allow, handlers);
    for (let i = 0; i < 2; i++) expect(await b.send('camera.action', { v: 1, camera: 'cam1', action: 'camera-reboot' })).toMatchObject({ status: 'ok' });
    expect(await b.send('camera.action', { v: 1, camera: 'cam1', action: 'camera-reboot' })).toMatchObject({ status: 'refused', code: 'rate_limited' });
    expect(reboot).toHaveBeenCalledTimes(6);
    // A non-disruptive action is not under the budget.
    expect(await b.send('camera.action', { v: 1, camera: 'cam1', action: 'camera-test' })).toMatchObject({ status: 'ok' });
  });
});
