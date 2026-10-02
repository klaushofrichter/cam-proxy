import { describe, it, expect, afterAll } from 'vitest';
import net from 'net';
import { startSim } from './helpers/sim';

let sim: Awaited<ReturnType<typeof startSim>>;
afterAll(() => sim?.close());

describe('cam-sim for the proxy tests', () => {
  it('listens on a Baichuan port and reports it', async () => {
    sim = await startSim();
    expect(sim.camera.baichuanPort).toBeGreaterThan(0);
    expect(sim.ports.baichuan).toBe(sim.camera.baichuanPort);
    await new Promise<void>((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port: sim.camera.baichuanPort }, () => (s.destroy(), resolve()));
      s.once('error', reject);
    });
  });
});
