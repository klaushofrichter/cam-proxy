// The camera-move UI's logic apart from the components (camera-move plan
// Task 11, spec S §7): what the panel offers, the plan it sends, the texts.
import type { MoveKind, MovePlan, MoveReason, MoveSummary, Settings, Space } from '../../../src/moves/types';
import { estimateText } from '../../../src/moves/plan';

// The plan rules live once, in src/moves/plan.ts (the proxy's auto-approval shares them).
export { KINDS, budgetDefault, estimateText, hasContent, kindsWithContent, planFrom, spaceOptions, type MoveForm } from '../../../src/moves/plan';

export type { MoveKind, MovePlan, MoveReason, MoveSummary, Space };
export const KIND_LABEL: Record<MoveKind, string> = { stills: 'Stills', clips: 'Clips', events: 'Events', checks: 'Still checks', archive: 'Archive' };

// One move as GET /control/moves lists it (src/moves/source.ts MoveView).
export interface MoveItem {
  id?: string;
  requestId?: string;
  camera: string;
  target: { proxyId: string; name: string };
  phase: string;
  answer?: { accept: boolean; reason?: MoveReason; space?: Space; estimateS?: number };
  summary?: MoveSummary;
  settings?: Settings;
  plan?: MovePlan | null;
  progress?: { bytesDone: number; bytesTotal: number; rateBps: number; etaS: number };
  budgetExceeded: boolean;
  failure?: string;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

export function sizeText(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${Math.round(bytes)} B`;
}

// A proposed host limit with its unit: *.maxGB are GB, storage.maxBytes is bytes.
export const limitText = (key: string, value: number): string => `${key}: ${key.endsWith('Bytes') ? sizeText(value) : `${value} GB`}`;

const REASON: Record<MoveReason, string> = {
  moves_not_allowed: "it doesn't accept camera moves (its local admin can allow them on its Cams-Admin page)",
  camera_unreachable: "it can't reach the camera",
  camera_limit: 'it already has as many cameras as it may',
  id_taken: 'it already has a camera with this id',
  busy: 'it is in another move',
  incompatible: "it can't use this camera's settings (update it first)",
  no_site_ca: 'it has no site certificate authority',
  ca_does_not_cover_camera: "its site certificate authority doesn't cover <camera address>",
  external_cert: "this camera's certificate is managed elsewhere",
  target_failed: "it didn't answer",
  other_account: 'it belongs to another account',
  target_offline: 'it is offline',
  not_routed: "cams can't reach it the way it reaches this proxy (ask for the route in cams-admin first)",
  host_overridden: 'cams uses a different address for this camera (remove the override in cams-admin first)',
  offer_expired: 'the offer expired after 30 minutes; start again',
  not_registered: "cams-admin doesn't know this camera (register it in cams-admin first)",
  internal: 'something went wrong in cams-admin; try again',
};
export const rejectText = (target: string, reason: MoveReason | undefined, address: string): string =>
  `${target} can't take this camera: ${(reason ? REASON[reason] : undefined)?.replace('<camera address>', address || 'the camera address') ?? REASON.target_failed}`;

const PHASE: Record<string, string> = {
  opened: 'waiting for approval', 'awaiting-approval': 'waiting for approval', approved: 'approved', switching: 'switching over', switched: 'switched over',
  released: 'copying', copying: 'copying', copied: 'copied', finished: 'done', cancelled: 'cancelled', failed: 'failed',
};
export const phaseText = (phase: string): string => PHASE[phase] ?? phase;

const FAIL: Record<string, string> = {
  token_address: 'the target could not be reached from the address it was expected at',
  secrets_failed: "the camera's password could not be handed over",
  camera_failed: 'the camera did not take the new settings',
  cert_failed: 'the certificate could not be handed over',
  ftp_failed: 'the camera did not take the new upload settings',
  internal: 'an internal error',
};
export const failText = (code: string): string => FAIL[code] ?? code;

// The phases in which a move is visible on the Status page (a request or an offer is the dialog's).
const ACTIVE = ['awaiting-approval', 'approved', 'opened', 'switching', 'switched', 'released', 'copying', 'copied', 'failed'];
export const isActive = (m: Pick<MoveItem, 'phase'>): boolean => ACTIVE.includes(m.phase);

export function statusLine(m: Pick<MoveItem, 'target' | 'phase' | 'progress' | 'failure'>, camera: string): string {
  const head = `Moving ${camera} to ${m.target.name}: `;
  if (m.phase === 'failed') return `${head}failed${m.failure ? `, ${failText(m.failure)}` : ''}`;
  const p = m.progress;
  if (!p || !p.bytesTotal || !['released', 'copying', 'copied'].includes(m.phase)) return head + phaseText(m.phase);
  const pct = Math.min(100, Math.floor((p.bytesDone / p.bytesTotal) * 100));
  return `${head}${phaseText(m.phase)}, ${sizeText(p.bytesDone)} of ${sizeText(p.bytesTotal)} (${pct}%), about ${estimateText(p.etaS)} left`;
}

export const OVER_BUDGET_TEXT = 'Over the time budget; still copying';

// This proxy refusing to start a move (409 move_refused), in words.
const REFUSAL: Record<string, string> = {
  no_site_ca: "This proxy has no site certificate authority, so its cameras can't be moved.",
  external_cert: "This camera's certificate is managed elsewhere, so it can't be moved.",
  moves_not_allowed: "Sending a camera away isn't allowed on this proxy (allow move.send on its Cams-Admin page).",
  busy: 'This proxy is in another move.',
  unknown_camera: 'This camera is not running here.',
};
export const refusalText = (reason: string): string => REFUSAL[reason] ?? reason;

// A camera hidden in config.json after its move (setting cameras.<id>.moved).
export const movedText = (target: string, moveId: string): string => `Moved to ${target} (${moveId}). You can delete it from config.json.`;
