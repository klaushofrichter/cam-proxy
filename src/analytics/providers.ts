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

export interface Box { x0: number; y0: number; x1: number; y1: number } // fractions 0–1
export interface Found { mid?: string; name: string; score: number; box: Box }
interface ProviderResult { objects: Found[]; raw: unknown }
export interface AnalyticsProvider {
  id: ProviderId;
  name: string;
  analyze(jpeg: Buffer, signal: AbortSignal): Promise<ProviderResult>;
}

// A failed call: `reason` is stored, `retry` allows one more try after 30 s,
// `pause` stops the provider (bad_key: until settings/key change; quota: 1 h).
export class AnalyticsError extends Error {
  constructor(
    readonly reason: string,
    readonly retry: boolean,
    readonly pause: 'bad_key' | 'quota' | null = null,
  ) {
    super(reason);
  }
}
