import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCRIPT = join(__dirname, '..', 'scripts', 'sync-secrets.sh');
const VALUES = { CAMPROXY_CAMERA_PASSWORD: 'cam-pw-SECRET-1', CAMPROXY_FTP_PASSWORD: 'ftp-pw-SECRET-2', GITHUB_KUBE_SETUP_PAT: 'pat-SECRET-3' };

// A .env and stub kubectl/gh that record their argv and stdin.
function setup(extra = '', mode = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-secrets-'));
  const env = join(dir, '.env.cluster');
  writeFileSync(env, [...Object.entries(VALUES).map(([k, v]) => `${k}=${v}`), 'KUBE_CONTEXT=test-ctx', extra].join('\n') + '\n');
  chmodSync(env, mode);
  const bin = join(dir, 'bin');
  spawnSync('mkdir', [bin]);
  for (const tool of ['kubectl', 'gh']) {
    const stub = join(bin, tool);
    writeFileSync(stub, `#!/usr/bin/env bash\necho "ARGV $*" >> "${dir}/${tool}.log"\nif [ ! -t 0 ]; then cat >> "${dir}/${tool}.log"; fi\n# create --dry-run -o yaml: emit something for the apply stage\nif [[ "$*" == *"create secret"* ]]; then f=""; for a in "$@"; do case "$a" in --from-env-file=*) f="\${a#--from-env-file=}";; esac; done; echo "FILE:"; cat "$f"; fi\n`);
    chmodSync(stub, 0o755);
  }
  const run = (...args: string[]) => spawnSync('bash', [SCRIPT, '--env-file', env, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const log = (tool: string) => (existsSync(join(dir, `${tool}.log`)) ? readFileSync(join(dir, `${tool}.log`), 'utf8') : '');
  return { env, run, log };
}

const noValues = (text: string) => {
  for (const v of Object.values(VALUES)) expect(text).not.toContain(v);
  expect(text).not.toMatch(/[0-9a-f]{64}/); // no generated token
};

describe('sync-secrets.sh', () => {
  it('generates the missing tokens and the FTP password, printing names only', () => {
    const { run, env } = setup();
    writeFileSync(env, readFileSync(env, 'utf8').replace(/^CAMPROXY_FTP_PASSWORD=.*\n/m, ''));
    const r = run(); // local by default: only fills .env
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/generated CAMPROXY_TOKENS/);
    expect(r.stdout).toMatch(/generated CAMPROXY_ADMIN_TOKEN/);
    expect(r.stdout).toMatch(/generated CAMPROXY_FTP_PASSWORD/);
    noValues(r.stdout + r.stderr);
    expect(readFileSync(env, 'utf8')).toMatch(/^CAMPROXY_TOKENS=.{32,}$/m);
  });

  it('a dry run lists what it would sync and changes nothing', () => {
    const { run, log, env } = setup();
    const before = readFileSync(env, 'utf8');
    const r = run('--dry-run', '--only', 'all');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/would set github secret KUBE_SETUP_DEPLOY_TOKEN/);
    expect(r.stdout).toMatch(/would apply kubernetes secret cam-proxy-secrets in cam-proxy \(context test-ctx\): CAMPROXY_TOKENS, CAMPROXY_ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD, CAMPROXY_FTP_PASSWORD/);
    noValues(r.stdout + r.stderr);
    expect(readFileSync(env, 'utf8')).toBe(before);
    expect(log('kubectl') + log('gh')).toBe('');
  });

  it('passes values on stdin or in a file, never in argv', () => {
    const { run, log } = setup();
    const r = run('--only', 'all');
    expect(r.status).toBe(0);
    noValues(r.stdout + r.stderr);
    const argv = (log('kubectl') + log('gh')).split('\n').filter((l) => l.startsWith('ARGV'));
    expect(argv.length).toBeGreaterThan(0);
    for (const l of argv) for (const v of Object.values(VALUES)) expect(l).not.toContain(v);
    expect(log('gh')).toContain('secret set KUBE_SETUP_DEPLOY_TOKEN --repo klaushofrichter/cam-proxy');
    expect(log('gh')).toContain(VALUES.GITHUB_KUBE_SETUP_PAT); // on stdin
    expect(log('kubectl')).toContain('--context test-ctx -n cam-proxy create secret generic cam-proxy-secrets');
    expect(log('kubectl')).toContain(`CAMPROXY_CAMERA_PASSWORD=${VALUES.CAMPROXY_CAMERA_PASSWORD}`); // the env-file, piped to apply
    expect(log('kubectl')).not.toContain('GITHUB_KUBE_SETUP_PAT'); // the PAT is not a cluster secret
  });

  // Issue #5 (Plan 4 review): a typo or a hand-set key isn't rotated silently.
  it('refuses to rotate a key it doesn’t generate', () => {
    const { run } = setup();
    const r = run('--rotate', 'CAMPROXY_CAMERA_PASSWORD');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/can rotate only CAMPROXY_TOKENS, CAMPROXY_ADMIN_TOKEN, CAMPROXY_FTP_PASSWORD/);
    expect(run('--rotate', 'CAMPROXY_TOKEN').status).toBe(2);
  });

  it('refuses a .env that others can read', () => {
    const r = setup('', 0o644).run('--dry-run');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/readable by others/);
  });

  it('refuses an inline comment after a value', () => {
    const { run, env } = setup();
    writeFileSync(env, readFileSync(env, 'utf8').replace(/^CAMPROXY_CAMERA_PASSWORD=(.*)$/m, 'CAMPROXY_CAMERA_PASSWORD=$1 # cam2 proxy user'));
    const r = run('--dry-run');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/CAMPROXY_CAMERA_PASSWORD.*comment/);
    noValues(r.stdout + r.stderr);
  });

  it('needs the camera password before syncing to the cluster', () => {
    const { run, env } = setup();
    writeFileSync(env, readFileSync(env, 'utf8').replace(/^CAMPROXY_CAMERA_PASSWORD=.*\n/m, ''));
    const r = run('--only', 'kube');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/CAMPROXY_CAMERA_PASSWORD/);
  });
});
