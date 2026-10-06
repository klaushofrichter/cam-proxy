import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(__dirname, '..', 'deploy', 'host', 'check-host.sh');

// Stub tools with canned answers, and a fake root with daemon.json.
function setup(o: { iptables?: boolean; dockerChain?: boolean; forward?: string; nftDenied?: boolean } = {}) {
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
  if (o.nftDenied) stub('nft', 'echo "Error: Operation not permitted" >&2; exit 1');
  else stub('nft', `case "$*" in *"chain ip filter DOCKER"*) ${o.dockerChain ? 'echo "chain DOCKER {}"; exit 0' : 'exit 1'};; *) printf 'table inet filter {\\n chain forward {\\n  type filter hook forward priority filter; policy ${o.forward ?? 'drop'};\\n }\\n}\\n';; esac`);
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
    expect(r.stdout).toContain('INFO dnsmasq-leases: 0 active leases');
    expect(r.stderr).toBe('');
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
  it('without root nft reads nothing: a failure, never a silent PASS', () => {
    const r = setup({ nftDenied: true })();
    expect(r.stdout).toContain('FAIL nft-read: nft list ruleset failed (run with sudo)');
    expect(r.stdout).not.toContain('PASS docker-iptables');
    expect(r.status).toBe(1);
  });
});
