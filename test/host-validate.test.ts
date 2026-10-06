import { spawnSync } from 'child_process';
import { appendFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// scripts/host/validate-rendered.sh checks the rendered host files with the
// real tools in a Debian 13 container (nothing is applied to this machine).
// The container run needs Docker and the network: opt in with
// CAMPROXY_TEST_HOST_CONTAINER=1.
const SCRIPT = join(__dirname, '..', 'scripts', 'host', 'validate-rendered.sh');
const render = () => {
  const out = mkdtempSync(join(tmpdir(), 'camproxy-rendered-'));
  const r = spawnSync('npx', ['tsx', join(__dirname, '..', 'scripts', 'host', 'render.ts'), join(__dirname, '..', 'deploy', 'host', 'host.example.json'), out], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  return out;
};
const CHECKS = ['nftables', 'dnsmasq', 'chrony', 'interfaces', 'sysctl', 'docker-daemon', 'compose'];

describe('validate-rendered.sh', () => {
  it('is valid bash; refuses a missing directory', () => {
    expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
    const r = spawnSync('bash', [SCRIPT, join(tmpdir(), 'camproxy-no-such-dir')], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage:');
  });

  it.runIf(process.env.CAMPROXY_TEST_HOST_CONTAINER === '1')('the example passes every check; a broken ruleset fails', { timeout: 600_000 }, () => {
    const good = render();
    const r = spawnSync('bash', [SCRIPT, good], { encoding: 'utf8' });
    for (const c of CHECKS) expect(r.stdout, r.stdout + r.stderr).toContain(`PASS ${c}`);
    expect(r.status).toBe(0);
    const bad = render();
    appendFileSync(join(bad, 'etc', 'nftables.conf'), 'table inet broken { chain x { nonsense } }\n');
    const b = spawnSync('bash', [SCRIPT, bad], { encoding: 'utf8' });
    expect(b.stdout).toContain('FAIL nftables');
    expect(b.status).toBe(1);
  });
});
