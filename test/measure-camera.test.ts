import { spawnSync } from 'child_process';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measureCamera } from '../scripts/measure-camera';
import { startSim } from './helpers/sim';

let sim: Awaited<ReturnType<typeof startSim>>;
beforeAll(async () => {
  sim = await startSim();
});
afterAll(async () => {
  await sim.close();
});

describe('measure-camera (spec §15: measure on the real camera first)', () => {
  it('refuses a camera outside the camera network without --allow-any-host', async () => {
    await expect(measureCamera({ host: '192.168.1.103', protocol: 'https', user: 'proxy', password: 'x' })).rejects.toThrow('192.168.1.103 is not on the camera network 192.168.60.0/24 (cam1 is never measured); --allow-any-host to override');
  });

  it('reads what the camera answers; a command it lacks is reported, nothing thrown', async () => {
    const m = await measureCamera({ host: sim.camera.host, protocol: 'http', user: 'proxy', password: sim.password, allowAnyHost: true });
    expect(m.devInfo).toMatchObject({ model: expect.any(String) });
    expect(m.certificateInfo).toMatchObject({ CertificateInfo: { enable: 0 } });
    expect('error' in m.ntp || 'Ntp' in m.ntp).toBe(true);
    expect(JSON.stringify(m)).not.toContain(sim.password);
  });

  it('the CLI prints one JSON document (no log lines), without the password', () => {
    // A closed port: every read fails and is reported in the JSON.
    const r = spawnSync('npx', ['tsx', join(__dirname, '..', 'scripts', 'measure-camera.ts'), '--host', '127.0.0.1:9', '--protocol', 'https', '--allow-any-host'], { encoding: 'utf8', env: { ...process.env, CAMPROXY_CAMERA_PASSWORD: 'secret-pw-123' } });
    expect(r.status, r.stderr).toBe(0);
    const m = JSON.parse(r.stdout);
    expect(m.devInfo).toHaveProperty('error');
    expect(m.served).toBeNull();
    expect(r.stdout + r.stderr).not.toContain('secret-pw-123');
  });
});
