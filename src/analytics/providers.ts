// External analytics providers (spec 2026-09-30-analytics-design). One entry
// per provider; its settings live under analytics.<configKey>.
export type ProviderId = 'google-vision';

export const PROVIDERS = [
  { id: 'google-vision', name: 'Google Vision', configKey: 'googleVision', keyEnv: 'CAMPROXY_GOOGLE_VISION_KEY' },
] as const satisfies readonly { id: ProviderId; name: string; configKey: 'googleVision'; keyEnv: string }[];

// The key as the UI may show it: first and last four characters.
export function maskKey(key: string | undefined): string | null {
  if (!key) return null;
  if (key.length < 12) return 'set';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
