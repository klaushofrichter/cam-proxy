import { CameraError, type ReolinkClient } from '../camera/client';

export type NtpOutcome = 'set' | 'already' | 'unsupported' | 'failed';

// The camera's NTP server → the host (spec 2026-10-05-multi-camera-host-design
// §14.2): the firmware may ignore DHCP option 42. A whole-object SetNtp,
// read back, then log out (CLAUDE.md: real-camera settings rules).
export async function ensureNtp(client: Pick<ReolinkClient, 'command' | 'logout'>, server: string): Promise<{ outcome: NtpOutcome; before?: unknown; after?: unknown; detail?: string }> {
  try {
    const before = (await client.command<{ Ntp?: Record<string, unknown> }>('GetNtp')).Ntp;
    if (!before) return { outcome: 'unsupported', detail: 'GetNtp gave no Ntp object' };
    if (before.server === server && Number(before.enable) === 1) return { outcome: 'already', before };
    await client.command('SetNtp', { Ntp: { ...before, enable: 1, server } });
    const after = (await client.command<{ Ntp?: Record<string, unknown> }>('GetNtp')).Ntp;
    if (after?.server !== server) return { outcome: 'failed', before, after, detail: 'the camera kept its NTP server' };
    return { outcome: 'set', before, after };
  } catch (err) {
    const code = err instanceof CameraError ? err.code : 'camera_error';
    const unsupported = (err instanceof CameraError && err.rspCode === -9) || /rspCode -9\b|not support/i.test((err as Error).message);
    return { outcome: unsupported ? 'unsupported' : 'failed', detail: `${code}: ${(err as Error).message}` };
  } finally {
    await client.logout().catch(() => undefined);
  }
}
