import { describe, expect, it } from 'vitest';
import { ACTIONS, actionsParam, auditQuery, filterLabel, outcomeClass, retentionLine, toggleAction, toggleAll, who } from '../web/src/lib/audit';

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
    expect(ACTIONS).toContain('inventory-repair');
    expect(ACTIONS).toContain('storage-paused');
    expect(ACTIONS).toContain('storage-resumed');
    expect(ACTIONS).toContain('camera-poe-on');
    expect(ACTIONS).toContain('still-check');
    expect(ACTIONS).toContain('composition');
    expect(ACTIONS).toContain('camera-check'); // #93
    expect(ACTIONS).toContain('camera-name'); // camera-name design
    expect(ACTIONS).toContain('inventory'); // #72
  });
});

// Klaus 2026-10-05: the action filter is a multi-select; "All actions"
// selects all, and again selects none.
describe('the action filter', () => {
  const all = [...ACTIONS];
  it('lists the automatic analyses', () => {
    expect(ACTIONS).toContain('event-analysis');
  });
  it('toggles one action on and off, keeping the list order', () => {
    expect(toggleAction(['login'], 'logout')).toEqual(['login', 'logout']);
    expect(toggleAction(['logout'], 'login')).toEqual(['login', 'logout']);
    expect(toggleAction(['login', 'logout'], 'login')).toEqual(['logout']);
    expect(toggleAction(all, 'login')).toHaveLength(all.length - 1);
  });
  it('"All actions" selects all, and none when all are selected', () => {
    expect(toggleAll([])).toEqual(all);
    expect(toggleAll(['login'])).toEqual(all);
    expect(toggleAll(all)).toEqual([]);
  });
  it('asks for every action by leaving the filter out, for none it asks nothing', () => {
    expect(actionsParam(all)).toBeUndefined();
    expect(actionsParam([])).toBeNull();
    expect(actionsParam(['logout', 'login'])).toBe('login,logout');
    expect(auditQuery({ limit: 50, actions: ['login', 'logout'] })).toBe('limit=50&action=login%2Clogout');
    expect(auditQuery({ limit: 50, actions: all })).toBe('limit=50');
  });
  it('labels the button by the selection', () => {
    expect(filterLabel(all)).toBe('All actions');
    expect(filterLabel([])).toBe('No actions');
    expect(filterLabel(['login'])).toBe('login');
    expect(filterLabel(['login', 'logout', 'inventory'])).toBe('3 actions');
  });
});

describe('the retention line', () => {
  it('says the days and the records kept', () => {
    expect(retentionLine({ retentionDays: 90, records: 1234 })).toBe('Kept for 90 days (Settings) · 1,234 events in that time.');
    expect(retentionLine({ retentionDays: 1, records: 1 })).toBe('Kept for 1 day (Settings) · 1 event in that time.');
    expect(retentionLine(null)).toBe('Kept for the days set in retention.auditDays (Settings).');
  });
});
