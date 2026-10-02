// The Settings page's text fields as the setting's type. `type` comes with
// /control/config; without it (an older proxy) the current value decides.
export type SettingType = 'integer' | 'boolean' | 'string';

export function parseSetting(type: SettingType | undefined, current: unknown, text: string): unknown {
  const t = type ?? (typeof current === 'number' ? 'integer' : typeof current === 'boolean' ? 'boolean' : 'string');
  if (t === 'integer') return Number(text);
  if (t === 'boolean') return text === 'true';
  return text;
}
