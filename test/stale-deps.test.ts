import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { staleDeps } from './helpers/stale-deps';

// The test runs' global setup stops on a node_modules older than the lock.
describe('stale node_modules', () => {
  const tgz = (v: string) => `https://github.com/klaushofrichter/cam-sim/releases/download/${v}/cam-sim-${v}.tgz`;
  const root = (locked: Record<string, unknown>, installed: Record<string, unknown> | null) => {
    const d = mkdtempSync(join(tmpdir(), 'camproxy-deps-'));
    writeFileSync(join(d, 'package-lock.json'), JSON.stringify({ packages: locked }));
    if (installed) {
      mkdirSync(join(d, 'node_modules'));
      writeFileSync(join(d, 'node_modules', '.package-lock.json'), JSON.stringify({ packages: installed }));
    }
    return d;
  };
  it('names a package installed from another tarball than the lock pins', () => {
    const d = root({ 'node_modules/cam-sim': { resolved: tgz('v2026.11.03.1') } }, { 'node_modules/cam-sim': { resolved: tgz('v2026.10.20.1') } });
    expect(staleDeps(d)).toEqual([`cam-sim: installed ${tgz('v2026.10.20.1')}, locked ${tgz('v2026.11.03.1')}`]);
  });
  it('nothing when they match, for a package not installed here (another platform), or without npm\'s record', () => {
    expect(staleDeps(root({ 'node_modules/cam-sim': { resolved: tgz('v1') }, 'node_modules/@esbuild/linux-x64': { version: '1' } }, { 'node_modules/cam-sim': { resolved: tgz('v1') } }))).toEqual([]);
    expect(staleDeps(root({ 'node_modules/cam-sim': { resolved: tgz('v1') } }, null))).toEqual([]);
  });
});
