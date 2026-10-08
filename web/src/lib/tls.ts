// The Certificates card (spec 2026-10-05-multi-camera-host-design §10.4).
import { agoText } from './format';

export interface CertView { mode: 'site-ca' | 'pinned' | 'public' | 'none'; notAfter: number | null; lastPush: { at: number; outcome: string } | null }
export interface TlsView {
  site: string | null;
  caFingerprint: string | null;
  caNotAfter: number | null;
  proxy: { servername: string; fingerprint: string; notAfter: number } | null;
  cameras: (CertView & { id: string; servername: string | null; fingerprint: string | null; problem: string | null })[];
  problems: string[];
}

// One camera's line: its mode, what is left, the last push.
export function certLine(s: CertView, now: number): string {
  if (s.mode === 'none') return 'HTTP: no certificate';
  if (s.mode === 'public') return 'public CA';
  if (s.mode === 'pinned') return s.lastPush?.outcome === 'refused' ? 'pinned: the camera refused the import' : 'pinned';
  const days = s.notAfter === null ? null : Math.floor((s.notAfter - now) / 86400_000);
  return ['site CA', ...(days !== null ? [`${days} days left`] : []), ...(s.lastPush ? [`${s.lastPush.outcome} ${agoText(s.lastPush.at, now)}`] : [])].join(', ');
}

// The fingerprint in groups of four, for reading aloud.
export const fingerprintGroups = (fp: string): string => `SHA256: ${(fp.replace(/^SHA256:/, '').match(/.{1,4}/g) ?? []).join(' ')}`;

// #203: the Status page's short Certificates card and the Certificates page.
const MODE_TEXT: Record<CertView['mode'], string> = { 'site-ca': 'site CA', pinned: 'pinned', public: 'public CA', none: 'HTTP' };
export const modeText = (m: CertView['mode']): string => MODE_TEXT[m] ?? m;

const DAY = 86400_000;
export function expiresText(notAfter: number | null, now: number): string | null {
  if (notAfter === null) return null;
  const days = Math.floor((notAfter - now) / DAY);
  if (notAfter < now) {
    const ago = Math.floor((now - notAfter) / DAY);
    return `expired ${ago} day${ago === 1 ? '' : 's'} ago`;
  }
  return days === 0 ? 'expires today' : `expires in ${days} day${days === 1 ? '' : 's'}`;
}

export const dateText = (t: number | null): string => (t === null ? '—' : new Date(t).toISOString().slice(0, 10));

export interface CertRow { id: string; name: string; mode: string; expires: string | null; push: string | null; bad: boolean }
// One row per camera; `names` maps a camera id to its name where known.
export function certRows(v: Pick<TlsView, 'cameras'>, names: Record<string, string | undefined>, now: number): CertRow[] {
  return v.cameras.map((c) => ({
    id: c.id,
    name: names[c.id] ?? c.id,
    mode: modeText(c.mode),
    expires: c.mode === 'site-ca' || c.mode === 'pinned' ? expiresText(c.notAfter, now) : null,
    push: c.lastPush ? `${c.lastPush.outcome} ${agoText(c.lastPush.at, now)}` : null,
    bad: !!c.problem || c.lastPush?.outcome === 'failed' || c.lastPush?.outcome === 'refused',
  }));
}

export const certWarnings = (v: Pick<TlsView, 'problems' | 'cameras'>): string[] => [...v.problems, ...v.cameras.filter((c) => c.problem).map((c) => `${c.id}: ${c.problem}`)];
