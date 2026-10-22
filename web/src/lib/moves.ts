// The camera-move UI's logic apart from the components (camera-move plan
// Task 11, spec S §7): what the panel offers, the plan it sends, the texts.
import type { MoveKind, MovePlan, MoveReason, MoveSummary, Settings, Space } from '../../../src/moves/types';

export type { MoveKind, MovePlan, MoveReason, MoveSummary, Space };
export const KINDS: readonly MoveKind[] = ['stills', 'clips', 'events', 'checks', 'archive'];
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

export function estimateText(s: number): string {
  const sec = Math.max(0, Math.round(s));
  if (sec < 60) return `${sec} s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

// The time budget field is in minutes: the estimate rounded up to whole minutes (at least one).
export const budgetDefault = (estimateS: number): number => Math.max(1, Math.ceil(estimateS / 60));

export function sizeText(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${Math.round(bytes)} B`;
}

// A proposed host limit with its unit: *.maxGB are GB, storage.maxBytes is bytes.
export const limitText = (key: string, value: number): string => `${key}: ${key.endsWith('Bytes') ? sizeText(value) : `${value} GB`}`;

export const hasContent = (s: MoveSummary, k: MoveKind): boolean => s[k].files + s[k].rows > 0;
export const kindsWithContent = (s: MoveSummary): MoveKind[] => KINDS.filter((k) => hasContent(s, k));

// The options when the content does not fit the target; retention only with a proposal.
export function spaceOptions(space: Space | undefined): ('omit' | 'retention' | 'fit')[] {
  if (!space || space.fits) return [];
  return space.retentionProposal && Object.keys(space.retentionProposal).length ? ['omit', 'retention', 'fit'] : ['omit', 'fit'];
}

export interface MoveForm {
  transfer: boolean;
  leaveOut: MoveKind[];
  option: 'omit' | 'retention' | 'fit';
  budgetMin: number;
  estimateS: number;
  summary: MoveSummary;
  space?: Space;
}

// The plan the form means, or why not (a budget below the estimate is refused here, as by the proxy).
export function planFrom(f: MoveForm): { plan: MovePlan | null; error: string | null } {
  const budgetS = Math.round(f.budgetMin * 60);
  if (!Number.isFinite(budgetS) || budgetS < f.estimateS) return { plan: null, error: `The time budget can't be below the estimate (${estimateText(f.estimateS)}).` };
  const common = { budgetS, estimateS: f.estimateS };
  if (!f.transfer) return { plan: { transfer: false, kinds: [], space: 'all', targetSettings: null, ...common }, error: null };
  const all = kindsWithContent(f.summary);
  if (!f.space || f.space.fits) return { plan: { transfer: true, kinds: all, space: 'all', targetSettings: null, ...common }, error: null };
  if (f.option === 'omit') {
    const kinds = all.filter((k) => !f.leaveOut.includes(k));
    if (kinds.reduce((n, k) => n + f.summary[k].bytes, 0) > f.space.available) return { plan: null, error: "What is left still doesn't fit." };
    return { plan: { transfer: true, kinds, space: 'omit', targetSettings: null, ...common }, error: null };
  }
  if (f.option === 'retention') {
    if (!f.space.retentionProposal) return { plan: null, error: 'The target proposed no limits.' };
    return { plan: { transfer: true, kinds: all, space: 'retention', targetSettings: f.space.retentionProposal, ...common }, error: null };
  }
  return { plan: { transfer: true, kinds: all, space: 'fit', targetSettings: null, ...common }, error: null };
}

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
