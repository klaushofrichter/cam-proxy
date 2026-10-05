import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { AUDIT_ACTIONS } from '../src/audit/actions';
import { ACTIONS } from '../web/src/lib/audit';

// Every action the proxy writes is in the known list (the API's filter
// check and the Audit page's filter), and the page offers all of them.
const files = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : n.endsWith('.ts') ? [join(d, n)] : []));
const written = new Set<string>();
for (const f of files('src')) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/action: (?:[^,{}]*\? )?'([a-z-]+)'(?: : '([a-z-]+)')?/g)) for (const a of [m[1], m[2]]) if (a) written.add(a);
  for (const m of text.matchAll(/this\.record\('([a-z-]+)'/g)) written.add(m[1]);
}

describe('the known audit actions', () => {
  it('lists every action the proxy writes', () => {
    expect(written.size).toBeGreaterThan(25);
    for (const a of written) expect(AUDIT_ACTIONS, a).toContain(a);
  });
  it('includes the automatic analyses and the Archive records', () => {
    for (const a of ['event-analysis', 'still-check', 'archive-add', 'archive-update', 'archive-delete', 'archive-clear', 'archive-expire', 'camera-address', 'audit-throttled']) expect(AUDIT_ACTIONS).toContain(a);
  });
  it('the Audit page offers the same list', () => {
    expect([...ACTIONS]).toEqual([...AUDIT_ACTIONS]);
  });
});
