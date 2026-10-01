import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createSimCamera, type SimState } from './helpers/sim';
import { ReolinkClient } from '../src/camera/client';
import { StatusPoller, type CameraState } from '../src/camera/status';

let server: Server | undefined;
afterEach(() => server?.close());

async function setup(password = 'p') {
  const sim = await createSimCamera({ user: 'u', password: 'p' });
  server = sim.app.listen(0, '127.0.0.1');
  await new Promise((r) => server!.once('listening', r));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new ReolinkClient({ id: 'cam1', host, protocol: 'http', user: 'u', password });
  return { state: sim.state as SimState, poller: new StatusPoller(client, 0.05) };
}

describe('StatusPoller', () => {
  it('is online after a successful check, with model, firmware and clock offset', async () => {
    const { poller } = await setup();
    const s = await poller.checkNow();
    expect(s).toMatchObject({ online: true, model: 'RLC-1224A' });
    expect(Math.abs(s.clockOffsetMs!)).toBeLessThan(2000);
  });

  it('goes offline after two failed checks in a row, and back online after one success', async () => {
    const { poller, state } = await setup();
    const changes: CameraState[] = [];
    poller.on('change', (s: CameraState) => changes.push(s));
    await poller.checkNow();
    state.offline = true;
    expect((await poller.checkNow()).online).toBe(true); // one failure is not enough
    expect((await poller.checkNow()).online).toBe(false);
    state.offline = false;
    expect((await poller.checkNow()).online).toBe(true);
    expect(changes.map((c) => c.online)).toEqual([true, false, true]);
  });

  it('polls on its own once started, and stops cleanly', async () => {
    const { poller, state } = await setup();
    const before = state.devInfoCalls;
    poller.start();
    await new Promise((r) => setTimeout(r, 300));
    poller.stop();
    const after = state.devInfoCalls;
    expect(after - before).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 200));
    expect(state.devInfoCalls).toBe(after);
  });

  it('reports a wrong password without the password in the error', async () => {
    const { poller } = await setup('wrong-secret-pw');
    await poller.checkNow();
    const s = await poller.checkNow();
    expect(s.online).toBe(false);
    expect(s.error).toBeTruthy();
    expect(JSON.stringify(s)).not.toContain('wrong-secret-pw');
  });
});
