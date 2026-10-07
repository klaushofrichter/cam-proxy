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
