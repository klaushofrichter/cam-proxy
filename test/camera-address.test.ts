import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startSim } from './helpers/sim';
import { ADMIN_TOKEN, auth, CLIENT_TOKEN, startProxy, until } from './helpers/proxy';

// Spec 2026-10-04-pi-config-design §2: the camera's address in GET
// /api/cameras and in the `camera` stream message.

let sim: Awaited<ReturnType<typeof startSim>>;
beforeAll(async () => {
  sim = await startSim();
}, 30_000);
afterAll(async () => {
  await sim.close();
});

describe('the camera address for clients', () => {
  it('is in /api/cameras, told once per address, again after a camera.host change, not after a plain restart', async () => {
    const p = await startProxy(sim);
    let told = 0;
    const messages = () => p.proxy.log.since(0, { types: ['camera'] }, 100).map((m) => m.data);
    try {
      expect((await request(p.base).get('/api/cameras').set(auth(CLIENT_TOKEN))).body[0].address).toBe(sim.camera.host);
      expect(messages().filter((m) => m.address !== undefined).map((m) => m.address)).toEqual([sim.camera.host]);
      // Another spelling of the same camera, applied by "Restart camera side".
      const other = sim.camera.host.replace('127.0.0.1', 'localhost');
      expect((await request(p.base).put('/control/config').set(auth(ADMIN_TOKEN)).send({ camera: { host: other } })).status).toBe(200);
      expect((await request(p.base).post('/control/actions/restart').set(auth(ADMIN_TOKEN))).status).toBe(202);
      await until(() => messages().some((m) => m.address === other));
      expect((await request(p.base).get('/api/cameras').set(auth(CLIENT_TOKEN))).body[0].address).toBe(other);
      // Every message carries the address; it changed once.
      expect(messages().every((m) => typeof m.address === 'string')).toBe(true);
      expect(messages().map((m) => m.address).filter((a, i, all) => a !== all[i - 1])).toEqual([sim.camera.host, other]);
      told = messages().length;
    } finally {
      await p.proxy.stop();
    }
    // A new process on the same data folder with the same address: nothing new.
    const q = await startProxy(sim, { dir: p.dir, settings: {} });
    try {
      // The override (localhost) still applies: the same address, no message.
      expect(q.proxy.log.since(0, { types: ['camera'] }, 100)).toHaveLength(told);
    } finally {
      await q.proxy.stop();
    }
  });
});
