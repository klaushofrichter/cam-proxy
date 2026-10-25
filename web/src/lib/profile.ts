// The proxy profile in the admin UI (cams-admin spec 2026-10-25-proxy-profile-design
// §0): GET/PUT /control/profile. The home page asks for it until it is set;
// the Settings page edits it. GB here is 10^9 bytes, as profile.storageGB.

export type ProfileWarning = 'profile_ftp_ports' | 'profile_cameras_exceeded';
export interface ProfileView {
  set: boolean;
  name: string | null;
  cameras: number;
  storageGB: number | null;
  held: number;
  ftp: { enabled: boolean; port: number; passive: { from: number; to: number } | null };
  storage: { budgetBytes: number | null; usedBytes: number | null; diskBytes: number | null; freeBytes: number | null };
  hardware: { pi: string | null; cpuCores: number; cpuModel: string | null; memoryBytes: number; load5: number; cpuTempC: number | null };
  warnings: ProfileWarning[];
  firewall: { tool: 'ufw' | 'nft'; lines: string[] };
  perCameraBytes: number | null;
}
export interface ProfileDraft { name: string; cameras: string; storageGB: string; firewall: 'ufw' | 'nft' }

const GB = 1e9;
const gb = (b: number) => `${(b / GB).toFixed(1)} GB`;

// The home page shows the card until the profile is set, and while it warns.
export const showOnHome = (v: ProfileView | null): boolean => !!v && (!v.set || v.warnings.length > 0);

export function profileRows(v: ProfileView): { key: string; label: string; text: string }[] {
  const s = v.storage;
  const hw = v.hardware;
  const rows = [
    { key: 'cameras', label: 'Cameras', text: `${v.held} of ${v.cameras}${v.set ? '' : ' (not set: the cameras it holds)'}` },
    { key: 'ftp', label: 'FTP ports', text: v.ftp.enabled && v.ftp.passive ? `${v.ftp.port}, passive ${v.ftp.passive.from}–${v.ftp.passive.to}` : 'off' },
    { key: 'budget', label: 'Storage budget', text: s.budgetBytes === null ? '—' : `${gb(s.budgetBytes)}${s.usedBytes !== null ? ` (used ${gb(s.usedBytes)})` : ''}${s.diskBytes !== null ? ` on a ${gb(s.diskBytes)} disk` : ''}` },
    { key: 'perCamera', label: 'Per camera when full', text: v.perCameraBytes === null ? '—' : gb(v.perCameraBytes) },
    { key: 'hardware', label: 'Hardware (as seen by cam-proxy)', text: [hw.pi, `${hw.cpuCores} cores`, hw.cpuModel, `${gb(hw.memoryBytes)} memory`].filter(Boolean).join(', ') },
    { key: 'load', label: 'Load (5 min)', text: hw.load5.toFixed(2) },
  ];
  if (hw.cpuTempC !== null) rows.push({ key: 'temp', label: 'CPU temperature', text: `${hw.cpuTempC.toFixed(1)} °C` });
  return rows;
}

export function warningText(w: ProfileWarning, v: ProfileView): string {
  if (w === 'profile_ftp_ports') {
    const p = v.ftp.passive;
    const ports = p ? p.to - p.from + 1 : 0;
    return `ftp.passive has ${ports} ports; ${Math.max(v.cameras, v.held)} cameras need ${10 * Math.max(v.cameras, v.held)} (10 per camera). A camera move that needs the missing ports is refused.`;
  }
  return `This proxy holds ${v.held} cameras, more than its profile (${v.cameras}). Nothing is removed; camera moves onto it are refused.`;
}

export const draftOf = (v: ProfileView): ProfileDraft => ({ name: v.name ?? '', cameras: String(v.cameras), storageGB: v.storageGB === null ? '' : String(v.storageGB), firewall: v.firewall.tool });

const whole = (t: string, min: number, max: number) => /^\d+$/.test(t.trim()) && Number(t) >= min && Number(t) <= max;
// Why the draft can't be saved, or null (the proxy checks again).
export function profileProblem(d: ProfileDraft, ftpOn: boolean): string | null {
  const max = ftpOn ? 10 : 64;
  if (!whole(d.cameras, 1, max)) return `Cameras: a whole number from 1 to ${max}${ftpOn ? ' (FTP is on)' : ''}`;
  if ([...d.name.trim()].length > 60) return 'Name: at most 60 characters';
  if (d.storageGB.trim() && !whole(d.storageGB, 1, 100000)) return 'Storage: a whole number of GB from 1 to 100000, or empty';
  return null;
}

// The PUT body: every field, an empty one cleared (null).
export const profileBody = (d: ProfileDraft) => ({
  name: d.name.trim() || null,
  cameras: Number(d.cameras),
  storageGB: d.storageGB.trim() ? Number(d.storageGB) : null,
  firewall: d.firewall,
});
