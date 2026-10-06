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
