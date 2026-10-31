import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { DEFAULT_CODECS, LIVE, validCodecs } from '../src/stream/live';
import { lastAudit } from './helpers/onboarding';
import { ADMIN_TOKEN, CLIENT_TOKEN, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// The live video upgrade (spec 2026-10-30-camera-onboarding-design §4.8, §10.3)
// without go2rtc: every refusal, before the upgrade (HTTP) and after it (the socket).
const AUDIT_TOKEN = 'audit-token-'.padEnd(40, 'z');
let s: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
beforeAll(async () => {
  s = await startSim();
  p = await startProxy(s, { env: { CAMPROXY_AUDIT_TOKEN: AUDIT_TOKEN }, settings: { stills: { enabled: false } } });
  await until(() => p.proxy.cameras.get('cam1')!.status.state().online, 10_000);
}, 30_000);
afterAll(async () => {
  await p?.proxy.stop();
  await s?.close();
});

type Outcome = { http: number; body: Record<string, unknown> } | { messages: string[]; code: number; reason: string };
// Opens the WebSocket; the refused upgrade's status and body, or the socket's messages and close.
function open(path: string, headers: Record<string, string> = { Authorization: `Bearer ${CLIENT_TOKEN}` }): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${p.port}${path}`, { headers });
    const messages: string[] = [];
    ws.on('unexpected-response', (_req, res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (b += c));
      res.on('end', () => resolve({ http: res.statusCode ?? 0, body: b ? (JSON.parse(b) as Record<string, unknown>) : {} }));
    });
    ws.on('message', (data, isBinary) => messages.push(isBinary ? '<binary>' : data.toString()));
    ws.on('close', (code, reason) => resolve({ messages, code, reason: reason.toString() }));
    ws.on('error', (err) => (err.message.startsWith('Unexpected server response') ? undefined : reject(err)));
  });
}
const LIVE_PATH = '/api/cameras/cam1/live';

describe('the live upgrade: refused before the upgrade', () => {
  it('a token in the URL is 400 token_in_url', async () => {
    expect(await open(`${LIVE_PATH}?token=${CLIENT_TOKEN}`)).toEqual({ http: 400, body: { error: 'token_in_url' } });
    expect(await open(`${LIVE_PATH}?access_token=x`)).toEqual({ http: 400, body: { error: 'token_in_url' } });
  });

  it('no token, a wrong one, the audit token, or a cookie session alone is 401', async () => {
    expect(await open(LIVE_PATH, {})).toEqual({ http: 401, body: { error: 'unauthorized' } });
    expect(await open(LIVE_PATH, { Authorization: `Bearer ${'x'.repeat(40)}` })).toEqual({ http: 401, body: { error: 'unauthorized' } });
    expect(await open(LIVE_PATH, { Authorization: `Bearer ${AUDIT_TOKEN}` })).toEqual({ http: 401, body: { error: 'unauthorized' } });
    const login = await request(p.base).post('/control/login').send({ token: ADMIN_TOKEN });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    expect(cookie).toMatch(/=/);
    expect(await open(LIVE_PATH, { Cookie: cookie })).toEqual({ http: 401, body: { error: 'unauthorized' } });
    expect(lastAudit(p.dir, 'auth-refused')).toMatchObject({ cam_proxy: { auth: { reason: expect.any(String) } } });
  });

  it('an unknown camera and another path are 404', async () => {
    expect(await open('/api/cameras/nope/live')).toEqual({ http: 404, body: { error: 'not_found' } });
    expect(await open('/api/cameras/cam1/stream')).toEqual({ http: 404, body: { error: 'not_found' } });
    expect(await open('/api/stream')).toEqual({ http: 404, body: { error: 'not_found' } });
  });

  it('another stream or codecs list is 400 invalid', async () => {
    expect(await open(`${LIVE_PATH}?stream=foo`)).toEqual({ http: 400, body: { error: 'invalid' } });
    expect(await open(`${LIVE_PATH}?stream=sub&stream=main`)).toEqual({ http: 400, body: { error: 'invalid' } });
    expect(await open(`${LIVE_PATH}?codecs=${encodeURIComponent('avc1"; x')}`)).toEqual({ http: 400, body: { error: 'invalid' } });
  });
});

describe('the live upgrade: the camera\'s state, over the socket', () => {
  const refused = (value: string) => ({ messages: [JSON.stringify({ type: 'error', value })], code: 1013, reason: value });

  it('a camera without a go2rtc stream (stills off) is stream_unavailable', async () => {
    expect(await open(LIVE_PATH)).toEqual(refused('stream_unavailable'));
    expect(await open(`${LIVE_PATH}?stream=main`, { Authorization: `Bearer ${ADMIN_TOKEN}` })).toEqual(refused('stream_unavailable'));
  });

  it('a restarting camera is camera_restarting', async () => {
    const w = p.proxy.cameras.get('cam1')!;
    const spy = vi.spyOn(w, 'phase').mockReturnValue('restarting');
    try {
      expect(await open(LIVE_PATH)).toEqual(refused('camera_restarting'));
    } finally {
      spy.mockRestore();
    }
  });

  it('with a go2rtc stream: an offline camera is camera_offline, a full proxy too_many_streams', async () => {
    const w = p.proxy.cameras.get('cam1')!;
    const fake = { up: () => true, wsUrl: () => 'ws://127.0.0.1:1/api/ws' };
    const stills = w.stills;
    w.stills = { go2rtc: fake } as unknown as typeof w.stills;
    const st = vi.spyOn(w.status, 'state');
    try {
      st.mockReturnValue({ online: false, since: 0 });
      expect(await open(LIVE_PATH)).toEqual(refused('camera_offline'));
      st.mockRestore();
      const count = vi.spyOn(p.proxy.live, 'count').mockImplementation((cam?: string) => (cam ? LIVE.maxPerCamera : 0));
      expect(await open(LIVE_PATH)).toEqual(refused('too_many_streams'));
      count.mockImplementation((cam?: string) => (cam ? 0 : LIVE.maxTotal));
      expect(await open(LIVE_PATH)).toEqual(refused('too_many_streams'));
      count.mockRestore();
      // go2rtc not reachable: the relay fails at once with stream_unavailable (1011).
      const r = await open(LIVE_PATH);
      expect(r).toEqual({ messages: [JSON.stringify({ type: 'error', value: 'stream_unavailable' })], code: 1011, reason: 'stream_unavailable' });
      await until(() => p.proxy.live.count() === 0, 2000);
    } finally {
      st.mockRestore();
      w.stills = stills;
    }
  });
});

describe('validCodecs', () => {
  it('undefined is the default list; a plain list is kept; anything else is null', () => {
    expect(validCodecs(undefined)).toBe(DEFAULT_CODECS);
    expect(validCodecs('avc1.64002A,mp4a.40.2')).toBe('avc1.64002A,mp4a.40.2');
    expect(validCodecs('avc1"; x')).toBeNull();
    expect(validCodecs('a'.repeat(600))).toBeNull();
    expect(validCodecs('')).toBeNull();
    expect(validCodecs(5)).toBeNull();
  });
});

describe('the live upgrade rate limit', () => {
  it('more than 60 upgrades a minute from one address are 429 rate_limited', async () => {
    const out: number[] = [];
    for (let i = 0; i < 61; i++) {
      const r = await open(LIVE_PATH, {});
      out.push('http' in r ? r.http : 0);
    }
    expect(out.at(-1)).toBe(429);
    expect(out.filter((x) => x === 401).length).toBeGreaterThan(0);
  }, 30_000);
});
