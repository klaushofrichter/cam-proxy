// The mini PC's network, described once (spec 2026-10-05-multi-camera-host-design
// §14): render.ts makes every host file from it, so the firewall, DHCP and
// cam-proxy can't disagree. No secrets in here.
export class HostConfigError extends Error {}
export interface Lease { name: string; mac: string; ip: string; role?: 'switch'; camera?: { id: string; poeSwitchPort?: number } }
export interface HostDescription {
  hostname: string;
  lan: { iface: string; subnet: string };
  cameraNet: { iface: string; address: string; prefix: number; pool: [string, string] };
  clusterCidrs: string[];
  proxy: { httpsPort: number; httpPort: number; httpFromLan: boolean; ftpPort: number; passive: string };
  leases: Lease[];
}

const fail = (m: string): never => {
  throw new HostConfigError(m);
};
const IP = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
export function ipToInt(ip: string): number {
  const m = IP.exec(ip);
  if (!m || m.slice(1).some((x) => Number(x) > 255)) fail(`${ip}: not an IPv4 address`);
  return m!.slice(1).reduce((n, x) => n * 256 + Number(x), 0);
}
const intToIp = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
const maskOf = (prefix: number) => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
export function cidrOf(s: string): { base: number; prefix: number } {
  const [ip, p] = s.split('/');
  const prefix = Number(p);
  if (!Number.isInteger(prefix) || prefix < 8 || prefix > 30) fail(`${s}: not a CIDR range /8 to /30`);
  return { base: (ipToInt(ip) & maskOf(prefix)) >>> 0, prefix };
}
export const inCidr = (ip: string, base: number, prefix: number): boolean => ((ipToInt(ip) & maskOf(prefix)) >>> 0) === base;
const overlap = (a: { base: number; prefix: number }, b: { base: number; prefix: number }) => {
  const p = Math.min(a.prefix, b.prefix);
  return ((a.base & maskOf(p)) >>> 0) === ((b.base & maskOf(p)) >>> 0);
};
const show = (c: { base: number; prefix: number }) => `${intToIp(c.base)}/${c.prefix}`;

export function cameraSubnet(h: HostDescription): string {
  return show(cidrOf(`${h.cameraNet.address}/${h.cameraNet.prefix}`));
}

export function parseHost(json: unknown): HostDescription {
  const h = json as HostDescription;
  if (typeof h !== 'object' || h === null) fail('host: must be an object');
  for (const k of ['hostname', 'lan', 'cameraNet', 'clusterCidrs', 'proxy', 'leases'] as const) if (h[k] === undefined) fail(`${k}: required`);
  // Interface names become a file name (interfaces.d) and nft words.
  const IFACE = /^[a-zA-Z0-9_.-]{1,15}$/;
  for (const [k, v] of [['lan.iface', h.lan.iface], ['cameraNet.iface', h.cameraNet.iface]] as const) {
    if (typeof v !== 'string' || !IFACE.test(v) || v.includes('..')) fail(`${k}: ${JSON.stringify(v)} is not an interface name (1-15 of a-z A-Z 0-9 _ . -, no "..")`);
  }
  if (h.cameraNet.iface === h.lan.iface) fail(`cameraNet.iface: ${h.cameraNet.iface} is also lan.iface (the camera side must be the other NIC)`);
  const net = cidrOf(`${h.cameraNet.address}/${h.cameraNet.prefix}`);
  const lan = cidrOf(h.lan.subnet);
  if (overlap(net, lan)) fail(`cameraNet: ${show(net)} overlaps lan ${show(lan)}`);
  for (const c of h.clusterCidrs) if (overlap(net, cidrOf(c))) fail(`cameraNet: ${show(net)} overlaps the cluster range ${c}`);
  for (const ip of h.cameraNet.pool) if (!inCidr(ip, net.base, net.prefix)) fail(`cameraNet.pool: ${ip} is outside ${show(net)}`);
  const [lo, hi] = h.cameraNet.pool.map(ipToInt);
  if (lo > hi) fail('cameraNet.pool: the first address must come first');
  const m = /^(\d{1,5})-(\d{1,5})$/.exec(h.proxy.passive);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2]) || Number(m[2]) > 65535) fail('proxy.passive: must be A-B with A <= B');
  const portKeys = ['httpsPort', 'httpPort', 'ftpPort'] as const;
  for (const k of portKeys) {
    const v = h.proxy[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 65535) fail(`proxy.${k}: ${JSON.stringify(v)} is not a port (1-65535)`);
  }
  portKeys.forEach((k, i) => {
    const other = portKeys.slice(0, i).find((o) => h.proxy[o] === h.proxy[k]);
    if (other) fail(`proxy.${k}: ${h.proxy[k]} is also proxy.${other}`);
    if (h.proxy[k] >= Number(m![1]) && h.proxy[k] <= Number(m![2])) fail(`proxy.${k}: ${h.proxy[k]} is inside proxy.passive ${h.proxy.passive}`);
  });
  // cam-proxy wants at least 10 passive ports per camera (spec §7).
  const ports = Number(m![2]) - Number(m![1]) + 1;
  const cams = h.leases.filter((l) => l.camera).length;
  if (ports < 10 * cams) fail(`proxy.passive: ${h.proxy.passive} has ${ports} ports; ${cams} cameras need at least ${10 * cams} (10 per camera)`);
  const seen = { mac: new Map<string, number>(), ip: new Map<string, number>(), cam: new Map<string, number>() };
  h.leases.forEach((l, i) => {
    const at = `leases[${i}] (${l.name})`;
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(l.mac)) fail(`${at}: MAC must be six lower-case hex pairs with colons`);
    if (!inCidr(l.ip, net.base, net.prefix)) fail(`${at}: ${l.ip} is outside ${show(net)}`);
    if (l.ip === h.cameraNet.address) fail(`${at}: ${l.ip} is the host's own address`);
    const n = ipToInt(l.ip);
    if (n >= lo && n <= hi) fail(`${at}: ${l.ip} is inside the dynamic pool ${h.cameraNet.pool[0]}-${h.cameraNet.pool[1]}`);
    const dup = (kind: 'mac' | 'ip', v: string, label: string) => {
      const j = seen[kind].get(v);
      if (j !== undefined) fail(`${at}: ${label} is also leases[${j}] (${h.leases[j].name})`);
      seen[kind].set(v, i);
    };
    dup('mac', l.mac, `MAC ${l.mac}`);
    dup('ip', l.ip, l.ip);
    if (l.camera) {
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(l.camera.id)) fail(`${at}: camera id ${l.camera.id} is not a camera id`);
      const j = seen.cam.get(l.camera.id);
      if (j !== undefined) fail(`${at}: camera id ${l.camera.id} is also leases[${j}]`);
      seen.cam.set(l.camera.id, i);
    }
  });
  return h;
}
