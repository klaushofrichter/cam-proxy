// The Status page's camera FTP warnings (#93): the camera's FTP upload off,
// pointing somewhere else, or no clips while the camera records events.

export interface CameraFtp {
  state: 'on' | 'off' | 'elsewhere' | 'unknown';
  checkedAt: number | null;
  enable: boolean | null;
  server: string | null;
  port: number | null;
  user: string | null;
  mismatch: string[];
  error: string | null;
}
export interface ClipsStall { stalled: boolean; hours: number; lastClip: number | null; events: number }
export interface FtpHealth { enabled: boolean; publicHost: string | null; camera: CameraFtp | null; stalled: ClipsStall | null }
export interface FtpAlert { kind: 'off' | 'elsewhere' | 'stalled'; text: string }

// Local date and time, minutes: 2026-09-30 08:17.
export function clipTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// The warnings, red on the FTP card, above "Point the camera's FTP here".
export function ftpAlerts(f: FtpHealth, time: (ts: number) => string = clipTime): FtpAlert[] {
  if (!f.enabled) return [];
  const out: FtpAlert[] = [];
  const c = f.camera;
  if (c?.state === 'off') out.push({ kind: 'off', text: "The camera's FTP upload is off: no clips arrive." });
  if (c?.state === 'elsewhere') out.push({ kind: 'elsewhere', text: `The camera's FTP upload points to ${c.server}:${c.port} (user ${c.user}), not to this proxy (${f.publicHost ?? 'ftp.publicHost not set'}).` });
  const s = f.stalled;
  if (s?.stalled) {
    const last = s.lastClip === null ? 'no clip has arrived yet' : `the last clip arrived ${time(s.lastClip)}`;
    out.push({ kind: 'stalled', text: `No clip in the last ${s.hours} h although the camera recorded ${s.events} event${s.events === 1 ? '' : 's'}; ${last}.` });
  }
  return out;
}

// The "Camera upload" line.
export function cameraFtpText(c: CameraFtp | null): string {
  if (!c) return '—';
  if (c.state === 'on') return 'on, to this proxy';
  if (c.state === 'off') return 'off';
  if (c.state === 'elsewhere') return `to ${c.server}:${c.port}`;
  return '—';
}
