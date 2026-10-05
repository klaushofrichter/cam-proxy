# Multi-camera P4: host setup (the mini PC) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Debian 13 mini PC with two NICs runs cam-proxy for the camera network behind it: it hands out fixed DHCP leases and NTP to the cameras, routes LAN → cameras, blocks cameras → internet, and cams in the cluster reaches the proxy and the cameras over the router's static route.

**Architecture:** Every host file (nftables, dnsmasq, chrony, sysctl, the camera-side interface, Docker's `daemon.json`, compose) is rendered from one small JSON description of the host by a tested TypeScript renderer, so the rules are reviewed as code and regenerated when a camera is added. A `prepare-host.sh` installs the packages and the rendered files (idempotent, `--dry-run` tested), and a `check-host.sh` verifies the result on the device. Tasks 1–6 are built and tested before the PC arrives; Tasks 7–11 run on the device and record their results in `docs/multi-camera-host.md`.

**Tech Stack:** TypeScript (tsx) for the renderer and the read-only camera probe, bash for install and checks, vitest; on the host: Debian 13 (trixie), nftables, dnsmasq, chrony, Docker CE from Docker's apt repository with the Compose plugin.

**Spec:** `docs/superpowers/specs/2026-10-05-multi-camera-host-design.md` (§8.4 the switch's address, §9 sizing, §14 network and firewall, §15 measure on the real camera and the network checklist, §16 row P4). Depends on the releases of P1 and P2 (`docs/superpowers/plans/2026-10-05-multi-camera-p1-runtime.md`, `…-p2-host-services.md`).

## Global Constraints

- Debian 13 ("trixie"), installed by us; minimal: no desktop, SSH with key auth, unattended security updates. Ubuntu Server 24.04 LTS is an acceptable alternative (netplan instead of `/etc/network/interfaces`, systemd-resolved kept off the camera side) (spec §14.0).
- Docker from Docker's own apt repository, with `"iptables": false, "ip6tables": false` in `/etc/docker/daemon.json`; every container uses host networking; the host's nftables ruleset is the only one (spec §14.0, §14.2).
- LAN side `enp1s0`: an address from the router's DHCP (no reservation; the router keeps an address per MAC). Camera side `enp2s0`: static `192.168.60.1/24`; camera subnet `192.168.60.0/24` (spec §14.1).
- Fixed leases: the GPS-208's management address `.2`; cameras `.11`–`.29` (cam3 → `.13`); a dynamic pool `.100`–`.149` (spec §14.1).
- sysctl: `net.ipv4.ip_forward = 1`; no IPv6 forwarding and no router advertisements on the camera side (spec §14.2).
- nftables `table inet filter`: `forward` policy drop — established/related accept; `iifname enp1s0` to `ip daddr 192.168.60.0/24` accept (all ports); everything from `enp2s0` dropped and counted; no masquerade. `input` policy drop — established; loopback; from `enp1s0`: SSH, 8443, 8480 only from loopback (or the LAN if wanted during the switch-over), ICMP; from `enp2s0`: UDP 67, UDP 123, TCP 2121 and the passive range, ICMP. `output` accept (spec §14.2).
- dnsmasq camera side only: `interface=enp2s0`, `bind-interfaces`, `port=0`, a `dhcp-range` for the pool, one `dhcp-host=<MAC>,<name>,<IP>,infinite` per camera and the switch, `option:router` and `option:ntp-server` = `192.168.60.1` (spec §14.2).
- chrony: public pools over the LAN; `allow 192.168.60.0/24`; `local stratum 10` (spec §14.2).
- Real cameras: settings writes are whole-object Sets only, re-read after writing, log out afterwards (CLAUDE.md). Measurements touching a camera setting run on a camera of the new host, **never on cam1** (spec §15).
- The camera web UI is LAN only; network exposure of anything needs Klaus's approval through kube-setup; kube-setup's repo is never edited from here (CLAUDE.md).
- Two proxies on one data volume stay unsupported; the guide says so (spec §8.1).
- Never print secrets; `.env` files are never sourced in a shell.

## Review Focus

1. **A lease outside the camera subnet, a duplicate MAC or IP, or a lease inside the dynamic pool** in the host description: the renderer refuses it with a message naming the entry (a wrong lease silently gives a camera a random address and breaks the FTP address check of P2). Pinned in Task 1 (`refuses bad leases`).
2. **A camera subnet that overlaps the LAN or the k3s pod/service ranges**: refused at render time (spec §14.1: "P4 checks this against kube-setup's actual CIDRs"). Pinned in Task 1 (`refuses overlapping subnets`).
3. **The FTP passive range in the firewall and in cam-proxy's config disagree**: the renderer takes both from one place and the compose/config output repeats the same range. Pinned in Task 2 (`one passive range everywhere`).
4. **Running `prepare-host.sh` twice**: the second run changes nothing and does not duplicate the Docker repository line or reload a ruleset that would cut the SSH session. Pinned in Task 3 (`idempotent dry run`).
5. **Docker re-enabling its own iptables rules after an upgrade** (a new `daemon.json` from a package): `check-host.sh` fails loudly when `iptables` is not `false` or when a `DOCKER` chain exists. Pinned in Task 4 (`detects docker iptables`).

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `scripts/host/host-config.ts` (new) | the host description: type, validation | 1 |
| `scripts/host/render.ts` (new) | renders every host file from the description; CLI | 2 |
| `deploy/host/host.example.json` (new) | the example description (the first mini PC) | 1 |
| `deploy/host/prepare-host.sh` (new) | installs packages and the rendered files, idempotent | 3 |
| `deploy/host/check-host.sh` (new) | on-device verification | 4 |
| `scripts/measure-camera.ts` (new) | read-only camera probe (GetDevInfo, GetNtp, GetCertificateInfo, served certificate) | 5 |
| `docs/multi-camera-host.md` (new) | the setup guide, the router test, fallbacks, checklists, results | 6, 7–11 |
| `deploy/cluster/REQUEST.md` | the kube-setup request (egress, Secret) | 6 |

## Rulings (spec gaps decided here)

- **Ruling P4-1: the k3s ranges are inputs of the host description** (`clusterCidrs`, default `10.42.0.0/16`, `10.43.0.0/16`), and Task 8 replaces them with kube-setup's actual values before the description is used — spec §14.1 asks for the check, not where the numbers come from — cost if wrong: none; the check runs either way.
- **Ruling P4-2: the dnsmasq `dhcp-option=option:dns-server` is set to nothing (`dhcp-option=6`)** so cameras get no DNS server — spec §14.2 sets `port=0` (no DNS) but dnsmasq would otherwise still announce itself as the DNS server — cost if wrong: a camera tries DNS against the host and times out; nothing else.
- **Ruling P4-3: `rp_filter` is set to 2 (loose) on `enp1s0` from the start** — spec §14.3 lists it as a fix when replies are dropped; Debian's default is already loose for new interfaces, so setting it explicitly only pins the behaviour — cost if wrong: none.
- **Ruling P4-4: the certificate-import measurement of P4 uses `push_cert.py` from the reolink workspace with a throwaway, name-constrained test CA made by `openssl`** (P5's own CA code doesn't exist yet) — spec §16 P4 asks to measure the import of a site-CA RSA 2048 leaf before P5 — cost if wrong: none; P5 repeats the push with its own code.
- **Ruling P4-5: the renderer also writes cam-proxy's `config.json` skeleton for the host** (cameras with ids and addresses from the leases, `poeSwitch.host`, `ftp.publicHost`, the passive range) so the firewall, DHCP and the proxy can't disagree — the spec has the proxy config by hand — cost if wrong: one more generated file; it is only written when absent.

---

### Task 1: The host description and its checks

**Files:**
- Create: `scripts/host/host-config.ts`
- Create: `deploy/host/host.example.json`
- Test: `test/host-config.test.ts` (new)

**Interfaces:**
- Produces (`scripts/host/host-config.ts`):

```ts
export class HostConfigError extends Error {}
export interface Lease { name: string; mac: string; ip: string; role?: 'switch'; camera?: { id: string; poeSwitchPort?: number } }
export interface HostDescription {
  hostname: string;
  lan: { iface: string; subnet: string };                                  // CIDR of the home LAN
  cameraNet: { iface: string; address: string; prefix: number; pool: [string, string] };
  clusterCidrs: string[];                                                  // Ruling P4-1
  proxy: { httpsPort: number; httpPort: number; httpFromLan: boolean; ftpPort: number; passive: string };
  leases: Lease[];
}
export function parseHost(json: unknown): HostDescription;                // shape + every check below; throws HostConfigError
export function ipToInt(ip: string): number;
export function cidrOf(s: string): { base: number; prefix: number };
export function inCidr(ip: string, base: number, prefix: number): boolean;
export function cameraSubnet(h: HostDescription): string;                 // '192.168.60.0/24'
```

- [ ] **Step 1: The example**

Create `deploy/host/host.example.json` (MACs are placeholders: Task 9 puts the real ones in the device's copy, `/srv/cam-proxy/host.json`):

```json
{
  "hostname": "camhost1",
  "lan": { "iface": "enp1s0", "subnet": "192.168.1.0/24" },
  "cameraNet": { "iface": "enp2s0", "address": "192.168.60.1", "prefix": 24, "pool": ["192.168.60.100", "192.168.60.149"] },
  "clusterCidrs": ["10.42.0.0/16", "10.43.0.0/16"],
  "proxy": { "httpsPort": 8443, "httpPort": 8480, "httpFromLan": false, "ftpPort": 2121, "passive": "50000-50039" },
  "leases": [
    { "name": "gps208", "mac": "02:00:00:00:60:02", "ip": "192.168.60.2", "role": "switch" },
    { "name": "cam3", "mac": "02:00:00:00:60:13", "ip": "192.168.60.13", "camera": { "id": "cam3", "poeSwitchPort": 1 } },
    { "name": "cam4", "mac": "02:00:00:00:60:14", "ip": "192.168.60.14", "camera": { "id": "cam4", "poeSwitchPort": 2 } },
    { "name": "cam5", "mac": "02:00:00:00:60:15", "ip": "192.168.60.15", "camera": { "id": "cam5", "poeSwitchPort": 3 } },
    { "name": "cam6", "mac": "02:00:00:00:60:16", "ip": "192.168.60.16", "camera": { "id": "cam6", "poeSwitchPort": 4 } }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Create `test/host-config.test.ts`:

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/host-config.test.ts`
Expected: FAIL with `Failed to resolve import "../scripts/host/host-config"`.

- [ ] **Step 4: Implement**

Create `scripts/host/host-config.ts`:

```ts
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
  const net = cidrOf(`${h.cameraNet.address}/${h.cameraNet.prefix}`);
  const lan = cidrOf(h.lan.subnet);
  if (overlap(net, lan)) fail(`cameraNet: ${show(net)} overlaps lan ${show(lan)}`);
  for (const c of h.clusterCidrs) if (overlap(net, cidrOf(c))) fail(`cameraNet: ${show(net)} overlaps the cluster range ${c}`);
  for (const ip of h.cameraNet.pool) if (!inCidr(ip, net.base, net.prefix)) fail(`cameraNet.pool: ${ip} is outside ${show(net)}`);
  const [lo, hi] = h.cameraNet.pool.map(ipToInt);
  if (lo > hi) fail('cameraNet.pool: the first address must come first');
  const m = /^(\d{1,5})-(\d{1,5})$/.exec(h.proxy.passive);
  if (!m || Number(m[1]) > Number(m[2]) || Number(m[2]) > 65535) fail('proxy.passive: must be A-B with A <= B');
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/host-config.test.ts && npm run lint:types`
Expected: PASS (`4 passed`); no type errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/host/host-config.ts deploy/host/host.example.json test/host-config.test.ts
git commit -m "feat(host): the mini PC's network description and its checks"
```

---

### Task 2: Render the host files

**Files:**
- Create: `scripts/host/render.ts`
- Test: `test/host-render.test.ts` (new)

**Interfaces:**
- Consumes: `parseHost`, `cameraSubnet`, `HostDescription` (Task 1).
- Produces:

```ts
export type Rendered = Record<string, { text: string; mode: number }>;   // path relative to / → content
export function renderHost(h: HostDescription): Rendered;
// keys: 'etc/nftables.conf' (0644), 'etc/dnsmasq.d/camera-net.conf' (0644), 'etc/chrony/conf.d/camera-net.conf' (0644),
//       'etc/sysctl.d/90-camera-net.conf' (0644), 'etc/network/interfaces.d/<iface>' (0644), 'etc/docker/daemon.json' (0644),
//       'srv/cam-proxy/compose.yaml' (0644), 'srv/cam-proxy/data/config.json' (0644, Ruling P4-5: written only when absent by prepare-host.sh)
// CLI: npx tsx scripts/host/render.ts <host.json> <out dir>
```

- [ ] **Step 1: Write the failing test**

Create `test/host-render.test.ts`:

```ts
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
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

  it('chrony, sysctl, the camera interface, docker', () => {
    const r = renderHost(h());
    expect(lines(r['etc/chrony/conf.d/camera-net.conf'].text)).toEqual(expect.arrayContaining(['allow 192.168.60.0/24', 'local stratum 10']));
    expect(lines(r['etc/sysctl.d/90-camera-net.conf'].text)).toEqual(expect.arrayContaining(['net.ipv4.ip_forward = 1', 'net.ipv6.conf.all.forwarding = 0', 'net.ipv6.conf.enp2s0.disable_ipv6 = 1', 'net.ipv4.conf.enp1s0.rp_filter = 2']));
    expect(lines(r['etc/network/interfaces.d/enp2s0'].text)).toEqual(expect.arrayContaining(['auto enp2s0', 'iface enp2s0 inet static', 'address 192.168.60.1/24']));
    expect(JSON.parse(r['etc/docker/daemon.json'].text)).toMatchObject({ iptables: false, ip6tables: false });
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

  it.skipIf(spawnSync('nft', ['--version']).status !== 0)('nft accepts the ruleset (-c)', () => {
    const t = renderHost(h())['etc/nftables.conf'].text.replace('flush ruleset\n', '');
    const r = spawnSync('nft', ['-c', '-f', '-'], { input: t, encoding: 'utf8' });
    expect(r.stderr).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/host-render.test.ts`
Expected: FAIL with `Failed to resolve import "../scripts/host/render"`.

- [ ] **Step 3: Implement**

Create `scripts/host/render.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { cameraSubnet, parseHost, type HostDescription } from './host-config';

export type Rendered = Record<string, { text: string; mode: number }>;
const MASKS: Record<number, string> = { 24: '255.255.255.0', 23: '255.255.254.0', 25: '255.255.255.128' };

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
    `dhcp-range=${n.pool[0]},${n.pool[1]},${MASKS[n.prefix] ?? '255.255.255.0'},12h`,
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
  'net.ipv4.ip_forward = 1',
  'net.ipv6.conf.all.forwarding = 0',
  `net.ipv6.conf.${h.cameraNet.iface}.disable_ipv6 = 1`,
  `net.ipv4.conf.${h.lan.iface}.rp_filter = 2`,
  '',
].join('\n');

const iface = (h: HostDescription) => `# Rendered by scripts/host/render.ts: the camera network side, static.\nauto ${h.cameraNet.iface}\niface ${h.cameraNet.iface} inet static\n    address ${h.cameraNet.address}/${h.cameraNet.prefix}\n`;

const daemon = () => `${JSON.stringify({ iptables: false, ip6tables: false, 'log-driver': 'json-file', 'log-opts': { 'max-size': '10m', 'max-file': '3' } }, null, 2)}\n`;

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
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/host-render.test.ts test/host-config.test.ts && npm run lint:types`
Expected: PASS (the `nft -c` test runs on Linux with nftables installed, e.g. the CI runner after `sudo apt-get install nftables`; it is skipped on a Mac).

- [ ] **Step 5: The CLI**

Run: `npx tsx scripts/host/render.ts deploy/host/host.example.json "$(mktemp -d)"`
Expected: the eight paths printed, one per line.

- [ ] **Step 6: Commit**

```bash
git add scripts/host/render.ts test/host-render.test.ts
git commit -m "feat(host): render nftables, dnsmasq, chrony, sysctl, interface, docker and compose from host.json"
```

---

### Task 3: `prepare-host.sh` (install, idempotent)

**Files:**
- Create: `deploy/host/prepare-host.sh`
- Test: `test/prepare-host.test.ts` (new)

**Interfaces:**
- Consumes: the rendered tree of Task 2.
- Produces: `sudo bash deploy/host/prepare-host.sh --rendered <dir> [--dry-run] [--files-only]`; `ROOT=<dir>` (test seam) prefixes every target path. Output lines: `+ <command>` (dry run), `changed <path>` / `unchanged <path>` per file. `srv/cam-proxy/data/config.json` is installed only when absent (`kept <path>` otherwise).

- [ ] **Step 1: Write the failing test**

Create `test/prepare-host.test.ts`:

```ts
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(__dirname, '..', 'deploy', 'host', 'prepare-host.sh');
const render = () => {
  const out = mkdtempSync(join(tmpdir(), 'camproxy-rendered-'));
  const r = spawnSync('npx', ['tsx', join(__dirname, '..', 'scripts', 'host', 'render.ts'), join(__dirname, '..', 'deploy', 'host', 'host.example.json'), out], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  return out;
};
const run = (args: string[], root: string) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ROOT: root, PREPARE_HOST_ALLOW_NON_ROOT: '1' } });

describe('prepare-host.sh (spec §14)', () => {
  it('is valid bash', () => {
    expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
  });

  it('dry run: the packages, Docker from its own repository, the services', () => {
    const r = run(['--rendered', render(), '--dry-run'], mkdtempSync(join(tmpdir(), 'camproxy-root-')));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('+ apt-get install -y nftables dnsmasq chrony unattended-upgrades ca-certificates curl');
    expect(r.stdout).toContain('https://download.docker.com/linux/debian');
    expect(r.stdout).toContain('+ apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin');
    expect(r.stdout).toContain('+ nft -c -f');
    expect(r.stdout).toContain('+ systemctl enable --now nftables dnsmasq chrony');
  });

  it('idempotent dry run: files installed once, unchanged the second time; config.json kept', () => {
    const rendered = render();
    const root = mkdtempSync(join(tmpdir(), 'camproxy-root-'));
    const first = run(['--rendered', rendered, '--files-only'], root);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('changed etc/nftables.conf');
    expect(readFileSync(join(root, 'etc', 'docker', 'daemon.json'), 'utf8')).toContain('"iptables": false');
    writeFileSync(join(root, 'srv', 'cam-proxy', 'data', 'config.json'), '{"edited":true}\n');
    const second = run(['--rendered', rendered, '--files-only'], root);
    expect(second.stdout).not.toContain('changed ');
    expect(second.stdout).toContain('unchanged etc/nftables.conf');
    expect(second.stdout).toContain('kept srv/cam-proxy/data/config.json');
    expect(readFileSync(join(root, 'srv', 'cam-proxy', 'data', 'config.json'), 'utf8')).toBe('{"edited":true}\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/prepare-host.test.ts`
Expected: FAIL — the script does not exist (`bash -n` exits 127).

- [ ] **Step 3: Write the script**

Create `deploy/host/prepare-host.sh`:

```bash
#!/bin/bash
# Prepares the multi-camera host (Debian 13) for cam-proxy and its camera
# network (docs/multi-camera-host.md, spec 2026-10-05-multi-camera-host-design §14).
# Run as root after rendering the host files:
#   npx tsx scripts/host/render.ts /srv/cam-proxy/host.json /tmp/rendered
#   sudo bash deploy/host/prepare-host.sh --rendered /tmp/rendered
# Idempotent: a second run changes nothing. --dry-run prints the commands;
# --files-only installs only the files (no packages, no services).
# ROOT=<dir> puts every target under <dir> (tests).
set -euo pipefail

RENDERED=''
DRY=0
FILES_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rendered) RENDERED=$2; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --files-only) FILES_ONLY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$RENDERED" ] && [ -d "$RENDERED" ] || { echo "--rendered <dir> (the output of scripts/host/render.ts) is required" >&2; exit 2; }
ROOT=${ROOT:-}
if [ "$(id -u)" -ne 0 ] && [ -z "${PREPARE_HOST_ALLOW_NON_ROOT:-}" ]; then echo "run with sudo" >&2; exit 1; fi

run() { if [ "$DRY" = 1 ]; then echo "+ $*"; else "$@"; fi; }
CHANGED=()

# One rendered file into place: only when it differs (cmp), with its mode.
place() {
  local rel=$1 mode=$2 keep=${3:-}
  local src="$RENDERED/$rel" dst="$ROOT/$rel"
  if [ -n "$keep" ] && [ -e "$dst" ]; then echo "kept $rel"; return; fi
  if [ -e "$dst" ] && cmp -s "$src" "$dst"; then echo "unchanged $rel"; return; fi
  # mkdir + install -m: BSD install (a Mac running the tests) has no -D.
  if [ "$DRY" = 1 ]; then echo "+ install -m $mode $src $dst"; else mkdir -p "$(dirname "$dst")" && install -m "$mode" "$src" "$dst"; fi
  echo "changed $rel"
  CHANGED+=("$rel")
}

if [ "$FILES_ONLY" = 0 ]; then
  echo "== packages"
  run apt-get update
  run apt-get install -y nftables dnsmasq chrony unattended-upgrades ca-certificates curl
  echo "== Docker from Docker's repository (not Debian's docker.io)"
  if [ ! -f "$ROOT/etc/apt/sources.list.d/docker.list" ]; then
    run install -m 0755 -d "$ROOT/etc/apt/keyrings"
    run curl -fsSL https://download.docker.com/linux/debian/gpg -o "$ROOT/etc/apt/keyrings/docker.asc"
    [ -r /etc/os-release ] && . /etc/os-release
    LINE="deb [arch=$(dpkg --print-architecture 2>/dev/null || echo amd64) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME:-trixie} stable"
    if [ "$DRY" = 1 ]; then echo "+ echo '$LINE' > $ROOT/etc/apt/sources.list.d/docker.list"; else echo "$LINE" > "$ROOT/etc/apt/sources.list.d/docker.list"; fi
    run apt-get update
  fi
  run apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

echo "== files"
place etc/nftables.conf 0755
place etc/dnsmasq.d/camera-net.conf 0644
place etc/chrony/conf.d/camera-net.conf 0644
place etc/sysctl.d/90-camera-net.conf 0644
for f in "$RENDERED"/etc/network/interfaces.d/*; do place "etc/network/interfaces.d/$(basename "$f")" 0644; done
place etc/docker/daemon.json 0644
place srv/cam-proxy/compose.yaml 0644
place srv/cam-proxy/data/config.json 0644 keep

[ "$FILES_ONLY" = 1 ] && exit 0

echo "== services"
# Checked before it is loaded: a broken ruleset never replaces a working one
# (the SSH session stays: established connections and SSH from the LAN are accepted).
run nft -c -f "$ROOT/etc/nftables.conf"
run sysctl --system
run systemctl enable --now nftables dnsmasq chrony
# ${CHANGED[@]+…}: an empty array under set -u (bash 3.2 on a Mac).
for rel in ${CHANGED[@]+"${CHANGED[@]}"}; do
  case "$rel" in
    etc/nftables.conf) run systemctl reload nftables ;;
    etc/dnsmasq.d/*) run systemctl restart dnsmasq ;;
    etc/chrony/*) run systemctl restart chrony ;;
    etc/docker/daemon.json) run systemctl restart docker ;;
    etc/network/interfaces.d/*) run ifup "$(basename "$rel")" ;;
  esac
done
echo "== /srv/cam-proxy for uid 1000 (the container's user)"
run install -d -o 1000 -g 1000 -m 0755 "$ROOT/srv/cam-proxy" "$ROOT/srv/cam-proxy/data"
run install -d -o 1000 -g 1000 -m 0700 "$ROOT/srv/cam-proxy/config"
echo "done: run deploy/host/check-host.sh"
```

(In the dry run, `nft -c` and `systemctl enable` print because `run` echoes them: the test's expected lines.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/prepare-host.test.ts`
Expected: PASS (`3 passed`).

- [ ] **Step 5: Commit**

```bash
git add deploy/host/prepare-host.sh test/prepare-host.test.ts
git commit -m "feat(host): prepare-host.sh installs packages, Docker and the rendered files, idempotent"
```

---

### Task 4: `check-host.sh` (on-device verification)

**Files:**
- Create: `deploy/host/check-host.sh`
- Test: `test/check-host.test.ts` (new)

**Interfaces:**
- Produces: `bash deploy/host/check-host.sh [--camera-iface enp2s0] [--camera-address 192.168.60.1/24]`; prints `PASS <check>` or `FAIL <check>: <why>` per check; exit 1 when any fails. Checks: `ip_forward`, `docker-iptables` (daemon.json `iptables: false` and no `DOCKER` chain), `nft-forward-drop`, `services` (nftables, dnsmasq, chrony, docker active), `chrony-synced`, `camera-address`, `dnsmasq-leases` (informational count). `ROOT` prefixes file reads (tests).

- [ ] **Step 1: Write the failing test**

Create `test/check-host.test.ts`:

```ts
import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(__dirname, '..', 'deploy', 'host', 'check-host.sh');

// Stub tools with canned answers, and a fake root with daemon.json.
function setup(o: { iptables?: boolean; dockerChain?: boolean; forward?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-check-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  mkdirSync(join(dir, 'root', 'etc', 'docker'), { recursive: true });
  writeFileSync(join(dir, 'root', 'etc', 'docker', 'daemon.json'), JSON.stringify({ iptables: o.iptables ?? false, ip6tables: false }));
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('sysctl', 'echo 1');
  stub('nft', `case "$*" in *"chain ip filter DOCKER"*) ${o.dockerChain ? 'echo "chain DOCKER {}"; exit 0' : 'exit 1'};; *) printf 'table inet filter {\\n chain forward {\\n  type filter hook forward priority filter; policy ${o.forward ?? 'drop'};\\n }\\n}\\n';; esac`);
  stub('systemctl', 'echo active');
  stub('chronyc', "printf '^* 192.0.2.1  2  6  377  12  +1ms[+1ms] +/- 20ms\\n'");
  stub('ip', "echo '3: enp2s0    inet 192.168.60.1/24 brd 192.168.60.255 scope global enp2s0'");
  return () => spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ROOT: join(dir, 'root') } });
}

describe('check-host.sh', () => {
  it('is valid bash', () => {
    expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
  });
  it('all good: every check passes', () => {
    const r = setup()();
    expect(r.status).toBe(0);
    for (const c of ['ip_forward', 'docker-iptables', 'nft-forward-drop', 'services', 'chrony-synced', 'camera-address']) expect(r.stdout).toContain(`PASS ${c}`);
  });
  it('detects docker iptables (daemon.json or a DOCKER chain)', () => {
    expect(setup({ iptables: true })().stdout).toContain('FAIL docker-iptables');
    const r = setup({ dockerChain: true })();
    expect(r.stdout).toContain('FAIL docker-iptables');
    expect(r.status).toBe(1);
  });
  it('a forward chain that accepts is a failure', () => {
    expect(setup({ forward: 'accept' })().stdout).toContain('FAIL nft-forward-drop');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/check-host.test.ts`
Expected: FAIL — the script does not exist.

- [ ] **Step 3: Write the script**

Create `deploy/host/check-host.sh`:

```bash
#!/bin/bash
# Checks the multi-camera host after prepare-host.sh (docs/multi-camera-host.md).
# Prints PASS/FAIL per check; exit 1 when any check fails. Read-only.
set -uo pipefail
IFACE=enp2s0
ADDR=192.168.60.1/24
while [ $# -gt 0 ]; do
  case "$1" in
    --camera-iface) IFACE=$2; shift 2 ;;
    --camera-address) ADDR=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
ROOT=${ROOT:-}
FAILED=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1: $2"; FAILED=1; }

[ "$(sysctl -n net.ipv4.ip_forward 2>/dev/null)" = 1 ] && pass ip_forward || fail ip_forward 'net.ipv4.ip_forward is not 1'

if ! grep -Eq '"iptables"[[:space:]]*:[[:space:]]*false' "$ROOT/etc/docker/daemon.json" 2>/dev/null; then
  fail docker-iptables '/etc/docker/daemon.json must have "iptables": false (Docker would set FORWARD to drop and break the routing)'
elif nft list chain ip filter DOCKER >/dev/null 2>&1; then
  fail docker-iptables 'a DOCKER chain exists: Docker added its own rules; restart docker after fixing daemon.json, then reload nftables'
else
  pass docker-iptables
fi

if nft list ruleset 2>/dev/null | grep -A3 'chain forward' | grep -q 'policy drop'; then pass nft-forward-drop; else fail nft-forward-drop 'the forward chain must have policy drop (nft list ruleset)'; fi

BAD=''
for s in nftables dnsmasq chrony docker; do [ "$(systemctl is-active "$s" 2>/dev/null)" = active ] || BAD="$BAD $s"; done
[ -z "$BAD" ] && pass services || fail services "not active:$BAD"

chronyc -n sources 2>/dev/null | grep -q '^\^\*' && pass chrony-synced || fail chrony-synced 'chrony has no selected source (chronyc -n sources)'

ip -4 -o addr show dev "$IFACE" 2>/dev/null | grep -q "inet $ADDR" && pass camera-address || fail camera-address "$IFACE has no $ADDR"

LEASES=$(wc -l < "$ROOT/var/lib/misc/dnsmasq.leases" 2>/dev/null || echo 0)
echo "INFO dnsmasq-leases: $LEASES active leases"
exit $FAILED
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/check-host.test.ts`
Expected: PASS (`4 passed`).

- [ ] **Step 5: Commit**

```bash
git add deploy/host/check-host.sh test/check-host.test.ts
git commit -m "feat(host): check-host.sh verifies forwarding, docker iptables, nftables, services, NTP"
```

---

### Task 5: `measure-camera.ts`: GetNtp, SetNtp (whole object), the certificate state

**Files:**
- Create: `scripts/measure-camera.ts`
- Test: `test/measure-camera.test.ts` (new)

**Interfaces:**
- Produces:

```ts
export interface Measure {
  devInfo: { model: string; firmware: string } | { error: string };
  ntp: Record<string, unknown> | { error: string };               // GetNtp's whole object
  certificateInfo: Record<string, unknown> | { error: string };   // GetCertificateInfo
  served: { fingerprint: string; subject: string; issuer: string; validTo: string } | null;   // the leaf on :443 (not verified)
  setNtp?: { before: unknown; after: unknown } | { error: string };
}
export async function measureCamera(o: { host: string; protocol: 'https' | 'http'; user: string; password: string; setNtp?: string; allowAnyHost?: boolean }): Promise<Measure>;
// CLI: npx tsx scripts/measure-camera.ts --host 192.168.60.13 [--protocol https] [--user proxy] [--set-ntp 192.168.60.1] [--allow-any-host]
// password: CAMPROXY_CAMERA_PASSWORD (or _FILE) from the environment; never printed.
// Refuses a host outside 192.168.60.0/24 unless --allow-any-host (cam1 is never measured: spec §15).
```

- [ ] **Step 1: Write the failing test**

Create `test/measure-camera.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measureCamera } from '../scripts/measure-camera';
import { startSim } from './helpers/sim';

let sim: Awaited<ReturnType<typeof startSim>>;
beforeAll(async () => {
  sim = await startSim();
});
afterAll(async () => {
  await sim.close();
});

describe('measure-camera (spec §15: measure on the real camera first)', () => {
  it('refuses a camera outside the camera network without --allow-any-host', async () => {
    await expect(measureCamera({ host: '192.168.1.103', protocol: 'https', user: 'proxy', password: 'x' })).rejects.toThrow('192.168.1.103 is not on the camera network 192.168.60.0/24 (cam1 is never measured); --allow-any-host to override');
  });

  it('reads what the camera answers; a command it lacks is reported, nothing thrown', async () => {
    const m = await measureCamera({ host: sim.camera.host, protocol: 'http', user: 'proxy', password: sim.password, allowAnyHost: true });
    expect(m.devInfo).toMatchObject({ model: expect.any(String) });
    expect(m.certificateInfo).toMatchObject({ CertificateInfo: { enable: 0 } });
    expect('error' in m.ntp || 'Ntp' in m.ntp).toBe(true);
    expect(JSON.stringify(m)).not.toContain(sim.password);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/measure-camera.test.ts`
Expected: FAIL with `Failed to resolve import "../scripts/measure-camera"`.

- [ ] **Step 3: Implement**

Create `scripts/measure-camera.ts`:

```ts
// Read-only measurements on a camera of the multi-camera host (spec
// 2026-10-05-multi-camera-host-design §15): GetDevInfo, GetNtp,
// GetCertificateInfo and the certificate it serves. --set-ntp writes the
// whole Ntp object with only `server` (and enable) changed, re-reads it, and
// logs out (CLAUDE.md: whole-object Sets only). Never on cam1.
import { createHash, X509Certificate } from 'crypto';
import { readFileSync } from 'fs';
import { connect } from 'tls';
import { ReolinkClient } from '../src/camera/client';
import { bareHost, splitHost } from '../src/camera/http';

export interface Measure {
  devInfo: { model: string; firmware: string } | { error: string };
  ntp: Record<string, unknown> | { error: string };
  certificateInfo: Record<string, unknown> | { error: string };
  served: { fingerprint: string; subject: string; issuer: string; validTo: string } | null;
  setNtp?: { before: unknown; after: unknown } | { error: string };
}

const CAMERA_NET = /^192\.168\.60\.\d{1,3}$/;
const err = (e: unknown) => ({ error: (e as Error).message });

function served(host: string, port: number): Promise<Measure['served']> {
  return new Promise((resolve) => {
    const s = connect({ host, port, rejectUnauthorized: false, servername: undefined }, () => {
      const raw = s.getPeerCertificate(true)?.raw;
      s.destroy();
      if (!raw) return resolve(null);
      const x = new X509Certificate(raw);
      resolve({ fingerprint: createHash('sha256').update(raw).digest('hex').toUpperCase(), subject: x.subject, issuer: x.issuer, validTo: x.validTo });
    });
    s.setTimeout(10_000, () => (s.destroy(), resolve(null)));
    s.on('error', () => resolve(null));
  });
}

export async function measureCamera(o: { host: string; protocol: 'https' | 'http'; user: string; password: string; setNtp?: string; allowAnyHost?: boolean }): Promise<Measure> {
  const { hostname, port } = splitHost(o.host);
  const ip = bareHost(hostname);
  if (!o.allowAnyHost && !CAMERA_NET.test(ip)) throw new Error(`${ip} is not on the camera network 192.168.60.0/24 (cam1 is never measured); --allow-any-host to override`);
  const c = new ReolinkClient({ id: 'measure', host: o.host, protocol: o.protocol, user: o.user, password: o.password });
  const m: Measure = { devInfo: { error: 'not read' }, ntp: { error: 'not read' }, certificateInfo: { error: 'not read' }, served: null };
  try {
    try {
      const s = await c.status();
      m.devInfo = { model: s.model, firmware: s.firmware };
    } catch (e) {
      m.devInfo = err(e);
    }
    try {
      m.ntp = await c.command<Record<string, unknown>>('GetNtp');
    } catch (e) {
      m.ntp = err(e);
    }
    try {
      m.certificateInfo = await c.command<Record<string, unknown>>('GetCertificateInfo');
    } catch (e) {
      m.certificateInfo = err(e);
    }
    if (o.setNtp) {
      try {
        const before = (m.ntp as { Ntp?: Record<string, unknown> }).Ntp;
        if (!before) throw new Error('GetNtp gave no Ntp object: nothing written');
        await c.command('SetNtp', { Ntp: { ...before, enable: 1, server: o.setNtp } });
        const after = (await c.command<{ Ntp?: unknown }>('GetNtp')).Ntp;
        m.setNtp = { before, after };
      } catch (e) {
        m.setNtp = err(e);
      }
    }
  } finally {
    await c.logout().catch(() => undefined);
  }
  if (o.protocol === 'https') m.served = await served(ip, port ?? 443);
  return m;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const password = process.env.CAMPROXY_CAMERA_PASSWORD_FILE ? readFileSync(process.env.CAMPROXY_CAMERA_PASSWORD_FILE, 'utf8').trim() : process.env.CAMPROXY_CAMERA_PASSWORD;
  const host = opt('host');
  if (!host || !password) {
    process.stderr.write('usage: CAMPROXY_CAMERA_PASSWORD=… npx tsx scripts/measure-camera.ts --host <ip> [--protocol https|http] [--user proxy] [--set-ntp <server>] [--allow-any-host]\n');
    process.exit(2);
  }
  measureCamera({ host, protocol: (opt('protocol') as 'https' | 'http') ?? 'https', user: opt('user') ?? 'proxy', password, setNtp: opt('set-ntp'), allowAnyHost: args.includes('--allow-any-host') })
    .then((m) => process.stdout.write(`${JSON.stringify(m, null, 2)}\n`))
    .catch((e: Error) => {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    });
}
```

(`ReolinkClient.command` returns the reply's `value`; GetNtp's value is `{ Ntp: {…} }` and GetCertificateInfo's `{ CertificateInfo: {…} }`, as cam-sim answers: the test reads it that way.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/measure-camera.test.ts && npm run lint:types`
Expected: PASS (`2 passed`).

- [ ] **Step 5: Commit**

```bash
git add scripts/measure-camera.ts test/measure-camera.test.ts
git commit -m "feat(scripts): measure-camera reads GetNtp and the certificate state; --set-ntp writes the whole Ntp object"
```

---

### Task 6: The setup guide and the kube-setup request

**Files:**
- Create: `docs/multi-camera-host.md`
- Modify: `deploy/cluster/REQUEST.md`, `README.md` (link), `CLAUDE.md` (one line)
- Test: `test/host-docs.test.ts` (new)

**Interfaces:**
- Produces: the guide every device task below follows and fills in.

- [ ] **Step 1: Write the failing test**

Create `test/host-docs.test.ts`:

```ts
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const guide = () => readFileSync(join(__dirname, '..', 'docs', 'multi-camera-host.md'), 'utf8');

describe('docs/multi-camera-host.md', () => {
  it('names every host script that exists, and nothing that does not', () => {
    const paths = [...guide().matchAll(/`((?:deploy|scripts)\/[\w./-]+)`/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(4);
    for (const p of paths) expect(existsSync(join(__dirname, '..', p)), p).toBe(true);
  });
  it('has the sections the spec asks for', () => {
    for (const h of ['## 1. Install Debian 13', '## 4. The PoE switch (GPS-208) on 192.168.60.2', '## 5. The router route', '## 6. Test the route on the device', '## 7. If the route fails: the fallbacks, ranked', '## 9. Checklist', '## 11. Sizing (measured)', '## 12. Camera measurements']) expect(guide()).toContain(h);
    expect(guide()).toContain('Two proxies on one data volume are not supported');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/host-docs.test.ts`
Expected: FAIL — `ENOENT … docs/multi-camera-host.md`.

- [ ] **Step 3: Write the guide**

Create `docs/multi-camera-host.md` with these sections (prose in the style of `docs/raspberry-pi.md`; placeholders `<host-lan>` for the PC's LAN address, `<mac-…>` for MACs):

- **What it is**: the mini PC (Ryzen 5 3500U class, 8 GB, NVMe, two NICs), the camera network `192.168.60.0/24` behind it, a second GPS-208, cams in the cluster; the addresses table of spec §14.1.
- **## 1. Install Debian 13**: netinst, no desktop, SSH server only, a user with uid 1000, SSH key auth (`~/.ssh/authorized_keys`, then `PasswordAuthentication no` in `/etc/ssh/sshd_config.d/10-keys.conf`), `unattended-upgrades` (installed by `deploy/host/prepare-host.sh`); the LAN NIC on DHCP; the router keeps the address per MAC (no reservation). Ubuntu 24.04 LTS works too (netplan; keep systemd-resolved off the camera side).
- **## 2. Describe the host**: copy `deploy/host/host.example.json` to `/srv/cam-proxy/host.json`; the NIC names (`ip -br link`), the LAN subnet, the cluster ranges from kube-setup (Task 8), each device's MAC (on its label; the switch's also in callcmd 101's `mac`), the camera ids and switch ports; render with `npx tsx scripts/host/render.ts /srv/cam-proxy/host.json /tmp/rendered` (on the PC: a checkout of cam-proxy, or render on the Mac and copy `/tmp/rendered` over).
- **## 3. Prepare the host**: `sudo bash deploy/host/prepare-host.sh --rendered /tmp/rendered`, then `bash deploy/host/check-host.sh` (every line PASS); what each rendered file does (one line each, from spec §14.2); why Docker runs with `"iptables": false`.
- **## 4. The PoE switch (GPS-208) on 192.168.60.2**: spec §8.4's two cases (DHCP: the lease by MAC; static default: set `192.168.60.2/24`, gateway `192.168.60.1` in its web UI from a laptop on the camera switch, before the firewall is closed); its password in `config/.env` as `CAMPROXY_POE_SWITCH_PASSWORD`; **log out of its web UI after use** (one session; ~3 min lock otherwise); it can't reach the internet (no cloud API).
- **## 5. The router route**: spec §14.3 "Where the route goes" (RT-AX86U, 388_24436, LAN → Route, the row with the PC's LAN address; double-check the Network field), with the result of the 2026-10-05 Mac stand-in test.
- **## 6. Test the route on the device**: spec §14.3 "Test procedure on the device" steps 1–5 verbatim as commands (ping, curl -vk, traceroute from the Mac; the same from a cluster node and a cams pod through the kube-setup session; tcpdump on both NICs; `conntrack -L -d 192.168.60.13`), and "If replies are dropped" in its order (nft counters and ip_forward, rp_filter, ICMP redirects, the router's LAN-to-LAN forwarding, a client firewall).
- **## 7. If the route fails: the fallbacks, ranked**: 1:1 NAT on the host, static routes on the clients, port-forwards (spec §14.3, with their costs).
- **## 8. cam-proxy on the host**: `/srv/cam-proxy` layout (compose.yaml, `config/.env` mode 600 with `CAMPROXY_TOKENS`, `CAMPROXY_ADMIN_TOKEN`, `CAMPROXY_CAMERA_PASSWORD` and `CAMPROXY_CAMERA_PASSWORD_<ID>`, `CAMPROXY_FTP_PASSWORD`, `CAMPROXY_POE_SWITCH_PASSWORD`; `data/config.json` from the renderer), `docker compose pull && docker compose up -d`; per camera: create the `proxy` user on the camera, then the Maintenance page's "Point the camera's FTP here" (each camera logs in as its own FTP user); the proxy's 8480 is loopback only (8443 comes with P5).
- **## 9. Checklist**: spec §15 "Network (manual, on the host)": the Mac and a cluster pod reach a camera's HTTPS; a laptop on the camera switch has no internet (DNS and HTTP out fail) but NTP to `192.168.60.1` works; FTP from a camera arrives; the router route survives a router reboot. Each line with its command and the expected answer.
- **## 10. Operations**: updates (`docker compose pull && docker compose up -d`, with the Pi after each release); backups (`/srv/cam-proxy/data`, later `data/tls`); **Two proxies on one data volume are not supported** (the storage budget counts the whole volume); what blocking the cameras' internet means (no Reolink cloud/P2P, no push, no firmware checks; add by IP in the app); adding a camera (a lease in host.json, re-render, `prepare-host.sh`, then the camera in the Settings page or config.json).
- **## 11. Sizing (measured)**: the table of spec §9 with a "measured" column, filled by Task 11.
- **## 12. Camera measurements**: filled by Task 10 (GetNtp's object, SetNtp's effect, the certificate import result).

`deploy/cluster/REQUEST.md`: append

```markdown
## 2026-10 multi-camera host (P4 of the multi-camera spec)

Asked of the kube-setup session (Klaus applies; nothing here edits kube-setup):

1. cams egress: allow the cams pods to reach `192.168.60.0/24` on TCP 443 (the cameras, over the router's static route to the mini PC) and the mini PC's LAN address on TCP 8443 (cam-proxy over HTTPS from P5 on; 8480 until then if Klaus keeps the switch-over URL). Today the NetworkPolicy allows cams → cam-proxy:8480 only.
2. The route test from a cluster node and from a pod in the cams namespace (docs/multi-camera-host.md §6, step 2): ping, `curl -vk https://192.168.60.13/`, traceroute; and the cluster's pod and service CIDRs for host.json's `clusterCidrs`.
3. The `cams-cameras` Secret gets the new cameras' entries (generated by cams' `scripts/cameras-config.ts`, P3); Klaus applies it.
```

`README.md`: a line under Deployment linking `docs/multi-camera-host.md`. `CLAUDE.md`: "The multi-camera host: `docs/multi-camera-host.md`; its files are rendered by `scripts/host/render.ts` from `host.json`; never edit them on the host by hand."

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/host-docs.test.ts`
Expected: PASS (`2 passed`).

- [ ] **Step 5: Commit**

```bash
git add docs/multi-camera-host.md deploy/cluster/REQUEST.md README.md CLAUDE.md test/host-docs.test.ts
git commit -m "docs: the multi-camera host guide; the kube-setup request"
```

---

## On the device (after the PC arrives)

Each task below runs on the mini PC (or against it) and ends by recording its outcome in `docs/multi-camera-host.md` (a dated "Result" paragraph under the section named) and a commit. They need Klaus where marked (hardware, the router, the switch's web UI, the kube-setup session).

### Task 7: Install and prepare the host

**Files:** Modify `docs/multi-camera-host.md` §1–§3 (Result paragraphs).

- [ ] **Step 1: Install** (Klaus, at the device): Debian 13 netinst per guide §1; SSH key auth works: `ssh <user>@<host-lan> 'uname -m; . /etc/os-release; echo $PRETTY_NAME; ip -br link'`
Expected: `x86_64`, `Debian GNU/Linux 13 (trixie)`, two Ethernet links (note their names: the guide's `enp1s0`/`enp2s0` may differ).

- [ ] **Step 2: Describe and render**: `/srv/cam-proxy/host.json` from the example with the real NIC names; render.
Run: `npx tsx scripts/host/render.ts /srv/cam-proxy/host.json /tmp/rendered`
Expected: eight paths; no `HostConfigError`.

- [ ] **Step 3: Prepare**
Run: `sudo bash deploy/host/prepare-host.sh --rendered /tmp/rendered && bash deploy/host/check-host.sh`
Expected: `done: run deploy/host/check-host.sh`, then every check `PASS` (`chrony-synced` may need a minute).

- [ ] **Step 4: Idempotency on the device**
Run: `sudo bash deploy/host/prepare-host.sh --rendered /tmp/rendered | grep -c '^changed'`
Expected: `0`.

- [ ] **Step 5: Record and commit**

```bash
git add docs/multi-camera-host.md
git commit -m "docs(host): installed and prepared (results)"
```

### Task 8: The cluster ranges (kube-setup)

- [ ] **Step 1:** Ask the kube-setup session for the cluster's pod and service CIDRs (k3s `--cluster-cidr`, `--service-cidr`).
- [ ] **Step 2:** Put them into `/srv/cam-proxy/host.json` `clusterCidrs` (and into `deploy/host/host.example.json` if they differ from the defaults); re-render.
Run: `npx tsx scripts/host/render.ts /srv/cam-proxy/host.json /tmp/rendered`
Expected: no `overlaps the cluster range` error.
- [ ] **Step 3:** Commit the example if it changed (`git commit -m "deploy(host): the cluster's real CIDRs"`).

### Task 9: The camera network: switch, leases, NTP

- [ ] **Step 1: The GPS-208's address** (Klaus): connect it to `enp2s0`'s side; `sudo journalctl -u dnsmasq -n 50 | grep DHCP`.
Expected either a `DHCPACK(enp2s0) 192.168.60.x <mac>` line (DHCP: add its MAC as the `gps208` lease, re-render, `prepare-host.sh`, power-cycle the switch, then `DHCPACK … 192.168.60.2`), or nothing (a static default: set `192.168.60.2/24`, gateway `192.168.60.1` in its web UI from a laptop on the camera switch, guide §4). Then `curl -s -o /dev/null -w '%{http_code}\n' http://192.168.60.2/` from the host.
Expected: `200`. Log out of the switch's web UI.

- [ ] **Step 2: The cameras' leases**: each camera's MAC into host.json, re-render, `prepare-host.sh`; power the cameras (the switch's PoE).
Run: `cat /var/lib/misc/dnsmasq.leases`
Expected: one line per camera with its fixed address (`.13`, `.14`, …) and the switch at `.2`.

- [ ] **Step 3: NTP for the cameras**
Run: `chronyc clients`
Expected: the cameras' addresses appear after they synced (if a camera ignores DHCP option 42, P5's NTP setting covers it; note which ones here).

- [ ] **Step 4: Record and commit** (guide §4, §9 results).

### Task 10: The route, the firewall, and the camera measurements

- [ ] **Step 1: The router route** (Klaus): guide §5 with the PC's LAN address; Apply.
- [ ] **Step 2: From the Mac**
Run: `ping -c 3 192.168.60.13 && curl -vk --connect-timeout 5 https://192.168.60.13/ -o /dev/null && traceroute -n 192.168.60.13`
Expected: 0 % loss; a TLS handshake and an HTTP answer; the router (or not, after an ICMP redirect), the PC, the camera.
- [ ] **Step 3: From a cluster node and a cams pod** (the kube-setup session runs them; REQUEST.md item 2).
Expected: the same answers. If they fail, guide §6's order, then §7's fallbacks.
- [ ] **Step 4: The reply path on the PC**
Run: `sudo tcpdump -ni enp1s0 -c 10 host 192.168.60.13` during a curl from the Mac; `sudo conntrack -L -d 192.168.60.13 | head`
Expected: SYN in on `enp1s0`, SYN-ACK out on `enp1s0` to the Mac's MAC; the flow `ASSURED`.
- [ ] **Step 5: No internet from the camera side** (a laptop on the camera switch, DHCP from the PC)
Run on the laptop: `curl -m 5 http://example.com` and `nslookup example.com` (both fail); `sntp 192.168.60.1` (answers). On the PC: `sudo nft list counter inet filter cameras_dropped`.
Expected: the counter grows.
- [ ] **Step 6: The router route survives a router reboot** (Klaus reboots the router; repeat Step 2).
- [ ] **Step 7: GetNtp and SetNtp on a new camera (never cam1)**
Run (on the PC, with the camera's proxy-user password in the environment from a file, never on the command line): `CAMPROXY_CAMERA_PASSWORD_FILE=/srv/cam-proxy/config/cam3.pw npx tsx scripts/measure-camera.ts --host 192.168.60.13` then `… --set-ntp 192.168.60.1`
Expected: the first prints GetNtp's whole `Ntp` object; the second `setNtp.after.server` is `192.168.60.1`. Record both objects (no password is in the output) in guide §12 and in the Obsidian note *Cameras/Reolink API Behaviour* (vault `general-2026`), and file a cam-sim issue "GetNtp/SetNtp as measured on the RLC-… (firmware …)" with the two objects (cam-sim mirrors the real camera: measure first).
- [ ] **Step 8: Importing a leaf of a name-constrained CA (Ruling P4-4)**
Make a throwaway test CA and leaf (on the PC, in a temp dir):

```bash
cd "$(mktemp -d)"
cat > ca.cnf <<'CNF'
[req]
distinguished_name = dn
[dn]
[ext]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
nameConstraints = critical,permitted;DNS:measure.internal,permitted;IP:192.168.60.0/255.255.255.0
CNF
openssl req -x509 -newkey rsa:3072 -nodes -keyout ca.key -out ca.crt -days 2 -subj '/CN=measure test CA' -config ca.cnf -extensions ext
openssl req -newkey rsa:2048 -nodes -keyout server.key -out leaf.csr -subj '/CN=cam3.measure.internal'
printf 'subjectAltName=DNS:cam3.measure.internal,IP:192.168.60.13\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' > leaf.ext
openssl x509 -req -in leaf.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 -out server.crt -extfile leaf.ext
```

Run (the camera's admin password from a mode-600 file, so it is never typed or put in a shell history; `push_cert.py` reads `CAMERA_PASSWORD` from its environment): `CAMERA_PASSWORD="$(cat /srv/cam-proxy/config/cam3-admin.pw)" CAMERA_HOST=192.168.60.13 CAMERA_USER=admin TLS_CRT=server.crt TLS_KEY=server.key python3 push_cert.py` (copy `~/Development/reolink/push_cert.py` to the PC first). Then `openssl s_client -connect 192.168.60.13:443 -servername cam3.measure.internal -CAfile ca.crt </dev/null 2>/dev/null | grep 'Verify return code'`.
Expected: push_cert.py logs the new fingerprint; `Verify return code: 0 (ok)`. Record the result (accepted or refused, the served subject) in guide §12 and the Obsidian note. Afterwards clear the camera's certificate back (`CertificateClear` through push_cert.py's logic, or leave it: P5 replaces it with the site CA's leaf) and delete the temp dir.
- [ ] **Step 9: Record and commit** (guide §5, §6, §9, §12).

### Task 11: Sizing (spec §9)

- [ ] **Step 1: Four cam-sims on the PC** (cam-sim's container, `ghcr.io/klaushofrichter/cam-sim:latest`, on loopback ports; a temporary second proxy config pointing at them, data in `/tmp/sizing-data`), stills on for all four, for 30 minutes.
Run: `top -b -n 1 | head -20; free -m; docker stats --no-stream`
Expected: cam-proxy + go2rtc + four ffmpeg grabbers at about a quarter of one core in total (spec §9 estimate); memory well under 2 GB.
- [ ] **Step 2: Two compositions at once** (`composition.concurrent: 2`) while the four stream: the encodes finish; the grabbers keep their 1 still/s (the stills inventory of the window shows no gaps).
- [ ] **Step 3: With the real cameras** after cutover: the Status page's host figures (`host.stats: on`) over a day.
- [ ] **Step 4: Record** the measured column of guide §11 and commit (`git commit -m "docs(host): sizing measured"`).

---

## After the plan (for the coordinator)

- The kube-setup request (REQUEST.md) goes to the kube-setup session; Klaus applies the `cams-cameras` Secret.
- P5 (site CA) starts once Task 10's certificate import result is known.
