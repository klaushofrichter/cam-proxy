import { execFile } from 'child_process';
import { promisify } from 'util';
import { afterEach, describe, expect, it } from 'vitest';
import { freePort } from './helpers/proxy';
import { Backoff } from '../src/cameras/backoff';
import { Go2rtc, go2rtcConfig, passwordEnv, type StreamSource } from '../src/stills/go2rtc';

const run = promisify(execFile);
const binary = process.env.CAMPROXY_TEST_GO2RTC;
const src = (cam: string, password = `pw-${cam}`): StreamSource => ({ cam, host: '127.0.0.1', port: 9, user: 'proxy', password });
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

describe('go2rtc config (spec §8.5)', () => {
  it('two streams per camera; each password only as its env variable', () => {
    const text = go2rtcConfig({ rtspPort: 1, apiPort: 2 }, [src('cam3', 's3cr3t!'), src('cam-4', 'x')]);
    const cfg = JSON.parse(text);
    expect(Object.keys(cfg.streams)).toEqual(['cam3_sub', 'cam3_main', 'cam-4_sub', 'cam-4_main']);
    expect(cfg.streams.cam3_sub).toBe('rtsp://proxy:${CAM_CAM3_PASSWORD}@127.0.0.1:9/h264Preview_01_sub');
    expect(cfg.streams['cam-4_main']).toBe('rtsp://proxy:${CAM_CAM_4_PASSWORD}@127.0.0.1:9/h264Preview_01_main');
    expect(text).not.toContain('s3cr3t');
    expect(passwordEnv('cam-4')).toBe('CAM_CAM_4_PASSWORD');
  });
});

describe.skipIf(!binary)('one go2rtc, many cameras', () => {
  it('starts with every camera, adds and removes one without a restart', async () => {
    let sources = [src('cam3'), src('cam4')];
    const g = new Go2rtc({ binary, rtspPort: await freePort(), apiPort: await freePort(), sources: () => sources });
    cleanup.push(() => g.stop());
    await g.start();
    const pid = g.pid();
    expect(Object.keys(await g.streams()).sort()).toEqual(['cam3_main', 'cam3_sub', 'cam4_main', 'cam4_sub']);
    sources = [...sources, src('cam5')];
    await g.setStream(src('cam5'));
    await g.removeStream('cam4');
    expect(Object.keys(await g.streams()).sort()).toEqual(['cam3_main', 'cam3_sub', 'cam5_main', 'cam5_sub']);
    expect(g.pid()).toBe(pid);
    const { stdout } = await run('ps', ['-o', 'args=', '-p', String(pid)]);
    expect(stdout).not.toContain('pw-cam3');
  }, 30_000);
});

describe('go2rtc down: stream changes never hang', () => {
  it('setStream and removeStream on a go2rtc that is not running return at once (the next spawn reads the sources)', async () => {
    const g = new Go2rtc({ binary: '/nonexistent/go2rtc', rtspPort: 1, apiPort: 2, sources: () => [] });
    const t0 = Date.now();
    await g.setStream(src('cam5'));
    await g.removeStream('cam5');
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe('go2rtc that never gets ready', () => {
  it('start fails, and the host retries it with the backoff (spec §3.3)', async () => {
    const { chmodSync, mkdtempSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-fake-go2rtc-'));
    const fake = join(dir, 'go2rtc');
    writeFileSync(fake, '#!/bin/sh\nexec sleep 30\n');
    chmodSync(fake, 0o755);
    const g = new Go2rtc({ binary: fake, rtspPort: await freePort(), apiPort: await freePort(), readyMs: 300, sources: () => [], backoff: new Backoff({ firstMs: 100 }) });
    cleanup.push(() => g.stop());
    await expect(g.start()).rejects.toThrow(/go2rtc_not_ready/);
    const first = g.pid();
    expect(first).toBeDefined();
    const t0 = Date.now();
    while (g.pid() === first || g.pid() === undefined) {
      if (Date.now() - t0 > 5000) throw new Error('not retried');
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(() => process.kill(first!, 0)).toThrow(); // the first one was ended
  }, 15_000);
});
