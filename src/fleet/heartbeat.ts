import type { HealthSummary } from '../health/summary';

// The heartbeat body (spec 2026-10-06-cams-admin-phase1-design §8.5, §9.3):
// the health summary exactly as GET /api/local/health has it, the proxy
// block, and `truncated`. Texts are clamped to the contract's bounds (200
// characters, 64 for the version); over 192 KiB only the items and each
// camera's id block and items go (contract/v1/health-summary-truncated).
export const HEARTBEAT_MAX_BYTES = 192 * 1024;
const TEXT_MAX = 200;
const VERSION_MAX = 64;
const URL_MAX = 300;

export interface HeartbeatProxyInfo {
  startedAt: number | null;
  uptimeS: number | null;
  configSchema: number | null;
  tls: { site: string; caFingerprint: string[] } | null; // the site CA: public values cams users copy
  publicUrl: string | null;
}

// A copy with every string at most `max` characters.
function clamp<T>(x: T, max = TEXT_MAX): T {
  if (typeof x === 'string') return (x.length > max ? x.slice(0, max) : x) as T;
  if (Array.isArray(x)) return x.map((v) => clamp(v, max)) as T;
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, clamp(v, max)])) as T;
  return x;
}

function info(i: HeartbeatProxyInfo): HeartbeatProxyInfo {
  return {
    startedAt: i.startedAt,
    uptimeS: i.uptimeS,
    configSchema: i.configSchema,
    tls: i.tls ? { site: i.tls.site.slice(0, 63), caFingerprint: i.tls.caFingerprint.slice(0, 2) } : null,
    // A URL cut short would be wrong: none instead.
    publicUrl: i.publicUrl && i.publicUrl.length <= URL_MAX ? i.publicUrl : null,
  };
}

export function buildHeartbeat(summary: HealthSummary, proxy: HeartbeatProxyInfo, maxBytes = HEARTBEAT_MAX_BYTES): { body: Record<string, unknown>; truncated: boolean; bytes: number } {
  const s = clamp(summary);
  s.version = s.version.slice(0, VERSION_MAX);
  const p = info(proxy);
  const full = { summary: s, proxy: p, truncated: false };
  const text = JSON.stringify(full);
  if (Buffer.byteLength(text) <= maxBytes) return { body: full, truncated: false, bytes: Buffer.byteLength(text) };
  const short = {
    summary: { schema: s.schema, generatedAt: s.generatedAt, version: s.version, ok: s.ok, problemCount: s.problemCount, items: s.items, cameras: s.cameras.map((c) => ({ camera: c.camera, items: c.items })) },
    proxy: p,
    truncated: true,
  };
  return { body: short, truncated: true, bytes: Buffer.byteLength(JSON.stringify(short)) };
}

// What makes an early heartbeat (§8.5): ok, problemCount, any camera's online flag.
export const changeKeyOf = (s: HealthSummary): string => `${s.ok}|${s.problemCount}|${s.cameras.map((c) => `${c.camera.id}:${c.camera.online ? 1 : 0}`).join(',')}`;
