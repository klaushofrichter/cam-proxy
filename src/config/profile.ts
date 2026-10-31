import { isIP } from 'net';
import { splitHost } from '../camera/http';
import { cameraConfig } from './cameras';
import type { Config } from './defaults';

// The proxy profile (cams-admin spec 2026-10-25-proxy-profile-design §0, §1):
// what a proxy holds, and what follows from it. Derived, never typed: the FTP
// passive range, the warnings, the firewall lines for its cameras.

// ftp.passive: the start of the derived range, the most ports a range may
// span (10 per camera for profile.cameras' 64) and the ports per camera.
export const PASSIVE_FROM = 30000;
export const PASSIVE_MAX = 640;
export const PORTS_PER_CAMERA = 10;
export const MAX_FTP_CAMERAS = PASSIVE_MAX / PORTS_PER_CAMERA;

export type ProfileWarning = 'profile_ftp_ports' | 'profile_cameras_exceeded';

// The cameras this proxy holds: every camera not hidden after a move.
export const heldCameras = (c: Config): number => c.cameraOrder.filter((id) => !c.cameras[id]?.moved).length;

// Adding a camera is refused at the profile's camera count (spec
// 2026-10-30-camera-onboarding-design §4.3); a proxy already over it keeps
// running with its warning (profile_cameras_exceeded).
export const atCameraLimit = (c: Config): boolean => c.profile.cameras !== undefined && heldCameras(c) >= c.profile.cameras;

// FTP is on here: any camera takes clip uploads (as the passive checks count them).
export const ftpOn = (c: Config): boolean => c.cameraOrder.some((id) => cameraConfig(c, id)!.ftp.enabled);

// The profile is set: a person gave its camera count (config.json, the
// Settings page or PUT /control/profile). Until then the defaults apply.
export const profileSet = (c: Config): boolean => c.profile.cameras !== undefined;

// The most cameras this proxy holds: profile.cameras, else the cameras it
// holds now (at least 1), the conservative default (§0).
export const profileCameras = (c: Config): number => c.profile.cameras ?? Math.max(1, heldCameras(c));

// The passive ports the profile needs while FTP is on: 10 per camera for
// max(profile.cameras, cameras held): a lower profile.cameras never takes
// ports from a camera it holds. At most PASSIVE_MAX.
export const passiveNeed = (c: Config): number => Math.min(PASSIVE_MAX, PORTS_PER_CAMERA * Math.max(profileCameras(c), heldCameras(c)));

export const passiveRange = (passive: string): { from: number; to: number } => {
  const [from, to] = passive.split('-').map(Number);
  return { from, to };
};
export const passivePorts = (passive: string): number => {
  const r = passiveRange(passive);
  return r.to - r.from + 1;
};
export const derivedPassive = (c: Config): string => `${PASSIVE_FROM}-${PASSIVE_FROM + passiveNeed(c) - 1}`;

// Never a load error (an upgrade must not stop a running proxy): shown on the
// proxy's pages and reported to cams-admin.
export function profileWarnings(c: Config): ProfileWarning[] {
  const out: ProfileWarning[] = [];
  if (ftpOn(c) && passivePorts(c.ftp.passive) < passiveNeed(c)) out.push('profile_ftp_ports');
  if (c.profile.cameras !== undefined && heldCameras(c) > c.profile.cameras) out.push('profile_cameras_exceeded');
  return out;
}

// The lines each camera with FTP needs on its host's firewall: one per camera,
// the FTP port and the passive range from the camera's address (ufw's port
// list, an nft anonymous set), so profile.cameras' 64 fit the contract's 64
// lines (#277). Plain text for a person to
// run; nothing here runs them. A camera without an IPv4 address gets none.
// They hold camera addresses: never logged. nft: the table and chain the
// multi-camera host's rendered ruleset has (`table inet filter`, `chain
// input`, scripts/host/render.ts); a lasting change there goes through
// host.json and the render, as an added rule is gone at the next reload.
export const FIREWALL_LINES_MAX = 64;
export function firewallLines(c: Config): string[] {
  const { from, to } = passiveRange(c.ftp.passive);
  const port = c.ftp.port;
  const lines: string[] = [];
  for (const id of c.cameraOrder) {
    const cam = cameraConfig(c, id)!;
    if (c.cameras[id]?.moved || !cam.ftp.enabled || !cam.host) continue;
    const ip = splitHost(cam.host).hostname;
    if (isIP(ip) !== 4) continue;
    if (c.profile.firewall === 'nft') {
      lines.push(`sudo nft add rule inet filter input ip saddr ${ip} tcp dport { ${port}, ${from}-${to} } accept`);
    } else {
      lines.push(`sudo ufw allow from ${ip} to any port ${port},${from}:${to} proto tcp`);
    }
  }
  return lines.slice(0, FIREWALL_LINES_MAX);
}
