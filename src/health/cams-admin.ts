// The proxy's connection to cams-admin as one health item (Klaus, 2026-11-04:
// een sat disconnected for 13 minutes and its health showed nothing). Connected:
// ok. Down under GRACE_MS: a warning, so that a cams-admin deploy (measured
// reconnects took up to about 2 min) raises no alarm. Down longer, or never
// connected for as long since the start: a problem, with a short reason when
// known. Not configured for cams-admin (input null): no item.
//
// cams-admin itself can't receive this while the connection is down, and while
// it's up the item only says ok: it is for the Status page and the display.
export const CAMS_ADMIN_GRACE_MS = 2 * 60_000;
const TEXT_MAX = 200; // the cams-admin contract's text limit

// reason: one of the short fixed words of the client and the service, never a message from elsewhere.
export type AdminConnection = { connected: true } | { connected: false; downSince: number; reason: string | null };
export interface CamsAdminItem { id: 'camsAdmin'; label: string; value: string; text: string; problem: boolean; warning?: true }

export function camsAdminItem(c: AdminConnection | null | undefined, now: number): CamsAdminItem | null {
  if (!c) return null;
  const base = { id: 'camsAdmin' as const, label: 'cams-admin' };
  if (c.connected) return { ...base, value: 'connected', text: 'connected', problem: false };
  const down = now - c.downSince;
  if (down < CAMS_ADMIN_GRACE_MS) return { ...base, value: 'reconnecting', text: 'reconnecting', problem: false, warning: true };
  const text = `not connected for ${Math.floor(down / 60_000)} min${c.reason ? ` (${c.reason})` : ''}`;
  return { ...base, value: 'disconnected', text: text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text, problem: true };
}
