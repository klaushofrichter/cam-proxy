import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { cameraSubnet, HostConfigError, parseHost } from '../scripts/host/host-config';

const example = () => JSON.parse(readFileSync(join(__dirname, '..', 'deploy', 'host', 'host.example.json'), 'utf8'));
const msg = (json: unknown) => {
  try {
    parseHost(json);
  } catch (e) {
    expect(e).toBeInstanceOf(HostConfigError);
    return (e as Error).message;
  }
  throw new Error('expected a HostConfigError');
};

describe('the host description (spec §14.1)', () => {
  it('the example is valid; the camera subnet', () => {
    expect(cameraSubnet(parseHost(example()))).toBe('192.168.60.0/24');
  });

  it('refuses bad leases', () => {
    const e = example();
    e.leases[1].ip = '192.168.61.13';
    expect(msg(e)).toBe('leases[1] (cam3): 192.168.61.13 is outside 192.168.60.0/24');
    const d = example();
    d.leases[2].mac = d.leases[1].mac;
    expect(msg(d)).toBe('leases[2] (cam4): MAC 02:00:00:00:60:13 is also leases[1] (cam3)');
    const i = example();
    i.leases[2].ip = '192.168.60.13';
    expect(msg(i)).toBe('leases[2] (cam4): 192.168.60.13 is also leases[1] (cam3)');
    const p = example();
    p.leases[1].ip = '192.168.60.120';
    expect(msg(p)).toBe('leases[1] (cam3): 192.168.60.120 is inside the dynamic pool 192.168.60.100-192.168.60.149');
    const h = example();
    h.leases[1].ip = '192.168.60.1';
    expect(msg(h)).toBe("leases[1] (cam3): 192.168.60.1 is the host's own address");
    const m = example();
    m.leases[1].mac = '02-00-00-00-60-13';
    expect(msg(m)).toBe('leases[1] (cam3): MAC must be six lower-case hex pairs with colons');
    const c = example();
    c.leases[2].camera.id = 'cam3';
    expect(msg(c)).toBe('leases[2] (cam4): camera id cam3 is also leases[1]');
  });

  it('refuses overlapping subnets', () => {
    const l = example();
    l.lan.subnet = '192.168.0.0/16';
    expect(msg(l)).toBe('cameraNet: 192.168.60.0/24 overlaps lan 192.168.0.0/16');
    const k = example();
    k.cameraNet = { ...k.cameraNet, address: '10.42.3.1', pool: ['10.42.3.100', '10.42.3.149'] };
    k.leases = [];
    expect(msg(k)).toBe('cameraNet: 10.42.3.0/24 overlaps the cluster range 10.42.0.0/16');
  });

  it('the pool inside the subnet; a passive range A-B', () => {
    const p = example();
    p.cameraNet.pool = ['192.168.60.100', '192.168.61.10'];
    expect(msg(p)).toBe('cameraNet.pool: 192.168.61.10 is outside 192.168.60.0/24');
    const r = example();
    r.proxy.passive = '50039-50000';
    expect(msg(r)).toBe('proxy.passive: must be A-B with A <= B');
  });
});
