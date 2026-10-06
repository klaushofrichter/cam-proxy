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
    expect(r.stdout).toContain('+ systemctl enable --now nftables');
    expect(r.stdout).toContain('+ systemctl enable --now dnsmasq chrony');
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
    // The rendered ruleset is checked before anything is placed.
    expect(at('+ nft -c -f')).toBeLessThan(at('changed etc/nftables.conf'));
    // dnsmasq (bind-interfaces) can't start before enp2s0 has its address.
    expect(at('+ ifup enp2s0')).toBeLessThan(at('+ systemctl enable --now dnsmasq chrony'));
    // The ruleset is loaded before sysctl runs (no open window); the drop-in is known to systemd first.
    expect(at('+ systemctl daemon-reload')).toBeLessThan(at('+ systemctl enable --now nftables'));
    expect(at('+ systemctl enable --now nftables')).toBeLessThan(at('+ sysctl --system'));
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

  it('--files-only without root (nft present but not allowed to check, as on a CI runner): the check is skipped, not fatal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-nft-'));
    writeFileSync(join(dir, 'nft'), '#!/bin/sh\necho "Error: Operation not permitted" >&2\nexit 1\n');
    chmodSync(join(dir, 'nft'), 0o755);
    const r = spawnSync('bash', [SCRIPT, '--rendered', render(), '--files-only'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ROOT: mkdtempSync(join(tmpdir(), 'camproxy-root-')), PREPARE_HOST_ALLOW_NON_ROOT: '1' } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('skipped: nft -c');
    expect(r.stdout).toContain('changed etc/nftables.conf');
  });

  // Every system command stubbed and logged; `fail` names commands (with an
  // argument pattern) that exit 1; `routes` is what `ip route` answers.
  function stubbed() {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-stubs-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'calls.log');
    writeFileSync(log, '');
    const fails = join(dir, 'fails');
    writeFileSync(fails, '');
    const routes = join(dir, 'routes');
    writeFileSync(routes, 'default via 192.168.1.1 dev enp1s0\n');
    const stub = (name: string, body = '') => {
      writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${log}"\nwhile read -r pat; do [ -n "$pat" ] && [[ "${name} $*" == $pat ]] && exit 1; done < "${fails}"\n${body || 'exit 0'}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    for (const c of ['apt-get', 'curl', 'sysctl', 'ifup', 'ifdown', 'nft', 'dpkg']) stub(c);
    // nftables runs already (a re-run on a prepared host).
    stub('systemctl', '[ "$1" = is-active ] && echo active; exit 0');
    // ip route show default / ip route get <addr>: from the routes file.
    stub('ip', `case "$*" in "route show default") grep '^default' "${routes}" ;; "route get "*) grep "^$3 " "${routes}" || echo "$3 via 192.168.1.1 dev enp1s0" ;; esac; exit 0`);
    // install -o/-g (the uid 1000 folders) without root: drop the owner.
    stub('install', 'a=(); while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) a+=("$1"); shift ;; esac; done; exec /usr/bin/install "${a[@]}"');
    const root = mkdtempSync(join(tmpdir(), 'camproxy-root-'));
    mkdirSync(join(root, 'etc', 'apt', 'sources.list.d'), { recursive: true });
    writeFileSync(join(root, 'etc', 'apt', 'sources.list.d', 'docker.list'), 'deb …\n');
    const rendered = render();
    // SSH_CLIENT unset unless a test sets it (a console login has none).
    const go = (env: Record<string, string> = {}) => {
      const base: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ROOT: root, PREPARE_HOST_ALLOW_NON_ROOT: '1', ...env };
      if (!('SSH_CLIENT' in env)) delete base.SSH_CLIENT;
      return spawnSync('bash', [SCRIPT, '--rendered', rendered], { encoding: 'utf8', env: base });
    };
    return {
      go, root, rendered,
      calls: () => readFileSync(log, 'utf8'),
      clear: () => writeFileSync(log, ''),
      fail: (...pats: string[]) => writeFileSync(fails, pats.join('\n') + '\n'),
      routes: (text: string) => writeFileSync(routes, text),
    };
  }

  it('a run that fails in the services step leaves its changes pending: the next run still applies them', () => {
    const t = stubbed();
    t.fail('ifup *');
    const first = t.go();
    expect(first.status, first.stdout + first.stderr).not.toBe(0);
    expect(t.calls()).not.toMatch(/systemctl (reload|restart) nftables/);
    t.clear();
    t.fail();
    const second = t.go();
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).not.toMatch(/^changed /m);
    const calls = t.calls();
    expect(calls).toContain('ifup enp2s0');
    expect(calls).toMatch(/systemctl (reload|restart) nftables/);
    expect(calls).toContain('systemctl restart dnsmasq');
    expect(calls).toContain('systemctl restart docker');
    // Done: a third run has nothing pending.
    t.clear();
    expect(t.go().status).toBe(0);
    expect(t.calls()).not.toMatch(/systemctl (reload|restart) nftables/);
    expect(existsSync(join(t.root, 'var', 'lib', 'cam-proxy-host', 'pending'))).toBe(false);
  });

  it('a failure while installing Docker keeps the changes pending too', () => {
    const t = stubbed();
    t.fail('apt-get install -y docker-ce*');
    expect(t.go().status).not.toBe(0);
    expect(readFileSync(join(t.root, 'var', 'lib', 'cam-proxy-host', 'pending'), 'utf8')).toContain('etc/nftables.conf');
    t.clear();
    t.fail();
    expect(t.go().status).toBe(0);
    expect(t.calls()).toContain('ifup enp2s0');
    expect(t.calls()).toMatch(/systemctl (reload|restart) nftables/);
  });

  it('a ruleset that nft refuses is never placed', () => {
    const t = stubbed();
    t.fail(`nft -c -f ${t.rendered}/etc/nftables.conf`);
    const r = t.go();
    expect(r.status).toBe(1);
    expect(r.stdout).not.toMatch(/^changed /m);
    expect(existsSync(join(t.root, 'etc', 'nftables.conf'))).toBe(false);
  });

  it('refuses when the camera interface carries the default route or the SSH session', () => {
    const t = stubbed();
    t.routes('default via 192.168.60.254 dev enp2s0\n');
    const d = t.go();
    expect(d.status).toBe(1);
    expect(d.stderr).toContain('enp2s0 carries the default route');
    expect(existsSync(join(t.root, 'etc', 'nftables.conf'))).toBe(false);
    t.routes('default via 192.168.1.1 dev enp1s0\n192.168.1.35 dev enp2s0 src 192.168.60.1\n');
    const s = t.go({ SSH_CLIENT: '192.168.1.35 50000 22' });
    expect(s.status).toBe(1);
    expect(s.stderr).toContain('enp2s0 carries this SSH session (192.168.1.35)');
    expect(t.calls()).not.toContain('ifdown');
  });

  it('a renamed camera NIC: the old rendered interface file goes (brought down unless it carries a route); a hand-made one stays', () => {
    const t = stubbed();
    const dir = join(t.root, 'etc', 'network', 'interfaces.d');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'enp3s0'), '# Rendered by scripts/host/render.ts: the camera network side, static.\nauto enp3s0\n');
    writeFileSync(join(dir, 'wlan0'), 'auto wlan0\n');
    const r = t.go();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('removed etc/network/interfaces.d/enp3s0');
    expect(existsSync(join(dir, 'enp3s0'))).toBe(false);
    expect(existsSync(join(dir, 'wlan0'))).toBe(true);
    expect(t.calls()).toContain('ifdown --force enp3s0');
    expect(t.calls()).not.toContain('ifup enp3s0');
  });

  it('a changed ruleset on a running host is reloaded (atomic), not restarted; sysctl comes after it', () => {
    const t = stubbed();
    expect(t.go().status).toBe(0);
    writeFileSync(join(t.root, 'etc', 'nftables.conf'), '# edited by hand\n');
    t.clear();
    const r = t.go();
    expect(r.stdout).toContain('changed etc/nftables.conf');
    const calls = t.calls();
    expect(calls).toContain('systemctl reload nftables');
    expect(calls).not.toContain('systemctl restart nftables');
    expect(calls.indexOf('systemctl reload nftables')).toBeLessThan(calls.indexOf('sysctl --system'));
  });
});
