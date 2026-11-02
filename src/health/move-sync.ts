import type { MoveSyncView } from '../moves/sync';
import type { MoveSyncRecord } from '../moves/sync-types';

// The post-move check (#311) as one health item, "Move check" (Klaus,
// 2026-11-02: show its issues). Per camera only its newest sync counts.
// Running or waiting: a warning. Something still missing, failed or gave up:
// a problem for PROBLEM_KEEP_MS after it ended. Done with nothing missing:
// shown for DONE_KEEP_MS. Outside those windows: no item.
export const MOVE_SYNC_DONE_KEEP_MS = 24 * 3600_000;
export const MOVE_SYNC_PROBLEM_KEEP_MS = 7 * 24 * 3600_000;
const TEXT_MAX = 200; // the cams-admin contract's text limit

export interface MoveSyncItem { id: 'moveSync'; label: string; value: string; text: string; problem: boolean; warning?: true }
type Grade = 'problem' | 'warning' | 'ok';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const both = (clips: number, events: number) => [clips ? plural(clips, 'clip') : '', events ? plural(events, 'event') : ''].filter(Boolean).join(' and ');

function gradeOf(s: MoveSyncRecord, now: number): { grade: Grade; value: string; text: string } | null {
  const ended = s.finishedAt ?? s.requestedAt;
  if (s.state === 'running') return { grade: 'warning', value: 'running', text: 'checking the SD card' };
  if (s.state === 'pending') return { grade: 'warning', value: 'pending', text: s.waitReturn ? 'waiting for the copy back' : s.error ? `waiting (${s.error})` : 'waiting' };
  if (s.state === 'failed' || s.state === 'gave-up') {
    if (now - ended > MOVE_SYNC_PROBLEM_KEEP_MS) return null;
    const why = s.error ? ` (${s.error})` : '';
    return { grade: 'problem', value: s.state, text: s.state === 'failed' ? `failed${why}` : `gave up after 24 h${why}` };
  }
  const clipsLeft = s.clips?.missingAfter ?? 0;
  const eventsLeft = Math.max(0, (s.events?.missing ?? 0) - (s.events?.added ?? 0));
  if (clipsLeft || eventsLeft) {
    if (now - ended > MOVE_SYNC_PROBLEM_KEEP_MS) return null;
    const stopped = clipsLeft && s.clips?.stopped ? ` (${s.clips.stopped})` : '';
    return { grade: 'problem', value: 'missing', text: `${both(clipsLeft, eventsLeft)} still missing${stopped}` };
  }
  if (now - ended > MOVE_SYNC_DONE_KEEP_MS) return null;
  const fetched = both(s.clips?.fetched ?? 0, s.events?.added ?? 0);
  return { grade: 'ok', value: 'done', text: fetched ? `done, ${fetched} fetched` : 'done, nothing was missing' };
}

// syncs: newest first (MoveSync.list()).
export function moveSyncItem(syncs: readonly MoveSyncView[], now: number): MoveSyncItem | null {
  const seen = new Set<string>();
  const per: { cam: string; grade: Grade; value: string; text: string }[] = [];
  for (const v of syncs) {
    if (seen.has(v.camera)) continue;
    seen.add(v.camera);
    const g = gradeOf(v.sync, now);
    if (g) per.push({ cam: v.camera, ...g });
  }
  if (per.length === 0) return null;
  const grade: Grade = per.some((p) => p.grade === 'problem') ? 'problem' : per.some((p) => p.grade === 'warning') ? 'warning' : 'ok';
  const shown = per.filter((p) => p.grade === grade);
  const text = shown.length === 1 ? `${shown[0].cam}: ${shown[0].text}`
    : grade === 'problem' ? `${shown.length} cameras with a move problem`
    : grade === 'warning' ? `${shown.length} cameras being checked after a move`
    : `${shown.length} cameras done, nothing missing`;
  return {
    id: 'moveSync', label: 'Move check', value: shown[0].value,
    text: text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text,
    problem: grade === 'problem', ...(grade === 'warning' ? { warning: true as const } : {}),
  };
}
