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

// What Reset goes back to (GET /control/config, on an override).
export interface ResetTo { value?: unknown; source: 'file' | 'default' | 'env' }
const target = (path: string, r: ResetTo) => `${settingText(path, r.value)}${r.source === 'file' ? ' (config.json)' : ''}`;
export const resetLabel = (path: string, r: ResetTo | undefined): string => (r ? `Reset – ${target(path, r)}` : 'Reset');

// "Reset to defaults": each override as "path: current → after".
type Row = { value?: unknown; source: string; pending?: boolean; next?: unknown; resetTo?: ResetTo };
export function resetPlan(view: Record<string, Row>): string[] {
  return Object.entries(view)
    .filter(([, s]) => s.source === 'override')
    .map(([p, s]) => `${p}: ${settingText(p, s.pending ? s.next : s.value)} → ${s.resetTo ? target(p, s.resetTo) : 'its default'}`);
}
