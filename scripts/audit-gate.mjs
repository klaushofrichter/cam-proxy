#!/usr/bin/env node
// The full `npm audit` gate (dev dependencies included) at `high`, with a narrow
// allowlist by advisory id: .github/audit-allowlist.json.
//
//   npm audit --json > audit.json || true
//   node scripts/audit-gate.mjs audit.json [allowlist.json]
//
// Fails (exit 1) on:
// - any high or critical advisory that is not allowlisted;
// - an allowlist entry whose advisory is no longer reported (remove the entry);
// - an allowlisted advisory whose vulnerable range or package changed, or that
//   `npm audit fix` can now fix without a major bump (a fix may exist);
// - a new release of the allowlisted package (`npm view <package> version` is
//   not the `latest` recorded in the entry): check whether it fixes the advisory;
// - an audit report it cannot read (npm audit failed).
// Moderate and low advisories don't block, like `--audit-level=high`.
// The production audit (`npm audit --omit=dev`) runs without this allowlist.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BLOCKING = new Set(['high', 'critical']);

const [reportPath, allowPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'audit-allowlist.json')] =
  process.argv.slice(2);
if (!reportPath) {
  console.error('usage: audit-gate.mjs <npm-audit.json> [allowlist.json]');
  process.exit(2);
}

const errors = [];
const fail = (msg) => errors.push(msg);

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (e) {
  console.error(`::error::cannot read the npm audit report ${reportPath}: ${e.message}`);
  process.exit(1);
}
if (report.error || typeof report.vulnerabilities !== 'object' || report.vulnerabilities === null) {
  console.error(`::error::npm audit did not produce a report: ${JSON.stringify(report.error ?? report).slice(0, 500)}`);
  process.exit(1);
}

const allowlist = JSON.parse(readFileSync(allowPath, 'utf8'));
if (!Array.isArray(allowlist)) {
  console.error(`::error::${allowPath} must be a JSON array`);
  process.exit(1);
}

// Every advisory in the report, by GHSA id (the advisory objects in `via`;
// string entries only point at another package's advisories).
const advisories = new Map();
for (const vuln of Object.values(report.vulnerabilities)) {
  for (const via of vuln.via ?? []) {
    if (typeof via !== 'object' || via === null) continue;
    const id = String(via.url ?? '').match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i)?.[0] ?? `npm-${via.source}`;
    advisories.set(id, { id, name: via.name, title: via.title, severity: via.severity, range: via.range, fixAvailable: vuln.fixAvailable });
  }
}

const allowed = new Map(allowlist.map((e) => [e.id, e]));

for (const a of advisories.values()) {
  if (!BLOCKING.has(a.severity)) {
    console.log(`not blocking (${a.severity}): ${a.id} ${a.name} — ${a.title}`);
    continue;
  }
  if (allowed.has(a.id)) {
    console.log(`::notice::allowlisted (${a.severity}): ${a.id} ${a.name} — see .github/audit-allowlist.json`);
  } else {
    fail(`${a.severity} advisory ${a.id} in ${a.name} (${a.range}): ${a.title}`);
  }
}

for (const e of allowlist) {
  const a = advisories.get(e.id);
  if (!a) {
    fail(`allowlisted ${e.id} (${e.package}) is no longer reported: remove it from .github/audit-allowlist.json`);
    continue;
  }
  if (a.name !== e.package) fail(`allowlisted ${e.id} is now reported for ${a.name}, not ${e.package}: review the entry`);
  if (a.range !== e.range) {
    fail(`allowlisted ${e.id}: vulnerable range is now "${a.range}" (allowlisted "${e.range}"), a fix may exist: update ${e.package} and remove the entry`);
  }
  const fix = a.fixAvailable;
  if (fix === true || (fix && typeof fix === 'object' && !fix.isSemVerMajor)) {
    fail(`allowlisted ${e.id}: npm audit fix can now resolve it without a major bump: fix it and remove the entry`);
  }
  let latest;
  try {
    latest = execFileSync('npm', ['view', e.package, 'version'], { encoding: 'utf8' }).trim();
  } catch (err) {
    fail(`allowlisted ${e.id}: cannot look up the newest ${e.package} release (${err.message.split('\n')[0]})`);
    continue;
  }
  if (latest !== e.latest) {
    fail(`allowlisted ${e.id}: ${e.package} ${latest} was released (allowlist recorded ${e.latest}): check whether it fixes the advisory, then update or remove the entry`);
  }
}

if (errors.length) {
  for (const m of errors) console.error(`::error::${m}`);
  console.error(`audit gate: ${errors.length} problem(s)`);
  process.exit(1);
}
console.log(`audit gate: no unallowlisted high or critical advisories (${advisories.size} advisories, ${allowlist.length} allowlisted)`);
