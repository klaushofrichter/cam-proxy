// The camera-move wire types (cams-admin contract v1 "Camera moves", the strict
// schemas in test/contract/cams-admin-v1/strict). Plain data: no behaviour.

export type MoveKind = 'stills' | 'clips' | 'events' | 'checks' | 'archive';
export const MOVE_KINDS: readonly MoveKind[] = ['stills', 'clips', 'events', 'checks', 'archive'];
export type MoveRole = 'source' | 'target';
// `space`: what happens when the content does not fit the target's disk.
export type MoveSpacePlan = 'all' | 'omit' | 'fit' | 'retention';
export type MoveCopied = 'delete' | 'age-out';
export type MovePhaseName = 'opened' | 'switching' | 'switched' | 'released' | 'copying' | 'copied' | 'finished' | 'cancelled' | 'failed';
export type ChunkState = 'pending' | 'copied' | 'verified' | 'skipped' | 'failed';
export type MoveReason = 'moves_not_allowed' | 'camera_unreachable' | 'camera_limit' | 'id_taken' | 'busy' | 'incompatible' | 'no_site_ca' | 'ca_does_not_cover_camera' | 'external_cert' | 'other_account' | 'target_offline' | 'not_routed' | 'host_overridden' | 'target_failed' | 'offer_expired';

// A flat map of settings paths to leaf values (targetSettings, retentionProposal).
export type SettingsMap = Record<string, boolean | number | string>;

// The camera node of the proxy's config: every leaf optional, closed objects.
export interface Settings {
  name?: string;
  statusPollS?: number;
  ftp?: { enabled?: boolean; stream?: 'main' | 'sub' };
  stills?: { enabled?: boolean; stream?: 'sub' | 'main'; intervalS?: number };
  storage?: { sharePercent?: number };
  analytics?: { kinds?: { person?: boolean; vehicle?: boolean; pet?: boolean } };
  events?: { poll?: { enabled?: boolean } };
}

export interface KindSummary { files: number; bytes: number; rows: number; oldest: number | null; newest: number | null }
export type MoveSummary = Record<MoveKind, KindSummary>;

export interface Space {
  needed: number;
  available: number;
  fits: boolean;
  perKind: Partial<Record<MoveKind, number>>;
  retentionProposal: SettingsMap | null;
}

// What the admin approved (move.start, move.go, the move.approve event).
export interface MovePlan {
  transfer: boolean;
  kinds: MoveKind[];
  space: MoveSpacePlan;
  targetSettings: SettingsMap | null;
  budgetS: number;
  estimateS: number;
}

export interface ChunkProgress { id: string; state: ChunkState }

export interface MoveCameraConnection {
  proxyCameraId: string;
  name: string;
  host: string;
  protocol: 'https' | 'http';
  user: string;
  onvifPort: number;
  rtspPort: number;
  baichuanPort: number;
}

// The signed `event` bodies of a move, without proxyId and connId: the client
// adds both when it sends (like command.done) and never sends a cmdId.
export type MoveEvent =
  | { kind: 'move.targets'; requestId: string; camera: string }
  | { kind: 'move.request'; requestId: string; camera: MoveCameraConnection; target: string; actor: { origin: 'local' | 'managed'; label: string }; summary: MoveSummary; settings: Settings }
  | { kind: 'move.approve'; moveId: string; plan: MovePlan }
  | { kind: 'move.cancel'; moveId: string; copied: MoveCopied }
  | { kind: 'move.phase'; moveId: string; role: MoveRole; phase: MovePhaseName; ok: boolean; code?: string; detail?: string }
  | { kind: 'move.progress'; moveId: string; chunks: ChunkProgress[]; bytesDone: number; bytesTotal: number; rateBps: number; etaS: number };
