import { describe, expect, it } from 'vitest';
import { ACTIONS, auditQuery, outcomeClass, who } from '../web/src/lib/audit';

describe('audit page helpers', () => {
  it('builds the query, leaving out empty values', () => {
    expect(auditQuery({ limit: 50 })).toBe('limit=50');
    expect(auditQuery({ limit: 50, before: '2026-10-01:3', action: 'login', outcome: '' })).toBe('limit=50&before=2026-10-01%3A3&action=login');
  });
  it('names who and the outcome', () => {
    expect(who({ user: { name: 'admin' }, source: { ip: '10.0.0.5' } })).toBe('admin · 10.0.0.5');
    expect(who({ source: { ip: '10.0.0.5' } })).toBe('10.0.0.5');
    expect(who({})).toBe('—');
    expect(outcomeClass({ event: { outcome: 'failure' } })).toBe('bad');
    expect(outcomeClass({ event: { outcome: 'success' } })).toBe('ok');
    expect(outcomeClass({})).toBe('unknown');
    expect(ACTIONS).toContain('storage-daily');
    expect(ACTIONS).toContain('camera-powercycle');
    expect(ACTIONS).toContain('camera-poe-on');
    expect(ACTIONS).toContain('camera-check'); // #93
    expect(ACTIONS).toContain('inventory'); // #72
  });
});
