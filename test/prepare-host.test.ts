import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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

  it('Debian only: another system is refused before anything is installed; the repository line names its release', () => {
    const root = mkdtempSync(join(tmpdir(), 'camproxy-root-'));
    mkdirSync(join(root, 'etc'), { recursive: true });
    writeFileSync(join(root, 'etc', 'os-release'), 'ID=ubuntu\nVERSION_CODENAME=noble\n');
    const r = run(['--rendered', render(), '--dry-run'], root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('written for Debian (this is ubuntu)');
    expect(r.stdout).not.toContain('apt-get');
    writeFileSync(join(root, 'etc', 'os-release'), 'ID=debian\nVERSION_CODENAME=trixie\n');
    expect(run(['--rendered', render(), '--dry-run'], root).stdout).toContain('https://download.docker.com/linux/debian trixie stable');
  });

  it('order: daemon.json before Docker is installed; the camera interface before dnsmasq starts', () => {
    const out = run(['--rendered', render(), '--dry-run'], mkdtempSync(join(tmpdir(), 'camproxy-root-'))).stdout;
    const at = (s: string) => {
      const i = out.indexOf(s);
      expect(i, s).toBeGreaterThanOrEqual(0);
      return i;
    };
    // Docker's first start must already see "iptables": false (no DOCKER chains, no FORWARD drop).
    expect(at('changed etc/docker/daemon.json')).toBeLessThan(at('+ apt-get install -y docker-ce'));
    // dnsmasq (bind-interfaces) can't start before enp2s0 has its address.
    expect(at('+ ifup enp2s0')).toBeLessThan(at('+ systemctl enable --now nftables dnsmasq chrony'));
    expect(at('+ sysctl --system')).toBeLessThan(at('+ systemctl enable --now nftables dnsmasq chrony'));
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
    expect(second.stdout).not.toMatch(/^changed /m);
    expect(second.stdout).toContain('unchanged etc/nftables.conf');
    expect(second.stdout).toContain('kept srv/cam-proxy/data/config.json');
    expect(readFileSync(join(root, 'srv', 'cam-proxy', 'data', 'config.json'), 'utf8')).toBe('{"edited":true}\n');
  });

  it('a run that fails in the services step leaves its changes pending: the next run still applies them', () => {
    // Stub every system command; each call is logged. ifup fails on the first run.
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-stubs-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'calls.log');
    const stub = (name: string, body = '') => {
      writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${log}"\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    for (const c of ['apt-get', 'curl', 'systemctl', 'sysctl', 'ifdown', 'nft', 'dpkg']) stub(c);
    stub('ifup', `[ -e "${dir}/ifup-fails" ] && exit 1; exit 0`);
    // install -o/-g (the uid 1000 folders) without root: drop the owner.
    stub('install', 'a=(); while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) a+=("$1"); shift ;; esac; done; exec /usr/bin/install "${a[@]}"');
    const root = mkdtempSync(join(tmpdir(), 'camproxy-root-'));
    mkdirSync(join(root, 'etc', 'apt', 'sources.list.d'), { recursive: true });
    writeFileSync(join(root, 'etc', 'apt', 'sources.list.d', 'docker.list'), 'deb …\n');
    const go = () => spawnSync('bash', [SCRIPT, '--rendered', rendered], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ROOT: root, PREPARE_HOST_ALLOW_NON_ROOT: '1' } });
    const rendered = render();
    writeFileSync(join(dir, 'ifup-fails'), '');
    expect(go().status).not.toBe(0);
    expect(readFileSync(log, 'utf8')).not.toContain('systemctl reload nftables');
    writeFileSync(log, '');
    rmSync(join(dir, 'ifup-fails'));
    const second = go();
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).not.toMatch(/^changed /m);
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('ifup enp2s0');
    expect(calls).toContain('systemctl reload nftables');
    expect(calls).toContain('systemctl restart dnsmasq');
    expect(calls).toContain('systemctl restart docker');
    // Done: a third run has nothing pending.
    writeFileSync(log, '');
    expect(go().status).toBe(0);
    expect(readFileSync(log, 'utf8')).not.toContain('systemctl reload nftables');
    expect(existsSync(join(root, 'var', 'lib', 'cam-proxy-host', 'pending'))).toBe(false);
  });
});
