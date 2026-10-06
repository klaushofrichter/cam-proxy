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
    const n = example();
    n.proxy.passive = '50000-50029';
    expect(msg(n)).toBe('proxy.passive: 50000-50029 has 30 ports; 4 cameras need at least 40 (10 per camera)');
  });

  it('interface names: distinct, and a plain Linux name (they become file names and nft words)', () => {
    const e = example();
    e.cameraNet.iface = 'enp1s0';
    expect(msg(e)).toBe('cameraNet.iface: enp1s0 is also lan.iface (the camera side must be the other NIC)');
    for (const bad of ['../../../x', '..', 'en p2s0', 'a'.repeat(16), '', 'enp2s0"']) {
      const b = example();
      b.cameraNet.iface = bad;
      expect(msg(b)).toBe(`cameraNet.iface: ${JSON.stringify(bad)} is not an interface name (1-15 of a-z A-Z 0-9 _ . -, no "..")`);
    }
    const l = example();
    l.lan.iface = 'x/y';
    expect(msg(l)).toBe('lan.iface: "x/y" is not an interface name (1-15 of a-z A-Z 0-9 _ . -, no "..")');
  });

  it('proxy ports: integers 1-65535, distinct, outside the passive range', () => {
    for (const [k, v] of [['httpsPort', 0], ['httpPort', 70000], ['ftpPort', 21.5], ['httpsPort', '8443']] as const) {
      const p = example();
      (p.proxy as Record<string, unknown>)[k] = v;
      expect(msg(p)).toBe(`proxy.${k}: ${JSON.stringify(v)} is not a port (1-65535)`);
    }
    const d = example();
    d.proxy.ftpPort = 8480;
    expect(msg(d)).toBe('proxy.ftpPort: 8480 is also proxy.httpPort');
    const r = example();
    r.proxy.ftpPort = 50010;
    expect(msg(r)).toBe('proxy.ftpPort: 50010 is inside proxy.passive 50000-50039');
    const z = example();
    z.proxy.passive = '0-39';
    expect(msg(z)).toBe('proxy.passive: must be A-B with A <= B');
  });

  it("lan.address: the PC's LAN address (the router keeps it), inside lan.subnet; the hostname is the site label", () => {
    const e = example();
    delete e.lan.address;
    expect(msg(e)).toBe('lan.address: required (the address the router keeps for this PC)');
    const o = example();
    o.lan.address = '192.168.2.230';
    expect(msg(o)).toBe('lan.address: 192.168.2.230 is outside 192.168.1.0/24');
    const n = example();
    n.hostname = 'CamHost';
    expect(msg(n)).toBe('hostname: "CamHost" is not a site label (a-z 0-9 -, up to 31; it names the site CA)');
  });
});
