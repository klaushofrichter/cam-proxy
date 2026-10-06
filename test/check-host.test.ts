import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(__dirname, '..', 'deploy', 'host', 'check-host.sh');

const RULESET = (forward: string, extra = '') => `table inet filter {\n counter cameras_dropped {\n  packets 0 bytes 0\n }\n chain forward {\n  type filter hook forward priority filter; policy ${forward};\n }\n}\n${extra}`;

// Stub tools with canned answers, and a fake root with the installed files
// (the camera interface is enp9s0 here: read from them, not assumed).
function setup(o: { iptables?: boolean; dockerChain?: boolean; dockerNat?: boolean; legacyDocker?: boolean; forward?: string; nftDenied?: boolean; drift?: boolean; ipv6?: boolean; noConfig?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-check-'));
  const bin = join(dir, 'bin');
  const root = join(dir, 'root');
  mkdirSync(bin);
  for (const d of ['etc/docker', 'etc/dnsmasq.d', 'etc/network/interfaces.d']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'etc', 'docker', 'daemon.json'), JSON.stringify({ iptables: o.iptables ?? false, ip6tables: false }));
  if (!o.noConfig) {
    writeFileSync(join(root, 'etc', 'dnsmasq.d', 'camera-net.conf'), 'interface=enp9s0\nbind-interfaces\n');
    writeFileSync(join(root, 'etc', 'network', 'interfaces.d', 'enp9s0'), 'auto enp9s0\niface enp9s0 inet static\n    address 192.168.60.1/24\n');
  }
  writeFileSync(join(root, 'etc', 'nftables.conf'), 'flush ruleset\n');
  const loaded = RULESET(o.forward ?? 'drop', o.dockerNat ? 'table ip nat {\n chain DOCKER {\n }\n}\n' : '');
  writeFileSync(join(dir, 'loaded'), loaded.replace('packets 0 bytes 0', 'packets 12 bytes 840'));
  writeFileSync(join(dir, 'fromfile'), o.drift ? RULESET('accept') : loaded);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('sysctl', `case "$2" in *disable_ipv6) echo ${o.ipv6 ? 0 : 1} ;; *) echo 1 ;; esac`);
  if (o.nftDenied) stub('nft', 'echo "Error: Operation not permitted" >&2; exit 1');
  else stub('nft', `case "$*" in *"chain ip filter DOCKER"*) ${o.dockerChain ? 'echo "chain DOCKER {}"; exit 0' : 'exit 1'};; *) cat "${dir}/loaded";; esac`);
  // unshare -n …: the file's ruleset as nft would list it in an empty namespace.
  stub('unshare', `cat "${dir}/fromfile"`);
  stub('iptables-legacy-save', o.legacyDocker ? 'echo ":DOCKER - [0:0]"' : 'exit 0');
  stub('systemctl', 'echo active');
  stub('chronyc', "printf '^* 192.0.2.1  2  6  377  12  +1ms[+1ms] +/- 20ms\\n'");
  stub('ip', `case "$1" in -4) [ "$6" = enp9s0 ] && echo '3: enp9s0    inet 192.168.60.1/24 brd 192.168.60.255 scope global enp9s0' ;; -6) ${o.ipv6 ? `echo '3: enp9s0    inet6 fe80::1/64 scope link'` : 'true'} ;; esac; exit 0`);
  return () => spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ROOT: root } });
}

describe('check-host.sh', () => {
  it('is valid bash', () => {
    expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
  });
  it('all good: every check passes; the camera interface and address come from the installed files', () => {
    const r = setup()();
    expect(r.status, r.stdout).toBe(0);
    for (const c of ['ip_forward', 'docker-iptables', 'nft-forward-drop', 'ruleset-loaded', 'services', 'chrony-synced', 'camera-address', 'camera-ipv6-off']) expect(r.stdout).toContain(`PASS ${c}`);
    expect(r.stdout).toContain('INFO dnsmasq-leases: 0 active leases');
    expect(r.stderr).toBe('');
  });
  it('detects docker iptables (daemon.json, a DOCKER chain in any table, the legacy backend)', () => {
    expect(setup({ iptables: true })().stdout).toContain('FAIL docker-iptables');
    const r = setup({ dockerChain: true })();
    expect(r.stdout).toContain('FAIL docker-iptables');
    expect(r.status).toBe(1);
    const n = setup({ dockerNat: true })();
    expect(n.stdout, 'nat').toContain('FAIL docker-iptables');
    const g = setup({ legacyDocker: true })();
    expect(g.stdout, 'legacy').toContain('FAIL docker-iptables');
  });
  it('a forward chain that accepts is a failure', () => {
    expect(setup({ forward: 'accept' })().stdout).toContain('FAIL nft-forward-drop');
  });
  it('the loaded ruleset differs from /etc/nftables.conf: a failure', () => {
    const r = setup({ drift: true })();
    expect(r.stdout).toContain('FAIL ruleset-loaded: the loaded ruleset differs from /etc/nftables.conf');
    expect(r.status).toBe(1);
  });
  it('IPv6 on the camera side is a failure', () => {
    expect(setup({ ipv6: true })().stdout).toContain('FAIL camera-ipv6-off');
  });
  it('no camera interface in the installed files and no --camera-iface: a failure', () => {
    const r = setup({ noConfig: true })();
    expect(r.stdout).toContain('FAIL camera-config: no interface= in /etc/dnsmasq.d/camera-net.conf; pass --camera-iface and --camera-address');
    expect(r.status).toBe(1);
  });
  it('without root nft reads nothing: a failure, never a silent PASS', () => {
    const r = setup({ nftDenied: true })();
    expect(r.stdout).toContain('FAIL nft-read: nft list ruleset failed (run with sudo)');
    expect(r.stdout).not.toContain('PASS docker-iptables');
    expect(r.status).toBe(1);
  });
});
