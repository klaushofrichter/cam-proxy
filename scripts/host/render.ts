import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { cameraSubnet, parseHost, type HostDescription } from './host-config';

export type Rendered = Record<string, { text: string; mode: number }>;
const netmask = (prefix: number) => [24, 16, 8, 0].map((sh) => ((prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0) >>> sh) & 255).join('.');

function nftables(h: HostDescription): string {
  const lan = h.lan.iface;
  const cam = h.cameraNet.iface;
  const [a, b] = h.proxy.passive.split('-');
  const lanPorts = [22, h.proxy.httpsPort, ...(h.proxy.httpFromLan ? [h.proxy.httpPort] : [])].join(', ');
  return `#!/usr/sbin/nft -f
# Rendered by scripts/host/render.ts from host.json (spec 2026-10-05-multi-camera-host-design §14.2).
# The only ruleset on this host: Docker runs with "iptables": false.
flush ruleset

table inet filter {
  counter cameras_dropped {}

  chain input {
    type filter hook input priority filter; policy drop;
    ct state established,related accept
    ct state invalid drop
    iifname "lo" accept
    iifname "${lan}" tcp dport { ${lanPorts} } accept
    iifname "${lan}" icmp type echo-request accept
    iifname "${lan}" icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-advert, echo-request } accept
    iifname "${cam}" udp dport { 67, 123 } accept
    iifname "${cam}" tcp dport { ${h.proxy.ftpPort}, ${a}-${b} } accept
    iifname "${cam}" icmp type echo-request accept
  }

  chain forward {
    type filter hook forward priority filter; policy drop;
    ct state established,related accept
    ct state invalid drop
    iifname "${lan}" oifname "${cam}" ip daddr ${cameraSubnet(h)} accept
    iifname "${cam}" counter name "cameras_dropped" drop
  }

  chain output {
    type filter hook output priority filter; policy accept;
  }
}
`;
}

function dnsmasq(h: HostDescription): string {
  const n = h.cameraNet;
  return [
    '# Rendered by scripts/host/render.ts: DHCP for the camera network only (spec §14.2).',
    `interface=${n.iface}`,
    'bind-interfaces',
    'port=0',
    `dhcp-range=${n.pool[0]},${n.pool[1]},${netmask(n.prefix)},12h`,
    `dhcp-option=option:router,${n.address}`,
    `dhcp-option=option:ntp-server,${n.address}`,
    '# No DNS server for the cameras (Ruling P4-2).',
    'dhcp-option=6',
    'dhcp-authoritative',
    ...h.leases.map((l) => `dhcp-host=${l.mac},${l.name},${l.ip},infinite`),
    '',
  ].join('\n');
}

const chrony = (h: HostDescription) => `# Rendered by scripts/host/render.ts: NTP for the cameras (spec §14.2).\nallow ${cameraSubnet(h)}\nlocal stratum 10\n`;

const sysctl = (h: HostDescription) => [
  '# Rendered by scripts/host/render.ts (spec §14.2; rp_filter: Ruling P4-3).',
  '# IPv4 forwarding is not set here: nftables.service turns it on once the ruleset is loaded',
  '# (/etc/systemd/system/nftables.service.d/camera-net.conf).',
  'net.ipv6.conf.all.forwarding = 0',
  `net.ipv6.conf.${h.cameraNet.iface}.disable_ipv6 = 1`,
  `net.ipv4.conf.${h.lan.iface}.rp_filter = 2`,
  '',
].join('\n');

// Fail closed: forwarding only while the ruleset is loaded. ExecStartPost runs
// only after nft loaded /etc/nftables.conf; a broken ruleset fails the unit at
// boot and the host routes nothing (systemd-sysctl would turn it on first).
const nftDropIn = () => `# Rendered by scripts/host/render.ts: route only while the firewall is loaded.
[Service]
ExecStartPost=/usr/sbin/sysctl -w net.ipv4.ip_forward=1
ExecStopPost=/usr/sbin/sysctl -w net.ipv4.ip_forward=0
`;

const iface = (h: HostDescription) => `# Rendered by scripts/host/render.ts: the camera network side, static.\nauto ${h.cameraNet.iface}\niface ${h.cameraNet.iface} inet static\n    address ${h.cameraNet.address}/${h.cameraNet.prefix}\n`;

const daemon = () => `${JSON.stringify({ iptables: false, ip6tables: false, 'ip-forward': false, 'log-driver': 'json-file', 'log-opts': { 'max-size': '10m', 'max-file': '3' } }, null, 2)}\n`;

const compose = () => `# cam-proxy on the multi-camera host (docs/multi-camera-host.md). Rendered by
# scripts/host/render.ts. Next to this file: config/.env (secrets, mode 600) and
# data/config.json. Update: docker compose pull && docker compose up -d
services:
  cam-proxy:
    image: ghcr.io/klaushofrichter/cam-proxy:latest
    restart: unless-stopped
    stop_grace_period: 20s
    network_mode: host
    env_file: config/.env
    environment:
      CAMPROXY_CONFIG: /data/config.json
      CAMPROXY_TARGET: host
    volumes:
      - ./data:/data
      - ./config:/config
`;

function proxyConfig(h: HostDescription): string {
  const sw = h.leases.find((l) => l.role === 'switch');
  const cams = h.leases.filter((l) => l.camera);
  return `${JSON.stringify({
    server: { port: h.proxy.httpPort, dataDir: '/data' },
    ...(sw ? { poeSwitch: { model: 'sscpoe-web', host: sw.ip, ports: 8, offSeconds: 10 } } : {}),
    ftp: { enabled: true, port: h.proxy.ftpPort, passive: h.proxy.passive, tls: true, publicHost: h.cameraNet.address },
    composition: { concurrent: 2 },
    recordings: { cacheMB: 8192 },
    host: { stats: 'on' },
    cameras: cams.map((l) => ({ id: l.camera!.id, name: l.camera!.id, host: l.ip, user: 'proxy', ...(l.camera!.poeSwitchPort ? { poeSwitch: { port: l.camera!.poeSwitchPort } } : {}) })),
  }, null, 2)}\n`;
}

export function renderHost(h: HostDescription): Rendered {
  return {
    'etc/nftables.conf': { text: nftables(h), mode: 0o644 },
    'etc/dnsmasq.d/camera-net.conf': { text: dnsmasq(h), mode: 0o644 },
    'etc/chrony/conf.d/camera-net.conf': { text: chrony(h), mode: 0o644 },
    'etc/sysctl.d/90-camera-net.conf': { text: sysctl(h), mode: 0o644 },
    'etc/systemd/system/nftables.service.d/camera-net.conf': { text: nftDropIn(), mode: 0o644 },
    [`etc/network/interfaces.d/${h.cameraNet.iface}`]: { text: iface(h), mode: 0o644 },
    'etc/docker/daemon.json': { text: daemon(), mode: 0o644 },
    'srv/cam-proxy/compose.yaml': { text: compose(), mode: 0o644 },
    'srv/cam-proxy/data/config.json': { text: proxyConfig(h), mode: 0o644 },
  };
}

if (require.main === module) {
  const [file, out] = process.argv.slice(2);
  if (!file || !out) {
    process.stderr.write('usage: npx tsx scripts/host/render.ts <host.json> <out dir>\n');
    process.exit(2);
  }
  const h = parseHost(JSON.parse(readFileSync(file, 'utf8')));
  for (const [path, f] of Object.entries(renderHost(h))) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), f.text, { mode: f.mode });
    process.stdout.write(`${path}\n`);
  }
}
