import { describe, expect, it } from 'vitest';
import { buildHealth, type CameraHealthInput } from '../src/health/summary';
import { buildHeartbeat, changeKeyOf, HEARTBEAT_MAX_BYTES, type HeartbeatProxyInfo } from '../src/fleet/heartbeat';
import { buildEnvelope } from '../src/fleet/protocol';
import { input, NOW } from './helpers/health-input';
import { strict, why } from './helpers/contract';

// The heartbeat (spec 2026-10-06-cams-admin-phase1-design §8.5): the health
// summary as GET /api/local/health has it, the proxy block, truncation over 192 KiB.
const DAY = 86400_000;
const PI_INFO: HeartbeatProxyInfo = { startedAt: NOW - 3600_000, uptimeS: 3600, configSchema: 1, tls: null, publicUrl: 'http://192.168.1.220:8480' };
const SITE_INFO: HeartbeatProxyInfo = { ...PI_INFO, tls: { site: 'garage', caFingerprint: [`SHA256:${'AB'.repeat(32)}`] }, publicUrl: 'https://proxy.garage.internal:8443' };
const cam = (id: string, online: boolean): CameraHealthInput => ({
  camera: { ...input().camera, id, name: `Camera ${id}`, host: `192.168.60.${id.slice(3)}`, state: online ? input().camera.state : { online: false, since: NOW, error: 'timeout' } },
  stream: input().stream, intake: input().intake, ftp: input().ftp,
});
const certOk = { mode: 'site-ca' as const, servername: 'cam1.garage.internal', fingerprint: 'SHA256:A', notAfter: NOW + 200 * DAY, lastPush: { at: NOW - DAY, outcome: 'pushed' as const }, problem: null };
const fourCams = () => buildHealth(input({
  others: [cam('cam3', true), cam('cam4', false), cam('cam5', true)],
  archive: { count: 12, bytes: 3e9, percentOfDisk: 1.2, warning: false },
  certificates: { proxy: { notAfter: NOW + 300 * DAY }, cameras: ['cam1', 'cam3', 'cam4', 'cam5'].map((id) => ({ id, state: { ...certOk, servername: `${id}.garage.internal` } })), problems: [] },
  thresholds: { diskPercent: 90, tempC: 75, ftpStalledHours: 6, archiveWarnPercent: 20 },
}));
const valid = (body: object) => {
  const v = strict('heartbeat');
  const ok = v(buildEnvelope('heartbeat', 2, body as Record<string, unknown>, { now: NOW }));
  return { ok, why: why(v) };
};

describe('the heartbeat body on the strict contract', () => {
  it('the one-camera Pi', () => {
    const hb = buildHeartbeat(buildHealth(input()), PI_INFO);
    expect(hb.truncated).toBe(false);
    expect(hb.body).toMatchObject({ truncated: false, proxy: PI_INFO });
    const r = valid(hb.body);
    expect(r.ok, r.why).toBe(true);
  });

  // #199: the camera's SD card (camera.sd, the sd item, a warning item and a problem one, several cameras).
  it('the SD card: read, a warning, a problem, not read yet', () => {
    const sd = { present: true, mounted: true, formatted: true, capacityMB: 30432, freeMB: 900, overwrite: false, recordingEnabled: true, checkedAt: NOW - 60_000, error: null, lastClipAt: NOW - 600_000, lastRecordingAt: NOW - 3 * 3600_000, recordingsFrom: NOW - 48 * 3600_000 };
    for (const h of [
      buildHealth(input({ sd: { ...sd, freeMB: 20000 } })),
      buildHealth(input({ sd, others: [{ ...cam('cam3', true), sd: { ...sd, freeMB: 20000, lastClipAt: null } }, { ...cam('cam4', false), sd: null }] })),
      buildHealth(input({ sd: null })),
    ]) {
      const r = valid(buildHeartbeat(h, PI_INFO).body);
      expect(r.ok, r.why).toBe(true);
    }
  });

  it('four cameras with a site CA and the Archive', () => {
    const hb = buildHeartbeat(fourCams(), SITE_INFO);
    expect(hb.truncated).toBe(false);
    expect((hb.body.summary as { cameras: unknown[] }).cameras).toHaveLength(4);
    const r = valid(hb.body);
    expect(r.ok, r.why).toBe(true);
    // The size the spec asked to measure: a few KiB per camera.
    expect(hb.bytes).toBeLessThan(32 * 1024);
  });

  it('over the cap: items and each camera with its items only, truncated', () => {
    const full = fourCams();
    const hb = buildHeartbeat(full, SITE_INFO, 2000);
    expect(hb.truncated).toBe(true);
    const s = hb.body.summary as Record<string, unknown>;
    expect(Object.keys(s).sort()).toEqual(['cameras', 'generatedAt', 'items', 'ok', 'problemCount', 'schema', 'version']);
    expect((s.cameras as object[])[1]).toEqual({ camera: full.cameras[1].camera, items: full.cameras[1].items });
    const r = valid(hb.body);
    expect(r.ok, r.why).toBe(true);
    expect(HEARTBEAT_MAX_BYTES).toBe(192 * 1024);
  });

  it('long texts are clamped to the contract: 200 characters, 64 for the version', () => {
    const h = buildHealth(input({ version: 'v'.repeat(100), camera: { ...input().camera, name: 'N'.repeat(500), state: { online: false, since: NOW, error: 'E'.repeat(1000) } } }));
    const hb = buildHeartbeat(h, { ...PI_INFO, publicUrl: `https://${'x'.repeat(400)}` });
    const s = hb.body.summary as { version: string; camera: { name: string; error: string }; items: { text: string }[] };
    expect(s.version).toHaveLength(64);
    expect(s.camera.name).toHaveLength(200);
    expect(s.camera.error).toHaveLength(200);
    expect((hb.body.proxy as HeartbeatProxyInfo).publicUrl).toBeNull();
    const r = valid(hb.body);
    expect(r.ok, r.why).toBe(true);
    // The summary given is not changed.
    expect(h.camera.name).toHaveLength(500);
  });
});

describe('the P2 proxy fields', () => {
  it('absent: the P1 shape (the Pi before it is enrolled sends nothing new)', () => {
    const hb = buildHeartbeat(buildHealth(input()), PI_INFO);
    expect(Object.keys(hb.body.proxy as object).sort()).toEqual(['configSchema', 'publicUrl', 'startedAt', 'tls', 'uptimeS']);
  });
  it('present: clamped to the contract bounds, on the strict schema', () => {
    const allow = Array.from({ length: 40 }, () => 'tokens.apply');
    const hb = buildHeartbeat(buildHealth(input()), { ...PI_INFO, commands: { enabled: true, paused: true, pauseReason: 'r'.repeat(300), allow, seenWindow: 1000 }, tokens: { revision: 3, client: 1, admin: 0, blocked: Array.from({ length: 70 }, (_, i) => `tok_${String(i).padStart(20, '0')}`) }, configRevision: `sha256:${'a'.repeat(64)}` });
    const p = hb.body.proxy as { commands: { allow: string[]; pauseReason: string }; tokens: { blocked: string[] }; configRevision: string };
    expect(p.commands.allow).toHaveLength(32);
    expect(p.commands.pauseReason).toHaveLength(200);
    expect(p.tokens.blocked).toHaveLength(64);
    const v = strict('heartbeat');
    const m = buildEnvelope('heartbeat', 2, hb.body, { now: NOW });
    expect(v(m), why(v)).toBe(true);
  });
});

describe('the change key (an early heartbeat)', () => {
  it('changes with ok, problemCount or a camera going on- or offline; not with the time', () => {
    const a = fourCams();
    expect(changeKeyOf({ ...a, generatedAt: a.generatedAt + 5000 })).toBe(changeKeyOf(a));
    expect(changeKeyOf({ ...a, ok: !a.ok })).not.toBe(changeKeyOf(a));
    expect(changeKeyOf({ ...a, problemCount: a.problemCount + 1 })).not.toBe(changeKeyOf(a));
    const c = structuredClone(a);
    c.cameras[0].camera.online = false;
    expect(changeKeyOf(c)).not.toBe(changeKeyOf(a));
  });
});

describe('moveLeftovers in the heartbeat (plan D)', () => {
  const MV = 'mv_0123456789ABCDEFGHJK';
  it('only when non-empty, kept when truncated, clamped to 16 x 4 and 80 characters', () => {
    const none = buildHeartbeat(buildHealth(input()), PI_INFO, undefined, null, []);
    expect(none.body).not.toHaveProperty('moveLeftovers');
    const one = [{ camera: 'cam4', moveId: MV, items: ['config.json entry', 'env CAMPROXY_CAMERA_PASSWORD_CAM4'] }];
    const hb = buildHeartbeat(buildHealth(input()), PI_INFO, undefined, null, one);
    expect(hb.body.moveLeftovers).toEqual(one);
    expect(valid(hb.body).ok, valid(hb.body).why).toBe(true);
    const many = Array.from({ length: 20 }, (_, i) => ({ camera: `cam${i}`, moveId: MV, items: ['a'.repeat(100), 'b', 'c', 'd', 'e'] }));
    const big = buildHeartbeat(buildHealth(input()), PI_INFO, undefined, null, many);
    const ml = big.body.moveLeftovers as { items: string[] }[];
    expect(ml).toHaveLength(16);
    expect(ml[0].items).toHaveLength(4);
    expect(ml[0].items[0]).toHaveLength(80);
    expect(valid(big.body).ok, valid(big.body).why).toBe(true);
    const short = buildHeartbeat(fourCams(), SITE_INFO, 2000, null, one);
    expect(short.truncated).toBe(true);
    expect(short.body.moveLeftovers).toEqual(one);
  });
});

describe('the onboarding field (spec 2026-10-30-camera-onboarding-design §4.5)', () => {
  it('the heartbeat carries onboarding {cam: {ready, missing}} and passes the strict schema, also truncated', () => {
    const hb = buildHeartbeat(fourCams(), PI_INFO, 2_000, null, [], { cam1: { ready: false, missing: ['trust'] } });
    expect(hb.truncated).toBe(true);
    expect(hb.body.onboarding).toEqual({ cam1: { ready: false, missing: ['trust'] } });
    expect(valid(hb.body).ok, valid(hb.body).why).toBe(true);
    const full = buildHeartbeat(buildHealth(input()), PI_INFO, undefined, null, [], { cam1: { ready: true, missing: ['ftp'] } });
    expect([full.truncated, full.body.onboarding]).toEqual([false, { cam1: { ready: true, missing: ['ftp'] } }]);
    expect(valid(full.body).ok).toBe(true);
    expect(buildHeartbeat(buildHealth(input()), PI_INFO, undefined, null, [], {}).body).not.toHaveProperty('onboarding');
    const many = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`cam${i}`, { ready: true, missing: [] as never[] }]));
    expect(Object.keys(buildHeartbeat(buildHealth(input()), PI_INFO, undefined, null, [], many).body.onboarding as object)).toHaveLength(64);
  });
});
