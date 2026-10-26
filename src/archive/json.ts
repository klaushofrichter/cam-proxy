import type { ArchiveRow } from '../catalog/archive';
import type { ArchiveMoveNote, Snapshot } from './metadata';
import { parseStored } from '../catalog/json';

// The API's shapes of a row (docs/archive.md §1, §4): the item, and the
// metadata (the item without urls plus the snapshot taken when archived).
// One corrupt JSON column must not fail a list.

export interface ArchiveItem {
  id: number;
  cam: string;
  cameraName: string | null;
  name: string;
  labels: string[];
  retentionDays: number | null;
  createdAt: number;
  expiresAt: number | null;
  recordedFrom: number;
  recordedTo: number;
  durationS: number;
  quality: string;
  original: boolean;
  bytes: number;
  source: unknown;
  eventKinds: string[];
  found: string[];
  thumbnail: { from: string; at: number | null };
  createdBy: string;
  move: ArchiveMoveNote | null;
  urls: { video: string; thumbnail: string; metadata: string };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
export const snapshotOf = (row: ArchiveRow): Partial<Snapshot> => {
  const v = parseStored(row.metadata);
  return v && typeof v === 'object' ? (v as Partial<Snapshot>) : {};
};

const peer = (v: unknown): { proxyId: string; name: string } | undefined => {
  const p = v as { proxyId?: unknown; name?: unknown } | null;
  return p && typeof p === 'object' && typeof p.proxyId === 'string' && typeof p.name === 'string' ? { proxyId: p.proxyId, name: p.name } : undefined;
};
const REASONS = ['failed', 'missing', 'not_copied'] as const;
// The snapshot's move note, or null when absent or malformed.
export function moveNoteOf(snap: Partial<Snapshot>): ArchiveMoveNote | null {
  const m = snap.move as Partial<Record<keyof ArchiveMoveNote, unknown>> | undefined;
  if (!m || typeof m !== 'object' || typeof m.moveId !== 'string' || !m.moveId || typeof m.at !== 'number' || !Number.isFinite(m.at)) return null;
  const out: ArchiveMoveNote = { moveId: m.moveId, at: m.at };
  const from = peer(m.from);
  const to = peer(m.to);
  if (from) out.from = from;
  if (to) out.to = to;
  if (m.kept === true) out.kept = true;
  if (typeof m.reason === 'string' && (REASONS as readonly string[]).includes(m.reason)) out.reason = m.reason as ArchiveMoveNote['reason'];
  return out;
}
// The metadata column with the note set; the rest of the snapshot stays.
export function withMoveNote(metadata: string, note: ArchiveMoveNote): string {
  const v = parseStored(metadata);
  const base = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return JSON.stringify({ ...base, move: note });
}

export function itemJson(row: ArchiveRow): ArchiveItem {
  const snap = snapshotOf(row);
  const base = `/api/archive/${row.id}`;
  return {
    id: row.id,
    cam: row.cam,
    cameraName: typeof snap.camera?.name === 'string' ? snap.camera.name : null,
    name: row.name,
    labels: strings(parseStored(row.labels)),
    retentionDays: row.retention_days,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    recordedFrom: row.recorded_from,
    recordedTo: row.recorded_to,
    durationS: row.duration_s,
    quality: row.quality,
    original: row.original === 1,
    bytes: row.bytes,
    source: parseStored(row.source),
    eventKinds: strings(snap.eventKinds),
    found: strings(snap.found),
    thumbnail: { from: row.thumb_from, at: row.thumb_at },
    createdBy: row.created_by,
    move: moveNoteOf(snap),
    urls: { video: `${base}/video`, thumbnail: `${base}/thumbnail`, metadata: `${base}/metadata` },
  };
}

export function metadataJson(row: ArchiveRow) {
  const { urls: _urls, ...item } = itemJson(row);
  const s = snapshotOf(row);
  return {
    schema: 1 as const,
    item,
    camera: s.camera ?? null,
    window: s.window ?? { from: row.recorded_from, to: row.recorded_to },
    events: s.events ?? [],
    stillChecks: s.stillChecks ?? [],
    proxy: s.proxy ?? null,
    archivedAt: s.archivedAt ?? row.created_at,
  };
}

// The files column: the clip's and the thumbnail's size and CRC-32.
export interface ArchiveFiles { clip: { bytes: number; crc32: number }; thumb: { bytes: number; crc32: number } | null }
export function filesOf(row: ArchiveRow): ArchiveFiles | null {
  const v = parseStored(row.files) as Partial<ArchiveFiles> | null;
  if (!v || typeof v !== 'object' || !v.clip || !Number.isSafeInteger(v.clip.bytes) || !Number.isInteger(v.clip.crc32)) return null;
  return { clip: v.clip, thumb: v.thumb && Number.isSafeInteger(v.thumb.bytes) && Number.isInteger(v.thumb.crc32) ? v.thumb : null };
}
