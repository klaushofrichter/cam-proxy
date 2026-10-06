import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { startSim } from './helpers/sim';
import { freePort } from './helpers/proxy';
import { Go2rtc } from '../src/stills/go2rtc';

const run = promisify(execFile);
const binary = process.env.CAMPROXY_TEST_GO2RTC;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});


async function setup() {
  const sim = await startSim();
  cleanup.push(() => sim.close());
  const g = new Go2rtc({ binary, rtspPort: await freePort(), apiPort: await freePort(),
    sources: () => [{ cam: 'cam1', host: '127.0.0.1', port: sim.ports.rtsp, user: 'proxy', password: sim.password }] });
  cleanup.push(() => g.stop());
  await g.start();
  return { sim, g };
}
const probe = async (url: string) => (await run('ffprobe', ['-v', 'error', '-rtsp_transport', 'tcp', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width', '-of', 'csv=p=0', url], { timeout: 20000 })).stdout.trim();

describe.skipIf(!binary)('go2rtc supervisor', () => {
  it('restreams the camera sub stream on 127.0.0.1', async () => {
    const { g } = await setup();
    expect(g.up()).toBe(true);
    expect(g.streamUrl('cam1', 'sub')).toMatch(/^rtsp:\/\/127\.0\.0\.1:\d+\/cam1_sub$/);
    expect(await probe(g.streamUrl('cam1', 'sub'))).toBe('h264,896');
  }, 40000);

  it('serves two readers over one camera connection', async () => {
    const { g } = await setup();
    const [a, b] = await Promise.all([probe(g.streamUrl('cam1', 'sub')), probe(g.streamUrl('cam1', 'sub'))]);
    expect([a, b]).toEqual(['h264,896', 'h264,896']);
    const streams = await g.streams();
    expect(streams.cam1_sub.producers).toHaveLength(1);
  }, 40000);

  it('keeps the camera password off the command line', async () => {
    const { g, sim } = await setup();
    const { stdout } = await run('ps', ['-o', 'args=', '-p', String(g.pid())]);
    expect(stdout).toContain('go2rtc');
    expect(stdout).not.toContain(sim.password);
  }, 40000);

  it('restarts go2rtc when it dies, and stop() leaves no process', async () => {
    const { g } = await setup();
    const first = g.pid()!;
    process.kill(first, 'SIGKILL');
    const t0 = Date.now();
    while (!(g.up() && g.pid() && g.pid() !== first)) {
      if (Date.now() - t0 > 15000) throw new Error('not restarted');
      await new Promise((r) => setTimeout(r, 100));
    }
    const second = g.pid()!;
    await g.stop();
    expect(() => process.kill(second, 0)).toThrow();
  }, 40000);
});

// Live test 2026-10-05: a proxy restarted within a second met the old
// go2rtc still on the ports; its /api answered, so the new one counted as up
// and the stream stayed down for good.
describe('go2rtc: only our own go2rtc counts', () => {
  it('a foreign go2rtc on the API port is not ours: start fails (supervision retries)', async () => {
    const { createServer } = await import('http');
    const { chmodSync, mkdtempSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const apiPort = await freePort();
    const foreign = createServer((_req, res) => void res.end(JSON.stringify({ config_path: '/tmp/someone-else/go2rtc.json', version: '1.9.14' })));
    await new Promise<void>((r) => foreign.listen(apiPort, '127.0.0.1', () => r()));
    cleanup.push(() => new Promise((r) => foreign.close(() => r(undefined))));
    // A stand-in go2rtc that can't bind and just lingers.
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-fake-go2rtc-'));
    const fake = join(dir, 'go2rtc');
    writeFileSync(fake, '#!/bin/sh\nexec sleep 30\n');
    chmodSync(fake, 0o755);
    const g = new Go2rtc({ binary: fake, rtspPort: await freePort(), apiPort, readyMs: 600, sources: () => [{ cam: 'cam1', host: '127.0.0.1', port: 554, user: 'proxy', password: 'x' }] });
    cleanup.push(() => g.stop());
    await expect(g.start()).rejects.toThrow(/go2rtc_not_ready/);
    expect(g.up()).toBe(false);
  });
});
