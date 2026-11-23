import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'audit-gate.mjs');
const ALLOWLIST = join(ROOT, '.github', 'audit-allowlist.json');

type Json = Record<string, any>;

// The shapes `npm audit --json` gave for advisories we allowlist (in this repo
// or another one with the same gate). Each is the advisory's own package (the
// advisory object in `via`) plus the packages that depend on it, which the
// report lists as entries of their own with only package names in `via`.
type Fixture = { pkg: string; advisory: Json; fix: Json; dependents: Record<string, string[]> };
const FIXTURES: Record<string, Fixture> = {
  // 2026-10-03: ip, reached through ftp-srv.
  'GHSA-2p57-rm9w-gvfp': {
    pkg: 'ip',
    advisory: {
      source: 1101851,
      name: 'ip',
      dependency: 'ip',
      title: 'ip SSRF improper categorization in isPublic',
      url: 'https://github.com/advisories/GHSA-2p57-rm9w-gvfp',
      severity: 'high',
      range: '<=2.0.1',
    },
    fix: { name: 'ftp-srv', version: '2.16.2', isSemVerMajor: true },
    dependents: { 'ftp-srv': ['ip'] },
  },
  // 2026-11-17: picomatch, reached through vite, vitest, tinyglobby/fdir and
  // the Svelte plugin.
  'GHSA-fc5q-39xc-vjpf': {
    pkg: 'picomatch',
    advisory: {
      source: 1247710,
      name: 'picomatch',
      dependency: 'picomatch',
      title: 'picomatch vulnerable to ReDoS through single-branch repeated extglobs',
      url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
      severity: 'high',
      range: '<=4.0.7',
    },
    fix: { name: 'vitest', version: '3.1.4', isSemVerMajor: true },
    dependents: {
      '@sveltejs/vite-plugin-svelte': ['vite'],
      fdir: ['picomatch'],
      tinyglobby: ['fdir', 'picomatch'],
      vite: ['picomatch', 'tinyglobby'],
      vitest: ['picomatch', 'tinyglobby', 'vite'],
    },
  },
};

function fixture(id: string): Fixture {
  const f = FIXTURES[id];
  if (!f) throw new Error(`no audit fixture for allowlisted ${id}: add one to FIXTURES`);
  return f;
}

// This repo's allowlist, which may be empty. The behaviour tests need at least
// one entry, so with an empty file they run on a sample entry (passed to the
// gate explicitly), built from a fixture.
const real: Json[] = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
const SAMPLE_ID = 'GHSA-fc5q-39xc-vjpf';
const sample = {
  id: SAMPLE_ID,
  package: FIXTURES[SAMPLE_ID].pkg,
  range: FIXTURES[SAMPLE_ID].advisory.range,
  latest: '4.0.7',
  via: 'test sample',
  reason: 'test sample',
  approved: 'test sample',
};
const allowlist: Json[] = real.length ? real : [sample];
const entry = allowlist[0];

// The entries npm audit gives for one advisory: its package and the dependents.
function entries(f: Fixture, over: Json = {}, fix: unknown = f.fix): Json {
  const out: Json = {};
  for (const [name, via] of Object.entries(f.dependents)) {
    out[name] = { name, severity: 'high', via: [...via], fixAvailable: f.fix };
  }
  out[f.pkg] = { name: f.pkg, severity: 'high', via: [{ ...f.advisory, ...over }], fixAvailable: fix };
  return out;
}

// A report with every advisory of `list` (default: the tests' allowlist) and its
// dependents. `over` and `fix` change the first advisory.
function report(extra: Json = {}, over: Json = {}, fix?: unknown, list: Json[] = allowlist): Json {
  let vulnerabilities: Json = {};
  list.forEach((e, i) => {
    const f = fixture(e.id);
    vulnerabilities = { ...vulnerabilities, ...(i === 0 ? entries(f, over, fix ?? f.fix) : entries(f)) };
  });
  return { auditReportVersion: 2, vulnerabilities: { ...vulnerabilities, ...extra } };
}

let dir: string;
let latest: Record<string, string | null>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'audit-gate-'));
  latest = Object.fromEntries(allowlist.map((e) => [e.package, e.latest]));
});

// Runs the gate with `list` as its allowlist, or with this repo's own file
// (the gate's default path) when `list` is null.
function run(rep: Json, list: Json[] | null = allowlist) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  // Stub npm: `npm view <pkg> version` prints latest[pkg]; fails when null or unknown.
  const cases = Object.entries(latest)
    .map(([p, v]) => (v === null ? `  ${p}) echo "npm error 404" >&2; exit 1 ;;` : `  ${p}) echo "${v}" ;;`))
    .join('\n');
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\ncase "$2" in\n${cases}\n  *) echo "npm error 404" >&2; exit 1 ;;\nesac\n`);
  chmodSync(join(bin, 'npm'), 0o755);
  const repPath = join(dir, 'audit.json');
  writeFileSync(repPath, JSON.stringify(rep));
  const args = [SCRIPT, repPath];
  if (list) {
    writeFileSync(join(dir, 'allow.json'), JSON.stringify(list));
    args.push(join(dir, 'allow.json'));
  }
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('audit gate', () => {
  it("passes with this repo's allowlist when its advisories are the only high ones", () => {
    const r = run(report({}, {}, undefined, real), null);
    for (const e of real) expect(r.out).toContain(`allowlisted (high): ${e.id}`);
    expect(r.out).toContain(`(${real.length} advisories, ${real.length} allowlisted)`);
    expect(r.code).toBe(0);
  });

  it('allowlists by GHSA id, with the package, range, latest release, reason and approval recorded', () => {
    expect(Array.isArray(real)).toBe(true);
    for (const e of real) {
      expect(e.id).toMatch(/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
      expect(e).toMatchObject({ package: fixture(e.id).pkg, range: fixture(e.id).advisory.range });
      expect(e.latest).toBeTruthy();
      expect(e.via).toBeTruthy();
      expect(e.reason).toBeTruthy();
      expect(e.approved).toContain('Klaus');
    }
  });

  it('allows the packages whose only cause is an allowlisted advisory (vite, vitest, tinyglobby, fdir, ...)', () => {
    latest = { picomatch: '4.0.7' };
    const list = [{ id: 'GHSA-fc5q-39xc-vjpf', package: 'picomatch', range: '<=4.0.7', latest: '4.0.7' }];
    const r = run({ auditReportVersion: 2, vulnerabilities: entries(FIXTURES['GHSA-fc5q-39xc-vjpf']) }, list);
    expect(r.out).toContain('(1 advisories, 1 allowlisted)');
    expect(r.code).toBe(0);
  });

  it('fails on a new high advisory', () => {
    const r = run(report({
      lodash: { name: 'lodash', severity: 'high', fixAvailable: true, via: [{ source: 1, name: 'lodash', title: 'Prototype pollution', url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm', severity: 'high', range: '<4.17.21' }] },
    }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('::error::high advisory GHSA-35jh-r3h4-6jhm in lodash');
  });

  it('fails on a new high advisory in a package that also depends on an allowlisted one', () => {
    const rep = report();
    const dep = Object.keys(fixture(entry.id).dependents)[0];
    rep.vulnerabilities[dep].via.push({ source: 4, name: dep, title: 'Path traversal', url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff', severity: 'high', range: '*' });
    const r = run(rep);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`high advisory GHSA-dddd-eeee-ffff in ${dep}`);
  });

  it('fails on a critical advisory', () => {
    const r = run(report({
      x: { name: 'x', severity: 'critical', via: [{ source: 2, name: 'x', title: 'RCE', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'critical', range: '*' }] },
    }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('critical advisory GHSA-aaaa-bbbb-cccc');
  });

  it('fails on a second, new high advisory in the allowlisted package', () => {
    const rep = report();
    const f = fixture(entry.id);
    rep.vulnerabilities[f.pkg].via.push({ ...f.advisory, url: 'https://github.com/advisories/GHSA-zzzz-yyyy-xxxx', title: 'another one' });
    const r = run(rep);
    expect(r.code).toBe(1);
    expect(r.out).toContain('GHSA-zzzz-yyyy-xxxx');
  });

  it('does not block on moderate advisories (threshold high)', () => {
    const r = run(report({
      qs: { name: 'qs', severity: 'moderate', via: [{ source: 3, name: 'qs', title: 'DoS', url: 'https://github.com/advisories/GHSA-6rw7-vpxm-498p', severity: 'moderate', range: '<6.14.1' }] },
    }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('not blocking (moderate)');
  });

  it('fails when an allowlisted advisory is no longer reported', () => {
    const r = run({ auditReportVersion: 2, vulnerabilities: {} });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${entry.id} (${entry.package}) is no longer reported: remove it`);
  });

  it('fails when the advisory gets a patched version (its range changes)', () => {
    const r = run(report({}, { range: '<99.0.0' }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('vulnerable range is now "<99.0.0"');
  });

  it('fails when npm audit fix can resolve it without a major bump', () => {
    const r = run(report({}, {}, { name: 'x', version: '1.0.0', isSemVerMajor: false }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('npm audit fix can now resolve it');
  });

  it('fails when a new release of the allowlisted package appears', () => {
    latest[entry.package] = '99.0.0';
    const r = run(report());
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${entry.package} 99.0.0 was released`);
  });

  it('fails when the newest release cannot be looked up', () => {
    latest[entry.package] = null;
    const r = run(report());
    expect(r.code).toBe(1);
    expect(r.out).toContain(`cannot look up the newest ${entry.package} release`);
  });

  it('fails when npm audit produced no report', () => {
    const r = run({ error: { code: 'ENOAUDIT', summary: 'audit endpoint returned an error' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('npm audit did not produce a report');
  });

  it('with an empty allowlist the allowlisted advisories block', () => {
    const r = run(report(), []);
    expect(r.code).toBe(1);
    for (const e of allowlist) expect(r.out).toContain(`high advisory ${e.id} in ${e.package}`);
  });
});
