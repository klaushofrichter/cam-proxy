import { describe, expect, it } from 'vitest';
import { buildHealth } from '../src/health/summary';
import { input, NOW } from './helpers/health-input';

const DAY = 86400_000;
const ok = { mode: 'site-ca' as const, servername: 'cam1.g.internal', fingerprint: 'SHA256:A', notAfter: NOW + 200 * DAY, lastPush: { at: NOW - DAY, outcome: 'pushed' as const }, problem: null };
const item = (h: ReturnType<typeof buildHealth>) => h.items.find((i) => i.id === 'certificates');

describe('the certificates item (spec §10.5)', () => {
  it('absent without a site CA (the Pi)', () => {
    expect(item(buildHealth(input()))).toBeUndefined();
  });
  it('fine: the earliest expiry', () => {
    expect(item(buildHealth(input({ certificates: { proxy: { notAfter: NOW + 300 * DAY }, cameras: [{ id: 'cam1', state: ok }], problems: [] } })))).toEqual({ id: 'certificates', label: 'Certificates', value: 200, text: 'valid 200 more days', problem: false });
  });
  it('a problem within 14 days, after a failed or refused push, or with a CA problem', () => {
    const soon = { ...ok, notAfter: NOW + 10 * DAY };
    expect(item(buildHealth(input({ certificates: { proxy: { notAfter: NOW + 300 * DAY }, cameras: [{ id: 'cam1', state: soon }], problems: [] } })))).toMatchObject({ value: 10, text: 'cam1 expires in 10 days', problem: true });
    const refused = { ...ok, mode: 'pinned' as const, lastPush: { at: NOW, outcome: 'refused' as const } };
    expect(item(buildHealth(input({ certificates: { proxy: null, cameras: [{ id: 'cam1', state: refused }], problems: [] } })))).toMatchObject({ text: 'cam1: push refused (pinned)', problem: true });
    expect(item(buildHealth(input({ certificates: { proxy: null, cameras: [], problems: ['ca.key is missing'] } })))).toMatchObject({ text: 'ca.key is missing', problem: true });
  });
  it("the camera block carries its certificate state", () => {
    const h = buildHealth(input({ certificates: { proxy: null, cameras: [{ id: 'cam1', state: ok }], problems: [] } }));
    expect(h.cameras[0].cert).toEqual(ok);
  });
  it('address outside the CA: named, and a problem', () => {
    const h = buildHealth(input({ certificates: { proxy: { notAfter: NOW + 300 * DAY }, cameras: [], problems: ['192.168.1.231 is outside the site CA: rotate the CA (tls-ca-rotate)'] } }));
    expect(item(h)).toMatchObject({ text: '192.168.1.231 is outside the site CA: rotate the CA (tls-ca-rotate)', problem: true });
  });
  it('a failed push names its camera', () => {
    const failed = { ...ok, mode: 'pinned' as const, lastPush: { at: NOW, outcome: 'failed' as const } };
    expect(item(buildHealth(input({ certificates: { proxy: null, cameras: [{ id: 'cam1', state: failed }], problems: [] } })))).toMatchObject({ text: 'cam1: push failed (pinned)', problem: true });
  });
  it('the proxy certificate within 14 days', () => {
    expect(item(buildHealth(input({ certificates: { proxy: { notAfter: NOW + 5 * DAY }, cameras: [], problems: [] } })))).toMatchObject({ text: 'the proxy expires in 5 days', problem: true });
  });
  it('no certificates yet: not a problem', () => {
    expect(item(buildHealth(input({ certificates: { proxy: null, cameras: [], problems: [] } })))).toMatchObject({ value: null, text: 'no certificates yet', problem: false });
  });
});
