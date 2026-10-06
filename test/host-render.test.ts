import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../src/config/defaults';
import { loadConfig } from '../src/config/load';
import { parseHost } from '../scripts/host/host-config';
import { renderHost } from '../scripts/host/render';

const h = () => parseHost(JSON.parse(readFileSync(join(__dirname, '..', 'deploy', 'host', 'host.example.json'), 'utf8')));
const lines = (t: string) => t.split('\n').map((l) => l.trim());

describe('host files (spec §14.2)', () => {
  it('nftables: forward drops, LAN to cameras only, cameras counted; input as listed', () => {
    const t = renderHost(h())['etc/nftables.conf'].text;
    const l = lines(t);
    expect(l).toContain('table inet filter {');
    expect(l).toContain('type filter hook forward priority filter; policy drop;');
    expect(l).toContain('ct state established,related accept');
    expect(l).toContain('iifname "enp1s0" oifname "enp2s0" ip daddr 192.168.60.0/24 accept');
    expect(l).toContain('iifname "enp2s0" counter name "cameras_dropped" drop');
    expect(l).toContain('type filter hook input priority filter; policy drop;');
    expect(l).toContain('iifname "lo" accept');
    expect(l).toContain('iifname "enp1s0" tcp dport { 22, 8443 } accept');
    expect(l).toContain('iifname "enp2s0" udp dport { 67, 123 } accept');
    expect(l).toContain('iifname "enp2s0" tcp dport { 2121, 50000-50039 } accept');
    expect(t).not.toContain('masquerade');
    expect(t).not.toContain('8480'); // loopback only (lo accept)
  });

  it('8480 from the LAN only when asked (the switch-over)', () => {
    const d = h();
    d.proxy.httpFromLan = true;
    expect(lines(renderHost(d)['etc/nftables.conf'].text)).toContain('iifname "enp1s0" tcp dport { 22, 8443, 8480 } accept');
  });

  it('dnsmasq: camera side only, no DNS, a lease per device, router and NTP = the host', () => {
    const l = lines(renderHost(h())['etc/dnsmasq.d/camera-net.conf'].text);
    expect(l).toEqual(expect.arrayContaining([
      'interface=enp2s0', 'bind-interfaces', 'port=0',
      'dhcp-range=192.168.60.100,192.168.60.149,255.255.255.0,12h',
      'dhcp-option=option:router,192.168.60.1', 'dhcp-option=option:ntp-server,192.168.60.1', 'dhcp-option=6',
      'dhcp-host=02:00:00:00:60:02,gps208,192.168.60.2,infinite',
      'dhcp-host=02:00:00:00:60:13,cam3,192.168.60.13,infinite',
    ]));
  });

  it('the DHCP netmask follows the prefix', () => {
    const d = h();
    d.cameraNet = { ...d.cameraNet, prefix: 26, pool: ['192.168.60.40', '192.168.60.49'] };
    d.leases = d.leases.filter((l) => l.role === 'switch');
    expect(lines(renderHost(parseHost(d))['etc/dnsmasq.d/camera-net.conf'].text)).toContain('dhcp-range=192.168.60.40,192.168.60.49,255.255.255.192,12h');
  });

  it('fail closed: forwarding is on only while the ruleset is loaded (a drop-in of nftables.service), never from sysctl.d', () => {
    const r = renderHost(h());
    expect(r['etc/sysctl.d/90-camera-net.conf'].text).not.toContain('ip_forward');
    const l = lines(r['etc/systemd/system/nftables.service.d/camera-net.conf'].text);
    expect(l).toEqual(expect.arrayContaining(['[Service]', 'ExecStartPost=/usr/sbin/sysctl -w net.ipv4.ip_forward=1', 'ExecStopPost=/usr/sbin/sysctl -w net.ipv4.ip_forward=0']));
  });

  it('forward drops invalid packets before anything is accepted', () => {
    const l = lines(renderHost(h())['etc/nftables.conf'].text);
    const fwd = l.indexOf('type filter hook forward priority filter; policy drop;');
    expect(l.slice(fwd, fwd + 3)).toEqual(['type filter hook forward priority filter; policy drop;', 'ct state established,related accept', 'ct state invalid drop']);
  });

  it('chrony, sysctl, the camera interface, docker', () => {
    const r = renderHost(h());
    expect(lines(r['etc/chrony/conf.d/camera-net.conf'].text)).toEqual(expect.arrayContaining(['allow 192.168.60.0/24', 'local stratum 10']));
    expect(lines(r['etc/sysctl.d/90-camera-net.conf'].text)).toEqual(expect.arrayContaining(['net.ipv6.conf.all.forwarding = 0', 'net.ipv6.conf.enp2s0.disable_ipv6 = 1', 'net.ipv4.conf.enp1s0.rp_filter = 2']));
    expect(lines(r['etc/network/interfaces.d/enp2s0'].text)).toEqual(expect.arrayContaining(['auto enp2s0', 'iface enp2s0 inet static', 'address 192.168.60.1/24']));
    expect(JSON.parse(r['etc/docker/daemon.json'].text)).toMatchObject({ iptables: false, ip6tables: false, 'ip-forward': false });
  });

  it('one passive range everywhere: firewall, proxy config', () => {
    const r = renderHost(h());
    const cfg = JSON.parse(r['srv/cam-proxy/data/config.json'].text);
    expect(cfg.ftp).toMatchObject({ enabled: true, port: 2121, passive: '50000-50039', publicHost: '192.168.60.1' });
    expect(cfg.poeSwitch).toMatchObject({ model: 'sscpoe-web', host: '192.168.60.2' });
    expect(cfg.cameras.map((c: { id: string; host: string; poeSwitch: { port: number } }) => [c.id, c.host, c.poeSwitch.port])).toEqual([['cam3', '192.168.60.13', 1], ['cam4', '192.168.60.14', 2], ['cam5', '192.168.60.15', 3], ['cam6', '192.168.60.16', 4]]);
    expect(cfg).toMatchObject({ composition: { concurrent: 2 }, recordings: { cacheMB: 8192 }, host: { stats: 'on' } });
    expect(r['srv/cam-proxy/compose.yaml'].text).toContain('network_mode: host');
  });

  // nft -c needs CAP_NET_ADMIN even to check: run where it can (root, or the
  // Debian 13 container of scripts/host/validate-rendered.sh), skip elsewhere.
  const nftCanCheck = spawnSync('nft', ['-c', '-f', '-'], { input: 'table inet probe {}\n' }).status === 0;
  it.skipIf(!nftCanCheck)('nft accepts the ruleset (-c)', () => {
    const t = renderHost(h())['etc/nftables.conf'].text.replace('flush ruleset\n', '');
    const r = spawnSync('nft', ['-c', '-f', '-'], { input: t, encoding: 'utf8' });
    expect(r.stderr).toBe('');
  });

  // The proxy settings it uses (composition.concurrent, an FTP user per
  // camera) come with multi-camera P2: until that is merged this is skipped.
  it.skipIf(!('concurrent' in DEFAULTS.composition))('cam-proxy loads the rendered config.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-hostcfg-'));
    const cfg = JSON.parse(renderHost(h())['srv/cam-proxy/data/config.json'].text);
    cfg.server.dataDir = join(dir, 'data');
    writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));
    const loaded = loadConfig({ CAMPROXY_TOKENS: 'a'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'c'.repeat(32), CAMPROXY_CAMERA_PASSWORD: 'cam-pw', CAMPROXY_FTP_PASSWORD: 'f'.repeat(16) }, { cwd: dir });
    expect(loaded.config.cameraOrder).toEqual(['cam3', 'cam4', 'cam5', 'cam6']);
  });

  it('the proxy config turns the site CA on for the host', () => {
    const cfg = JSON.parse(renderHost(h())['srv/cam-proxy/data/config.json'].text);
    expect(cfg.tls).toEqual({ site: 'camhost1', cameraSubnet: '192.168.60.0/24', proxyAddresses: '192.168.1.230,192.168.60.1' });
    expect(cfg.server.tls).toEqual({ port: 8443 });
    expect(cfg.ntp).toEqual({ server: '192.168.60.1' });
  });
});
