import { resolve, sep } from 'path';
import { rmSync, statSync } from 'fs';
import { clipById, deleteClip, setSnapshot, type ClipRow } from '../catalog/clips';
import type { Catalog } from '../catalog/db';
import { probeVideo } from '../clips/indexer';
import { errorMessage, logger } from '../log';
import { mb, type ClipItem } from './clips';
import { sameRecording, START_SLACK_MS } from './match';
import type { InventoryReport, RepairEntry, RepairResult } from './runner';
import { REPAIR_MAX_FAILURES } from './repair-clips';

// Removing duplicate clips (#342): a clips compare with the camera reports a
// recording held twice, a clip fetched from the camera by a repair and its FTP
// copy (`duplicate-clip`). This repair removes the fetched copy and its file
// and keeps the FTP copy. It needs no camera: every pair is checked again here,
// and left alone unless both copies pass, so it never removes the only copy of
// a recording:
// - both rows still exist, of this camera and the stream, with these origins;
// - both are the recording's by the pairing rules (match.ts);
// - the FTP copy reaches the recording's end, within 5 s (not cut short);
// - its file is a readable video, and the fetched file is there, inside the
//   clips folder;
// - no other pair of the run keeps the same FTP copy.
// The fetched clip's picture link moves to the FTP copy if that has none; the
// picture file stays either way. Failures don't stop a run before 3 in a row.

type SkipReason = 'fetched-changed' | 'keep-gone' | 'not-same-recording' | 'keep-short' | 'keep-used' | 'keep-unreadable' | 'fetched-file-gone';
export interface DuplicateRepairItem { id: string; start: number; result: 'ok' | 'skipped' | 'failed'; reason?: SkipReason; error?: string; clipId?: number; keptClipId?: number; bytes?: number }

export interface DuplicatesRepairDeps {
  catalog: Catalog;
  dataDir: string;
  // After a run that removed something: the storage run recounts the disk.
  prune?: () => void;
  probe?: (file: string) => Promise<unknown>; // tests; a falsy answer: not a readable video
}

type Candidate = Extract<ClipItem, { type: 'duplicate-clip' }>;
const candidates = (r: InventoryReport) => (r.items as ClipItem[]).filter((x): x is Candidate => x.type === 'duplicate-clip');
const asClip = (c: ClipRow) => ({ start: c.start_ts, stream: c.stream, origin: c.origin });

export function duplicatesRepair(d: DuplicatesRepairDeps): RepairEntry {
  const ready = (source: InventoryReport): string | null => {
    if (!source.options?.camera) return 'compare the clips with the camera first';
    if (!candidates(source).length) return 'no recording is held twice';
    return null;
  };

  const run = async (ctx: Parameters<RepairEntry['run']>[0]): Promise<RepairResult> => {
    const probe = d.probe ?? probeVideo;
    const root = resolve(d.dataDir, 'clips') + sep;
    const list = candidates(ctx.source);
    const counts = { candidates: ctx.source.counts.duplicates ?? list.length, requested: list.length, done: 0, failed: 0, skipped: 0, bytes: 0 };
    const items: DuplicateRepairItem[] = [];
    const failures: { id: string; start: number; error: string }[] = [];
    const kept = new Set<number>();
    let inARow = 0;
    let stopped: string | null = null;

    // Why the pair is left alone, or null with both rows.
    const check = async (c: Candidate): Promise<{ skip: SkipReason } | { fetched: ClipRow; ftp: ClipRow }> => {
      const fetched = clipById(d.catalog, c.fetchedClipId);
      if (!fetched || fetched.cam !== ctx.cam || fetched.origin !== 'camera') return { skip: 'fetched-changed' };
      const ftp = clipById(d.catalog, c.ftpClipId);
      if (!ftp || ftp.cam !== ctx.cam || ftp.origin !== 'ftp' || ftp.path === fetched.path) return { skip: 'keep-gone' };
      if (!sameRecording(c, asClip(fetched)) || !sameRecording(c, asClip(ftp))) return { skip: 'not-same-recording' };
      if (ftp.end_ts === null || ftp.end_ts < c.end - START_SLACK_MS) return { skip: 'keep-short' };
      if (kept.has(ftp.id)) return { skip: 'keep-used' };
      const size = (file: string) => statSync(file, { throwIfNoEntry: false })?.size ?? 0;
      if (!size(ftp.path) || !(await probe(ftp.path))) return { skip: 'keep-unreadable' };
      if (!resolve(fetched.path).startsWith(root) || !size(fetched.path)) return { skip: 'fetched-file-gone' };
      return { fetched, ftp };
    };

    for (const [i, c] of list.entries()) {
      if (ctx.signal.aborted || stopped) break;
      ctx.progress({ phase: 'repair', done: i, total: list.length, note: c.id });
      try {
        const pair = await check(c);
        if (ctx.signal.aborted) break;
        if ('skip' in pair) {
          counts.skipped++;
          items.push({ id: c.id, start: c.start, result: 'skipped', reason: pair.skip });
          continue;
        }
        const { fetched, ftp } = pair;
        kept.add(ftp.id);
        rmSync(fetched.path, { force: true }); // the file first: a failure leaves both copies
        if (fetched.snapshot && !ftp.snapshot) setSnapshot(d.catalog, ftp.id, fetched.snapshot);
        deleteClip(d.catalog, fetched.path);
        counts.done++;
        counts.bytes += fetched.size;
        inARow = 0;
        items.push({ id: c.id, start: c.start, result: 'ok', clipId: fetched.id, keptClipId: ftp.id, bytes: fetched.size });
        logger.info({ clipId: fetched.id, keptClipId: ftp.id, bytes: fetched.size }, 'duplicate_clip_removed');
      } catch (err) {
        const error = errorMessage(err);
        counts.failed++;
        inARow++;
        items.push({ id: c.id, start: c.start, result: 'failed', error });
        failures.push({ id: c.id, start: c.start, error });
        if (inARow >= REPAIR_MAX_FAILURES) stopped = 'failures';
      }
    }
    if (counts.done && d.prune) {
      try {
        d.prune();
      } catch (err) {
        logger.warn({ err: errorMessage(err) }, 'repair_prune_failed');
      }
    }
    // The report's item cut left some out: the next compare lists them.
    if (!stopped && !ctx.signal.aborted && counts.candidates > list.length) stopped = 'item-cap';
    ctx.progress({ phase: 'repair', done: items.length, total: list.length });
    const message =
      `${counts.done} of ${counts.requested} fetched copies removed (${mb(counts.bytes)}), the FTP copies kept; ${counts.failed} failed, ${counts.skipped} skipped` +
      (stopped === 'failures' ? `; stopped: ${REPAIR_MAX_FAILURES} failures in a row` : stopped === 'item-cap' ? '; stopped: the report listed only some, compare again for the rest' : '');
    return { counts, top: failures, items, message, stopped };
  };

  return { run, ready };
}
