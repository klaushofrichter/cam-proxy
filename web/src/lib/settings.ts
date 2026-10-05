// The Settings page's text fields as the setting's type. `type` comes with
// /control/config; without it (an older proxy) the current value decides.
export type SettingType = 'integer' | 'boolean' | 'string';

export function parseSetting(type: SettingType | undefined, current: unknown, text: string): unknown {
  const t = type ?? (typeof current === 'number' ? 'integer' : typeof current === 'boolean' ? 'boolean' : 'string');
  if (t === 'integer') return Number(text);
  if (t === 'boolean') return text === 'true';
  return text;
}

// A value as the Settings page says it: numbers with the unit the setting's
// name carries (auditDays → days), booleans on or off.
const UNITS: [RegExp, string, string][] = [
  [/Days$/, 'day', 'days'],
  [/Hours$|^storage\.keepHours\./, 'hour', 'hours'],
  [/Min$/, 'min', 'min'],
  [/(?:S|Seconds)$/, 's', 's'],
  [/MB$/, 'MB', 'MB'],
  [/GB$/, 'GB', 'GB'],
  [/Bytes$/, 'byte', 'bytes'],
  [/Percent$/, '%', '%'],
  [/C$/, '°C', '°C'],
];
export function settingText(path: string, v: unknown): string {
  if (v === undefined || v === null) return 'not set';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'number') {
    const u = UNITS.find(([re]) => re.test(path));
    return u ? `${v} ${v === 1 ? u[1] : u[2]}` : String(v);
  }
  if (v === '') return '(empty)';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

// What Reset goes back to (GET /control/config, on an override): `same`
// when that is the value the override holds (Reset would change nothing),
// `means` what a none / not set / off target does.
export interface ResetTo { value?: unknown; source: 'file' | 'default' | 'env'; same?: true; means?: string }
const target = (path: string, r: ResetTo) => `${settingText(path, r.value)}${r.source === 'file' ? ' (config.json)' : ''}${r.means ? ` (${r.means})` : ''}`;
export const resetLabel = (path: string, r: ResetTo | undefined): string => (r ? `Reset – ${target(path, r)}` : 'Reset');

// An override equal to what Reset restores: a badge instead of the Reset
// button (Klaus 2026-10-05), null otherwise.
const origin = (r: ResetTo) => (r.source === 'file' ? 'config.json' : 'default');
export function sameBadge(path: string, r: ResetTo | undefined): { text: string; title: string } | null {
  if (!r?.same) return null;
  const what = r.source === 'file' ? 'the config.json value' : 'the default';
  return { text: `override = ${origin(r)}`, title: `Kept as an override, but the same as ${what} (${settingText(path, r.value)}): Reset would change nothing, so there is no Reset button. Reset to defaults removes it with the others.` };
}

// "Reset to defaults": each override that changes as "path: current →
// after", then the overrides equal to the default as one line.
type Row = { value?: unknown; source: string; pending?: boolean; next?: unknown; resetTo?: ResetTo };
const overridesOf = (view: Record<string, Row>) => Object.entries(view).filter(([, s]) => s.source === 'override');
export function resetCounts(view: Record<string, Row>): { changes: number; same: number } {
  const o = overridesOf(view);
  const same = o.filter(([, s]) => s.resetTo?.same).length;
  return { changes: o.length - same, same };
}
export function resetPlan(view: Record<string, Row>): string[] {
  const o = overridesOf(view);
  const lines = o.filter(([, s]) => !s.resetTo?.same).map(([p, s]) => `${p}: ${settingText(p, s.pending ? s.next : s.value)} → ${s.resetTo ? target(p, s.resetTo) : 'its default'}`);
  const same = o.filter(([, s]) => s.resetTo?.same);
  if (same.length) {
    const origins = new Set(same.map(([, s]) => origin(s.resetTo as ResetTo)));
    const to = origins.size > 1 ? 'the default or config.json' : origins.has('default') ? 'the default' : 'config.json';
    const n = same.length;
    lines.push(`${n} override${n === 1 ? '' : 's'} equal to ${to} ${n === 1 ? 'is' : 'are'} removed too, no change in effect: ${same.map(([p]) => p).join(', ')}`);
  }
  return lines;
}
