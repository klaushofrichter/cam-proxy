import { createHash } from 'crypto';
import { constants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync } from 'fs';
import { open } from 'fs/promises';
import { dirname, join } from 'path';
import type { AuditLog } from '../audit/audit-log';
import type { Catalog } from '../catalog/db';
import { logger } from '../log';
import { compareChunk, outcomeOf, tallyCheck, type ChunkKeep, type ManifestFile, type MoveOutcome } from './check';
import { readChunkPart, writeChunkPart } from './chunk-parts';
import { moveSourceClient, spaceFor, type EvaluateDeps, type SourceAnswer } from './evaluate';
import { importRows, isStaged, landingPath, moveStagingDir, relOk, type ImportDeps } from './import';
import { chunkOrder, CONTENT_FOLDERS, hashFile, KIND_FOLDERS, type ChunkMeta, type TableRows } from './inventory';
import type { ChunkRecord, MoveJournal, MoveRecord } from './journal';
import { noteLanded } from './purge';
import { abortableSleep, paceS, rateFor, TokenBucket } from './rate';
import type { ChunkState, MoveCheck, MoveEvent, MoveKind, MoveSummary } from './types';
import { MOVE_KINDS } from './types';

// The copier on the target (camera-move plan Task 9, S §8.2–8.4, §10, §12;
// Review Focus 1–3). It runs once the camera is switched over and pulls the
// camera's old content from the source, chunk by chunk, newest day first (P11
// order within a day): the chunk's file manifest, each file streamed to
// <final>.move-<id>.part through a token bucket at the current rate, hashed
// while written, checked against size and SHA-256, then renamed (id-named
// files into the move's staging folder, the others linked to their own path:
// never over a file the target stored itself); then the chunk's rows
// (importRows). A file fails after 3 bad answers (a wrong size or hash, a cut
// stream); the source not answering, 503 busy or a restart before the answer
// are waited out with a backoff and don't count. Storage paused: it waits.
// A file the source's retention removed meanwhile (404) is skipped.
//
// The journal holds per chunk its state and counts only, never a per-file list for
// stills (1440+ a day): a resumed chunk finds its verified files on disk by
// size and hash. The import map and the verified id-named files of a chunk
// go to its part file beside the record at the chunk's end (chunk-parts.ts,
// final review 6), so the record stays small. Saves are batched to at most
// one a second (`saveEveryMs`) within a chunk (the progress only), and made
// at every chunk end.

// `put`: the outcome report (step 4 Task 6); a client without it reports nothing.
export interface SourceClient { get: (path: string, signal: AbortSignal) => Promise<SourceAnswer>; put?: (path: string, body: unknown, signal: AbortSignal) => Promise<SourceAnswer> }

export interface CopierDeps {
  journal: Pick<MoveJournal, 'load' | 'save'>;
  audit: Pick<AuditLog, 'write'>;
  emit: (e: MoveEvent) => void;
  catalog: Pick<Catalog, 'db'>;
  dataDir: string;
  // The way to the source (default: pinned HTTPS with the move token).
  client?: (r: MoveRecord) => SourceClient;
  // Storage paused (storage.minFreeBytes reached): the copy waits.
  paused: () => boolean;
  // The load average above the core count: the rate halves.
  cpuBusy?: () => boolean;
  // Room on the target (plan.space 'fit'): the evaluation's facts.
  // `evictedAt`: when storage.run last deleted content for a cap or the budget (a return waits an hour after it).
  space: Pick<EvaluateDeps, 'loaded' | 'usage' | 'freeBytes'> & { evictedAt?: () => number | null };
  // A copied stills, previews or clips file (storage's usage between recounts).
  noteWritten?: (kind: 'stills' | 'previews' | 'clips', bytes: number, cam: string) => void;
  // The move's phase on the target (MoveTarget.setPhase: journal, event, audit).
  setPhase: (r: MoveRecord, phase: 'copied' | 'failed', o: { code?: string; detail?: string; extra?: Record<string, unknown>; check?: MoveCheck }) => void;
  // A return (step 4 Task 10) waiting for room, and on again (MoveTarget.notePaused: move.phase copying no_space).
  notePaused?: (r: MoveRecord, paused: boolean) => void;
  proxyId?: () => string;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  bucket?: TokenBucket;
  timing?: { retryMs?: number; retryCapMs?: number; pausedPollMs?: number; refreshPollMs?: number; refreshWaitMs?: number; saveEveryMs?: number; idleMs?: number };
}

const ATTEMPTS = 3;
const FAILED_PATHS_MAX = 50;
const PROGRESS_CHUNKS_MAX = 4096;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const JSON_MAX = 256 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const FINAL: readonly ChunkState[] = ['verified', 'skipped', 'failed'];
// A return (Decision 5): what stays free of the budget after a chunk, and how
// long after storage evicted for a cap or the budget it waits.
const RETURN_RESERVE = 0.05;
const RETURN_EVICT_QUIET_MS = HOUR;
// A return is not paced; under pressure without a probe or a measured rate it goes at half of this.
const RETURN_BUSY_BPS = 2 * 1024 * 1024;

class Stopped extends Error {}

const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const sameMeta = (a: ChunkRecord['meta'], c: ChunkMeta) => !!a && a.files === c.files && a.bytes === c.bytes && a.rows === c.rows;
const metaOf = (c: ChunkMeta) => ({ files: c.files, bytes: c.bytes, rows: c.rows });

function discard(body: AsyncIterable<Buffer>, err?: Error): void {
  (body as { destroy?: (e?: Error) => void }).destroy?.(err);
}

// The idle window of an answer: armed while waiting for the next bytes,
// paused while the bucket holds a read back (a slow rate leaves the socket
// silent; that is not a stall). Tripped, it ends the answer with an error.
function idleGuard(body: AsyncIterable<Buffer>, ms: number): { arm: () => void; pause: () => void } {
  let t: NodeJS.Timeout | undefined;
  return {
    arm: () => {
      clearTimeout(t);
      t = setTimeout(() => discard(body, new Error('source stalled')), ms);
      t.unref();
    },
    pause: () => clearTimeout(t),
  };
}

async function readAll(body: AsyncIterable<Buffer>, idleMs: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  const guard = idleGuard(body, idleMs);
  guard.arm();
  try {
    for await (const b of body) {
      guard.arm();
      n += b.length;
      if (n > JSON_MAX) throw new Error('answer too large');
      parts.push(b);
    }
  } finally {
    guard.pause();
  }
  return Buffer.concat(parts);
}

// A move's temporary files under the camera's folders and its staging folder
// (a failed copy, and Task 10 at cancel).
export function removeMoveParts(dataDir: string, moveId: string, cam: string): void {
  rmSync(moveStagingDir(dataDir, moveId), { recursive: true, force: true });
  const suffix = `.move-${moveId}.part`;
  const go = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) go(p);
      else if (e.name.endsWith(suffix)) rmSync(p, { force: true });
    }
  };
  for (const folder of CONTENT_FOLDERS) go(join(dataDir, folder, cam));
}

type Fetched = 'ok' | 'same' | 'other' | 'expired' | 'unlisted' | 'transient' | 'paused' | 'bad';
// 'x' and 'o' are skipped too: 'x' the source's retention removed the file
// meanwhile, 'o' the target holds its own file of that name (P12 overlap).
type FileOutcome = 'v' | 's' | 'x' | 'o' | 'f';
// `unlisted`: the source answered no listing for the chunk; `own`: the target's own files of those names.
interface Compared { missing: string[]; failed: string[]; expired: string[]; own: string[]; verified: Set<string>; listed: string[]; unlisted: boolean }
export type { ChunkKeep } from './check';

export class Copier {
  private r: MoveRecord;
  private readonly client: SourceClient;
  private readonly bucket: TokenBucket;
  private readonly paths: ImportDeps;
  private manifest: ChunkMeta[] = [];
  private refreshed = false;
  private current = 0; // bytes handled in the chunk in flight
  private inflight = 0; // bytes of the file being fetched
  private rate = 0;
  private rateAt = -Infinity;
  private sourceBusyUntil = 0;
  private lastSave = -Infinity;
  private lastEmit = -Infinity;
  private lastAuditAt = 0;
  private lastDecile = 0;
  private down: { since: number; failures: number; audited: number } | null = null;
  // A return: the pause cams-admin was told of (the record's pausedNoSpace), and the last file's rate.
  private pausedNow = false;
  private measuredBps = 0;
  private signal!: AbortSignal;

  constructor(private readonly d: CopierDeps, record: MoveRecord) {
    this.r = record;
    const p = record.peer;
    this.client = d.client
      ? d.client(record)
      : moveSourceClient({ proxyId: p.proxyId, name: p.name, url: p.url ?? '', caFingerprints: p.caFingerprints ?? [], tlsServername: p.tlsServername ?? '' }, record.token ?? '', { idleMs: d.timing?.idleMs });
    // The default sleep ends early on stop (a slow take never holds up a cancel).
    this.bucket = d.bucket ?? new TokenBucket({ now: d.now, sleep: d.sleep ?? abortableSleep });
    this.paths = { catalog: d.catalog, dataDir: d.dataDir, staging: moveStagingDir(d.dataDir, record.id) };
    this.pausedNow = record.pausedNoSpace === true;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private t<K extends keyof NonNullable<CopierDeps['timing']>>(k: K, dflt: number): number {
    return this.d.timing?.[k] ?? dflt;
  }

  private async sleep(ms: number): Promise<void> {
    await (this.d.sleep ?? abortableSleep)(ms, this.signal);
    this.check();
  }

  private check(): void {
    if (this.signal.aborted) throw new Stopped();
  }

  private details(extra: Record<string, unknown>): Record<string, unknown> {
    return { moveId: this.r.id, camera: this.r.camera, source: this.r.peer.proxyId, target: this.d.proxyId?.() || null, role: 'target', ...extra };
  }

  private audit(action: 'move-file-failed' | 'move-progress' | 'move-budget-exceeded' | 'move-source-unreachable' | 'move-check' | 'move-outcome-refused', outcome: 'success' | 'failure', message: string, extra: Record<string, unknown>): void {
    this.d.audit.write({
      action, category: ['configuration'], type: [action === 'move-progress' || action === 'move-check' ? 'info' : 'change'], outcome, user: 'cams-admin', camera: this.r.camera,
      message: `Camera move ${this.r.id} (${this.r.camera} from ${this.r.peer.name || this.r.peer.proxyId}): ${message}`,
      details: this.details(extra),
    });
  }

  // The copier's fields into the journal's record (another writer may have
  // changed the phase: then the copy stops).
  private save(force = false): void {
    const now = this.now();
    if (!force && now - this.lastSave < this.t('saveEveryMs', 1000)) return;
    const fresh = this.d.journal.load(this.r.id);
    if (!fresh || fresh.role !== 'target' || fresh.phase !== 'copying') throw new Stopped();
    fresh.chunks = this.r.chunks;
    fresh.bytesDone = this.bytes().done;
    // The chunk list as the source gave it (an ended-early finish keeps every Archive chunk not verified, Task 6).
    if (this.manifest.length) fresh.manifest = this.manifest.map((c) => ({ id: c.id, kind: c.kind, day: c.day, ...metaOf(c) }));
    for (const k of ['budgetExceeded', 'copyStartedAt', 'lastRateBps', 'keep', 'keepMissing', 'keepCopied'] as const) if (this.r[k] !== undefined) (fresh as unknown as Record<string, unknown>)[k] = this.r[k];
    this.d.journal.save(fresh);
    this.r = fresh;
    this.lastSave = now;
  }

  async run(signal: AbortSignal): Promise<void> {
    this.signal = signal;
    try {
      await this.copy();
    } catch (err) {
      if (err instanceof Stopped || signal.aborted) return;
      throw err;
    }
  }

  private approvalDay(): string {
    return dayOf(this.r.approvedAt ?? this.r.startedAt);
  }

  private async copy(): Promise<void> {
    if (this.r.phase !== 'copying' || !this.r.plan) return;
    if (!this.r.plan.transfer) return this.finish();
    if (this.r.copyStartedAt === undefined) {
      this.r.copyStartedAt = this.now();
      this.save(true);
    }
    this.manifest = await this.fetchManifest();
    this.save(true);
    const start = this.bytes();
    this.lastDecile = start.total ? Math.floor((start.done * 10) / start.total) : 0;
    this.lastAuditAt = this.now();
    await this.pass();
    // P12: the switch-over day once more after the source listed it anew.
    if (!this.refreshed && this.manifest.some((c) => c.day >= this.approvalDay())) {
      const rounds = Math.max(1, Math.ceil(this.t('refreshWaitMs', 30 * MINUTE) / this.t('refreshPollMs', 30_000)));
      for (let i = 0; i < rounds && !this.refreshed; i++) {
        await this.sleep(this.t('refreshPollMs', 30_000));
        this.manifest = await this.fetchManifest();
      }
      this.save(true);
      await this.pass();
    }
    const { check, perChunk } = await this.completeness();
    await this.report(perChunk);
    this.finish(check);
  }

  // A refused report counts as none sent: the source keeps every Archive item
  // and deletes the rest (ruling 5); audited (ids and the status only), the
  // record holds no outcome any more.
  private refused(status: number): void {
    logger.warn({ moveId: this.r.id, status }, 'move_outcome_refused');
    delete this.r.keep;
    delete this.r.keepMissing;
    delete this.r.keepCopied;
    const fresh = this.d.journal.load(this.r.id);
    if (fresh && fresh.role === 'target' && fresh.phase === 'copying') {
      delete fresh.keep;
      delete fresh.keepMissing;
      delete fresh.keepCopied;
      this.d.journal.save(fresh);
      this.r = { ...fresh, chunks: this.r.chunks };
    }
    this.audit('move-outcome-refused', 'failure', `the source refused the report of what to keep (HTTP ${status}); it keeps every Archive item of the camera and deletes the rest`, { status });
  }

  // The outcome (step 4 Task 6, ruling 4): what the source keeps, sent straight
  // to it before copied, kept in the journal first (the target's ended-early
  // finish sends it again with what it knows then). Retried like json() until
  // 204; a refusal (400, 403, 404 an older source, 409, 413) ends it: the
  // source then keeps every Archive item and deletes the rest (ruling 5).
  private async report(perChunk: Map<string, ChunkKeep>): Promise<void> {
    const out: MoveOutcome = outcomeOf({ manifest: this.manifest, chunks: this.r.chunks }, perChunk, false);
    this.r.keep = out.keep;
    this.r.keepMissing = out.missing ?? [];
    this.r.keepCopied = out.copied ?? {};
    this.save(true);
    const put = this.client.put;
    if (!put) return;
    let delay = this.t('retryMs', 2000);
    for (;;) {
      this.check();
      try {
        const res = await put(`/api/moves/${this.r.id}/outcome`, out, this.signal);
        discard(res.body);
        if (res.status === 204 || res.status === 200) return;
        // A return's source re-keyed (cams-admin restarted): 403 until move.return.start brings the new token.
        if (this.r.returnOf && (res.status === 401 || res.status === 403)) this.noteDown(String(res.status));
        else if ([400, 403, 404, 409, 413].includes(res.status)) return this.refused(res.status);
        else if (res.status === 503 || res.status === 429) this.sourceBusyUntil = this.now() + MINUTE;
        else this.noteDown(String(res.status));
      } catch {
        this.check();
        this.noteDown('no answer');
      }
      await this.sleep(delay);
      delay = Math.min(delay * 2, this.t('retryCapMs', 5 * MINUTE));
    }
  }

  // The completeness check (step 4 spec §3): every chunk of the plan's kinds
  // this copier copied, listed at the source once more and compared with what
  // the target verified (check.ts). Missing files get one recovery pass that
  // fetches only them; failed and expired files are reported, not retried. A
  // chunk whose rows did not import counts its rows as failed. `perChunk`: the
  // paths the source has to keep (Task 6's keep list).
  async completeness(): Promise<{ check: MoveCheck; perChunk: Map<string, ChunkKeep> }> {
    const plan = this.r.plan!;
    const rows: Parameters<typeof tallyCheck>[0] = [];
    const perChunk = new Map<string, ChunkKeep>();
    for (const c of this.manifest) {
      this.check();
      const rec = this.r.chunks[c.id];
      // Skipped chunks (not in the plan, the target full, gone at the source) and chunks
      // cams-admin reported done (B34, never copied here) are not checked.
      if (!plan.kinds.includes(c.kind) || !rec || (rec.state !== 'verified' && rec.state !== 'failed') || rec.v === undefined) continue;
      const first = await this.compare(c);
      let res = first;
      let recovered = 0;
      if (first.unlisted && c.files > 0) {
        // No listing to compare with: unchecked, the source keeps the whole chunk.
        rows.push({ kind: c.kind, missing: c.files, recovered: 0, failed: 0, expired: 0 });
        perChunk.set(c.id, { missing: [], failed: [], all: true });
        continue;
      }
      if (first.missing.length) {
        await this.chunk(c, new Set(first.missing));
        res = await this.compare(c);
        recovered = first.missing.filter((p) => res.verified.has(p)).length;
        if (res.unlisted && c.files > 0) {
          rows.push({ kind: c.kind, missing: first.missing.length - recovered, recovered, failed: first.failed.length, expired: first.expired.length });
          perChunk.set(c.id, { missing: [], failed: [], all: true });
          continue;
        }
      }
      const now = this.r.chunks[c.id];
      const rowsFailed = !!now && now.state === 'failed' && now.rowsInserted === undefined ? (now.meta?.rows ?? c.rows) : 0;
      rows.push({ kind: c.kind, missing: res.missing.length, recovered, failed: res.failed.length + rowsFailed, expired: res.expired.length });
      // Rows that exist only at the source: it keeps every file of the chunk.
      const failed = rowsFailed > 0 ? [...new Set([...res.failed, ...res.listed.filter((p) => !res.missing.includes(p))])] : res.failed;
      if (res.missing.length || failed.length || res.own.length) perChunk.set(c.id, { missing: res.missing, failed, ...(res.own.length ? { own: res.own } : {}) });
    }
    return { check: tallyCheck(rows), perChunk };
  }

  // One chunk at the check: the source's listing now against the part file (`vf`, `ff`, `xf`) and the disk.
  private async compare(c: ChunkMeta): Promise<Compared> {
    const fresh = await this.relist(c.id);
    const listed = fresh ? [...fresh.values()] : [];
    const part = readChunkPart(this.d.dataDir, this.r.id, c.id);
    const vf = new Set(part?.vf ?? []);
    const of = new Set(part?.of ?? []);
    const verified = new Set<string>();
    const own: string[] = [];
    for (const f of listed) {
      this.check();
      if (vf.has(f.path)) verified.add(f.path);
      else if (!isStaged(f.path) && relOk(this.r.camera, f.path, KIND_FOLDERS[c.kind]) && await this.matches(landingPath(this.paths, f.path), f)) verified.add(f.path);
      else if (of.has(f.path)) own.push(f.path);
    }
    // The target's own file of a name counts as present (not missing); the source keeps its own.
    const present = new Set([...verified, ...own]);
    const out = compareChunk({ kind: c.kind, listed, verified: present, failed: new Set(part?.ff ?? []), expired: new Set(part?.xf ?? []) });
    return { ...out, own, verified, listed: listed.map((f) => f.path), unlisted: !fresh };
  }

  // The chunks in chunkOrder: Archive first, then newest day first.
  private async fetchManifest(): Promise<ChunkMeta[]> {
    const m = await this.json(`/api/moves/${this.r.id}/manifest`);
    const body = (m.status === 200 ? m.body : null) as { chunks?: unknown; refreshed?: unknown } | null;
    const list = Array.isArray(body?.chunks) ? (body.chunks as ChunkMeta[]) : [];
    this.refreshed = body?.refreshed === true;
    const ok = list.filter((c) => c && typeof c.id === 'string' && /^(stills|clips|events|checks|archive):\d{4}-\d{2}-\d{2}$/.test(c.id) && c.id === `${c.kind}:${c.day}`
      && [c.files, c.bytes, c.rows].every((n) => Number.isSafeInteger(n) && n >= 0));
    return [...new Map(ok.map((c) => [c.id, { id: c.id, kind: c.kind, day: c.day, ...metaOf(c) }])).values()]
      .sort(chunkOrder);
  }

  private async pass(): Promise<void> {
    const plan = this.r.plan!;
    let full = false;
    for (const c of this.manifest) {
      this.check();
      const rec = this.r.chunks[c.id];
      if (rec && FINAL.includes(rec.state) && (c.day < this.approvalDay() || sameMeta(rec.meta, c))) continue;
      // B34: what cams-admin reported done counts as verified unless the journal knows better.
      // Not for a return (Task 11 review M3): the new proxy deletes what this
      // proxy reports verified, so every chunk is copied and checked here.
      if (!rec && !this.r.returnOf && this.r.done?.includes(c.id)) {
        this.r.chunks[c.id] = { state: 'verified', b: c.bytes, meta: metaOf(c) };
        this.save(true);
        continue;
      }
      if (!plan.kinds.includes(c.kind)) {
        this.skipChunk(c);
        continue;
      }
      // A return (step 4 Task 10, Decision 5): the original's own camera; a
      // chunk that doesn't fit waits for room, never skipped and never at the
      // cost of the original's own older content (fits: room without evicting).
      if (this.r.returnOf && rec?.state !== 'verified') await this.waitRoom(c);
      else if (plan.space === 'fit' && rec?.state !== 'verified' && (full || !this.fits(c))) {
        // Archive first, then newest first, until the target is full; the rest is skipped.
        full = true;
        this.skipChunk(c);
        continue;
      }
      await this.chunk(c);
    }
  }

  private skipChunk(c: ChunkMeta): void {
    this.r.chunks[c.id] = { state: 'skipped', s: c.files, b: c.bytes, meta: metaOf(c) };
    this.save(true);
    this.progress();
  }

  // A return's chunk without room: paused (no_space, once) until there is, then on again.
  private async waitRoom(c: ChunkMeta): Promise<void> {
    if (!this.roomFor(c)) {
      logger.info({ moveId: this.r.id, chunkId: c.id }, 'move_return_waits_for_room');
      if (!this.pausedNow) this.d.notePaused?.(this.r, true);
      this.pausedNow = true;
      do await this.sleep(this.t('pausedPollMs', 10_000));
      while (!this.roomFor(c));
    }
    if (this.pausedNow) this.d.notePaused?.(this.r, false);
    this.pausedNow = false;
  }

  // Room for a return's chunk that never makes the original push out its own
  // older content (Decision 5): it fits now (no eviction), the budget keeps a
  // 5 % reserve after it (the camera's own new recordings), and storage has not
  // evicted for a cap or the budget within the hour (the host is at its limit:
  // freed room is its own camera's).
  private roomFor(c: ChunkMeta): boolean {
    const at = this.d.space.evictedAt?.() ?? null;
    if (at !== null && this.now() - at < RETURN_EVICT_QUIET_MS) return false;
    const u = this.d.space.usage();
    if (u.used + c.bytes > u.budget * (1 - RETURN_RESERVE)) return false;
    return this.fits(c);
  }

  // The same headroom as the offer's evaluation (spaceFor): room without evicting.
  private fits(c: ChunkMeta): boolean {
    const summary = Object.fromEntries(MOVE_KINDS.map((k) => [k, { files: 0, bytes: k === c.kind ? c.bytes : 0, rows: 0, oldest: null, newest: null }])) as MoveSummary;
    return spaceFor(this.d.space, summary).fits;
  }

  // `only` (the recovery pass of the completeness check): only these files are
  // fetched; the others count as before (failed if the part's `ff` names them,
  // else verified: the check found them so).
  private async chunk(c: ChunkMeta, only?: Set<string>): Promise<void> {
    // What an earlier copy of this chunk verified and imported (its part file).
    const prev = readChunkPart(this.d.dataDir, this.r.id, c.id);
    const before = this.r.chunks[c.id];
    this.r.chunks[c.id] = { state: 'pending' };
    this.current = 0;
    this.save(true);
    await this.waitStorage();
    const m = await this.json(`/api/moves/${this.r.id}/chunks/${encodeURIComponent(c.id)}`);
    if (m.status === 404) {
      if (!only || !before) return this.skipChunk(c);
      // Gone at the source since the check listed it: the chunk stays as it ended.
      this.r.chunks[c.id] = before;
      this.save(true);
      return;
    }
    const body = m.body as { files?: unknown; rows?: unknown } | null;
    if (!body || !Array.isArray(body.files)) return this.endChunk(c, { v: 0, s: 0, f: 1, vb: 0, b: c.bytes }, { failed: [], tried: [], triedCount: 0, expired: [] }, undefined);
    const n = { v: 0, s: 0, f: 0, vb: 0, b: 0 };
    // Every failed file of the chunk (the part's `ff`), and those that failed in this run (audited, at most 50 paths).
    const failed: string[] = [];
    const tried: string[] = [];
    let triedCount = 0;
    const expired: string[] = [];
    const verified = new Set<string>();
    const vf = new Set(prev?.vf ?? []);
    const ff = new Set(prev?.ff ?? []);
    const of = new Set(prev?.of ?? []);
    const own: string[] = [];
    const staged: string[] = [];
    for (const raw of body.files as ManifestFile[]) {
      this.check();
      const ok = !!raw && relOk(this.r.camera, raw.path, KIND_FOLDERS[c.kind]) && Number.isSafeInteger(raw.size) && raw.size >= 0 && typeof raw.sha256 === 'string' && SHA256.test(raw.sha256);
      const size = ok ? raw.size : 0;
      const path = ok ? raw.path : String(raw?.path ?? '').slice(0, 200);
      const asBefore = !!only && !(ok && only.has(raw.path));
      const out: FileOutcome = asBefore ? (!ok || ff.has(path) ? 'f' : of.has(path) ? 'o' : 'v') : !ok ? 'f' : vf.has(raw.path) ? 'v' : await this.file(raw, c.id);
      if (out === 'v') {
        n.v++;
        n.vb += size;
        verified.add(raw.path);
        if (isStaged(raw.path)) {
          vf.add(raw.path);
          staged.push(raw.path);
        }
      } else if (out === 's' || out === 'x' || out === 'o') {
        n.s++;
        if (out === 'x') expired.push(raw.path);
        if (out === 'o') own.push(raw.path);
      } else {
        n.f++;
        failed.push(path);
        if (!asBefore) {
          triedCount++;
          if (tried.length < FAILED_PATHS_MAX) tried.push(path);
        }
      }
      n.b += size;
      this.current = n.b;
      this.save();
      this.progress();
    }
    // Then the rows (files first, S §8.2).
    const rows = c.rows > 0 || (typeof body.rows === 'number' && body.rows > 0) ? await this.rows(c) : [];
    let imported: ReturnType<typeof importRows> | undefined;
    let delay = this.t('retryMs', 2000);
    for (let i = 0; i < ATTEMPTS && !imported; i++) {
      try {
        imported = importRows(this.paths, this.r.camera, rows, verified, prev?.imported, { moveId: this.r.id, from: { proxyId: this.r.peer.proxyId, name: this.r.peer.name }, at: this.now() });
      } catch {
        logger.warn({ moveId: this.r.id, chunkId: c.id }, 'move_copy_import_failed');
        if (i < ATTEMPTS - 1) {
          await this.sleep(delay);
          delay = Math.min(delay * 2, this.t('retryCapMs', 5 * MINUTE));
        }
      }
    }
    // Staged files the import did not take (a duplicate, a row not imported, or the import failed).
    for (const rel of staged) rmSync(landingPath(this.paths, rel), { force: true });
    const o = { failed, tried, triedCount, expired, own, verified };
    if (!imported) {
      // The rows could not be imported 3 times: the chunk fails (counted, audited).
      n.f++;
      return this.endChunk(c, n, o, undefined, [], true);
    }
    this.endChunk(c, n, o, imported, [...vf]);
  }

  // A chunk's rows: anything but a list (a 404, a body that isn't one) is
  // asked for again; a chunk is never verified without its rows.
  // `unknown_chunk` (the source re-listed the day): the chunk listed again, up
  // to 3 times; after that, and for an answer that keeps not being a list, the
  // source counts as refusing (move-source-unreachable, the 6 h rule).
  private async rows(c: ChunkMeta): Promise<TableRows[]> {
    let delay = this.t('retryMs', 2000);
    let relists = 0;
    let odd = 0;
    for (;;) {
      const r = await this.json(`/api/moves/${this.r.id}/chunks/${encodeURIComponent(c.id)}/rows`, { up: false });
      if (r.status === 200 && Array.isArray(r.body)) {
        this.noteUp();
        return r.body as TableRows[];
      }
      if (r.status === 404 && r.error === 'unknown_chunk' && relists < ATTEMPTS) {
        relists++;
        await this.relist(c.id, { up: false });
        continue;
      }
      if (r.status === 404) this.noteDown(`rows 404${r.error ? ` ${r.error}` : ''}`);
      else if (r.status === 200 && ++odd >= ATTEMPTS) this.noteDown('rows not a list');
      await this.sleep(delay);
      delay = Math.min(delay * 2, this.t('retryCapMs', 5 * MINUTE));
    }
  }

  // The chunk's file manifest again (the source dropped its cached one, P12): path -> entry, null when gone.
  private async relist(chunkId: string, o: { up?: boolean } = {}): Promise<Map<string, ManifestFile> | null> {
    const m = await this.json(`/api/moves/${this.r.id}/chunks/${encodeURIComponent(chunkId)}`, o);
    const files = m.status === 200 ? (m.body as { files?: unknown } | null)?.files : null;
    if (!Array.isArray(files)) return null;
    return new Map((files as ManifestFile[]).filter((x) => x && typeof x.path === 'string').map((x) => [x.path, x]));
  }

  // `o.failed`: every failed file (the part's `ff`); `o.tried`: those that failed in this run (the audit, at
  // most 50 of `o.triedCount`); `o.expired`: removed at the source meanwhile (added to the part's `xf`).
  private endChunk(c: ChunkMeta, n: { v: number; s: number; f: number; vb: number; b: number }, o: { failed: string[]; tried: string[]; triedCount: number; expired: string[]; own?: string[]; verified?: Set<string> }, imported: ReturnType<typeof importRows> | undefined, vf: string[] = [], importFailed = false): void {
    // The part file first (a restart in between copies the chunk again and finds it).
    const prev = readChunkPart(this.d.dataDir, this.r.id, c.id);
    // An earlier import's map stays known (a delete-cancel removes those rows too).
    const map = imported?.map ?? prev?.imported;
    const files = vf.length ? vf : importFailed ? [] : (prev?.vf ?? []);
    const ff = [...new Set(o.failed)];
    const xf = [...new Set([...(prev?.xf ?? []).filter((p) => !o.verified?.has(p)), ...o.expired])];
    const of = [...new Set([...(prev?.of ?? []).filter((p) => !o.verified?.has(p)), ...(o.own ?? [])])];
    const part = {
      ...(files.length ? { vf: files } : {}), ...(map && Object.keys(map).length ? { imported: map } : {}),
      ...(ff.length ? { ff } : {}), ...(xf.length ? { xf } : {}), ...(of.length ? { of } : {}),
    };
    if (Object.keys(part).length || prev) writeChunkPart(this.d.dataDir, this.r.id, c.id, part);
    this.r.chunks[c.id] = {
      // "copied with failures" is `failed` (X17/B47).
      state: n.f > 0 ? 'failed' : 'verified',
      v: n.v, s: n.s, f: n.f, vb: n.vb, b: n.b, meta: metaOf(c),
      ...(imported ? { rowsInserted: imported.inserted, rowsSkipped: imported.skipped } : {}),
    };
    this.current = 0;
    this.save(true);
    if (o.triedCount || importFailed) {
      const files = o.triedCount;
      const what = [...(files ? [`${files} file${files === 1 ? '' : 's'} of ${c.id} failed their checks 3 times`] : []), ...(importFailed ? [`the rows of ${c.id} could not be imported (3 tries)`] : [])];
      this.audit('move-file-failed', 'failure', what.join('; '), { chunk: c.id, failed: n.f, paths: o.tried, ...(importFailed ? { import: 'failed' } : {}) });
    }
    this.progress();
  }

  // One file: 'v' verified (copied, or already here), 's' skipped (expired at
  // the source, or a file of that name the target stored itself), 'f' failed.
  private async file(entry: ManifestFile, chunkId: string): Promise<FileOutcome> {
    let f = entry;
    let relists = 0;
    const landing = landingPath(this.paths, f.path);
    const staged = isStaged(f.path);
    if (await this.matches(landing, f)) return 'v';
    if (!staged && existsSync(landing)) return 'o';
    const part = `${landing}.move-${this.r.id}.part`;
    let failures = 0;
    let delay = this.t('retryMs', 2000);
    while (failures < ATTEMPTS) {
      this.check();
      await this.waitStorage();
      let out: Fetched;
      try {
        out = await this.fetchTo(f, part, landing, staged);
      } finally {
        rmSync(part, { force: true });
      }
      if (out === 'ok' && !staged) {
        // Listed as the move's (a cancel with copied delete removes it, never a file the target had).
        try {
          noteLanded(this.d.dataDir, this.r.id, f.path);
        } catch {
          logger.warn({ moveId: this.r.id }, 'move_copy_landed_not_noted');
        }
      }
      if (out === 'ok' || out === 'same') return 'v';
      if (out === 'other') return 'o';
      if (out === 'expired') return 'x';
      if (out === 'paused') continue;
      if (out === 'unlisted') {
        if (relists++ < ATTEMPTS) {
          // The source listed the day again (P12) and dropped this chunk's manifest: ask for it again, then the file.
          const fresh = await this.relist(chunkId);
          // No listing at all is not "gone": it counts as a failure (kept at the source).
          if (!fresh) {
            failures++;
            continue;
          }
          const now = fresh.get(f.path);
          if (!now) return 'x';
          if (!Number.isSafeInteger(now.size) || now.size < 0 || typeof now.sha256 !== 'string' || !SHA256.test(now.sha256)) return 's';
          f = { path: f.path, size: now.size, sha256: now.sha256 };
          continue;
        }
        // Still not listed after 3 listings: a failure (3 of them fail the file).
        failures++;
      }
      // Only a wrong size or hash counts; a cut or stalled stream is the source restarting (Review Focus 1).
      if (out === 'bad') failures++;
      if (failures < ATTEMPTS) {
        await this.sleep(delay);
        delay = Math.min(delay * 2, this.t('retryCapMs', 5 * MINUTE));
      }
    }
    return 'f';
  }

  private async matches(path: string, f: ManifestFile): Promise<boolean> {
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.size !== f.size) return false;
      return (await hashFile(path)).sha256 === f.sha256;
    } catch {
      return false;
    }
  }

  private async fetchTo(f: ManifestFile, part: string, landing: string, staged: boolean): Promise<Fetched> {
    this.updateRate();
    let res: SourceAnswer;
    try {
      res = await this.client.get(`/api/moves/${this.r.id}/file?path=${encodeURIComponent(f.path)}`, this.signal);
    } catch {
      this.check();
      this.noteDown('no answer');
      return 'transient';
    }
    if (res.status === 404) {
      // `expired`: removed by retention (skip it); `not_listed`: the chunk's manifest is gone (ask again).
      // Any other 404 is not read as gone (the source would delete the file at the end): asked again.
      const error = await this.errorOf(res.body);
      if (error === 'not_listed') return (this.noteUp(), 'unlisted');
      if (error === 'expired') return (this.noteUp(), 'expired');
      this.noteDown(`404${error ? ` ${error}` : ''}`);
      return 'transient';
    }
    if (res.status !== 200) {
      discard(res.body);
      // 503 and 429 are pressure (the rate halves for a minute), never the source down.
      if (res.status === 503 || res.status === 429) this.sourceBusyUntil = this.now() + MINUTE;
      else this.noteDown(String(res.status));
      // 400 (a path the source refuses) counts; the rest is the source not ready or busy.
      return res.status === 400 || res.status === 416 ? 'bad' : 'transient';
    }
    this.noteUp();
    mkdirSync(dirname(part), { recursive: true });
    const fh = await open(part, 'w', 0o644);
    const hash = createHash('sha256');
    let size = 0;
    const guard = idleGuard(res.body, this.t('idleMs', MINUTE));
    const t0 = this.now();
    // A return measures its rate only from a file fetched without pressure or a limit (the bucket's waits are not the link's speed, N1).
    const free = !this.pressure() && !Number.isFinite(this.rate);
    guard.arm();
    try {
      for await (const buf of res.body) {
        guard.pause();
        this.check();
        if (this.d.paused()) {
          discard(res.body);
          return 'paused';
        }
        size += buf.length;
        if (size > f.size) {
          discard(res.body);
          return 'bad';
        }
        await this.bucket.take(buf.length, this.currentRate(), this.signal);
        this.check();
        hash.update(buf);
        await fh.write(buf);
        // A long file still reports every minute.
        this.inflight = size;
        if (this.now() - this.lastEmit >= MINUTE) this.progress();
        guard.arm();
      }
    } catch (err) {
      this.check();
      if (err instanceof Stopped) throw err;
      // A cut or stalled stream (the source restarted mid-file, Review Focus 1): the part goes, the file is fetched again, not counted.
      return 'transient';
    } finally {
      guard.pause();
      this.inflight = 0;
      await fh.close();
    }
    const tookMs = this.now() - t0;
    if (free && !this.pressure() && size > 0 && tookMs > 0) this.measuredBps = (size * 1000) / tookMs;
    if (size !== f.size || hash.digest('hex') !== f.sha256) return 'bad';
    if (staged) {
      mkdirSync(dirname(landing), { recursive: true });
      renameSync(part, landing);
      return 'ok';
    }
    // Never over a file the target stored itself (a still pack of the overlap minute, P12).
    try {
      try {
        linkSync(part, landing);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw err;
        copyFileSync(part, landing, constants.COPYFILE_EXCL);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return (await this.matches(landing, f)) ? 'same' : 'other';
    }
    unlinkSync(part);
    const kind = f.path.split('/')[0];
    if (kind === 'stills' || kind === 'previews' || kind === 'clips') this.d.noteWritten?.(kind, f.size, this.r.camera);
    return 'ok';
  }

  // The source not answering or refusing (anything but 200 and 404): a log
  // line and an audit record at the first failure, then every 6 hours while it lasts.
  private noteDown(what: string): void {
    const now = this.now();
    if (!this.down) {
      this.down = { since: now, failures: 0, audited: -Infinity };
      logger.warn({ moveId: this.r.id, answer: what }, 'move_copy_source_unreachable');
    }
    this.down.failures++;
    if (now - this.down.audited >= 6 * HOUR) {
      this.down.audited = now;
      this.audit('move-source-unreachable', 'failure', `the source has not answered as it should since ${new Date(this.down.since).toISOString()} (${this.down.failures} tries, last: ${what}); copying keeps trying`, {
        since: this.down.since, failures: this.down.failures, answer: what,
      });
    }
  }

  private noteUp(): void {
    this.down = null;
  }

  private async errorOf(body: AsyncIterable<Buffer>): Promise<string | null> {
    try {
      const v = JSON.parse((await readAll(body, this.t('idleMs', MINUTE))).toString('utf8')) as { error?: unknown };
      return typeof v?.error === 'string' ? v.error : null;
    } catch {
      return null;
    }
  }

  // A JSON answer of the source; waits out an unreachable or busy source.
  // `up: false`: the caller decides whether the answer means the source is back.
  private async json(path: string, o: { up?: boolean } = {}): Promise<{ status: number; body: unknown; error?: string | null }> {
    const up = () => o.up !== false && this.noteUp();
    let delay = this.t('retryMs', 2000);
    for (;;) {
      this.check();
      try {
        const res = await this.client.get(path, this.signal);
        if (res.status === 200) {
          const body = JSON.parse((await readAll(res.body, this.t('idleMs', MINUTE))).toString('utf8')) as unknown;
          up();
          return { status: 200, body };
        }
        if (res.status === 404) {
          const error = await this.errorOf(res.body);
          up();
          return { status: 404, body: null, error };
        }
        discard(res.body);
        if (res.status === 503 || res.status === 429) this.sourceBusyUntil = this.now() + MINUTE;
        else this.noteDown(String(res.status));
      } catch {
        this.check();
        this.noteDown('no answer');
      }
      await this.sleep(delay);
      delay = Math.min(delay * 2, this.t('retryCapMs', 5 * MINUTE));
    }
  }

  private async waitStorage(): Promise<void> {
    let noted = false;
    while (this.d.paused()) {
      if (!noted) {
        logger.info({ moveId: this.r.id }, 'move_copy_waits_for_storage');
        noted = true;
      }
      await this.sleep(this.t('pausedPollMs', 10_000));
    }
  }

  private bytes(): { done: number; total: number } {
    let done = this.current + this.inflight;
    let total = 0;
    for (const c of this.manifest) {
      const rec = this.r.chunks[c.id];
      const final = rec && FINAL.includes(rec.state);
      total += final ? (rec.b ?? c.bytes) : c.bytes;
      if (final) done += rec.b ?? c.bytes;
    }
    return { done, total: Math.max(total, done) };
  }

  private pressure(): boolean {
    return this.d.paused() || this.d.cpuBusy?.() === true || this.now() < this.sourceBusyUntil;
  }

  // Recomputed at every file and every minute (S §8.3).
  private updateRate(): void {
    const now = this.now();
    if (this.r.returnOf) {
      // A return is not paced (no budget, ruling 8 as changed in fix round 1): the probe if any, else
      // as fast as it goes; halved under pressure (of the probe, else of the last file's rate).
      const probe = (this.r.probeBps ?? 0) > 0 ? this.r.probeBps! : Infinity;
      const busy = Number.isFinite(probe) ? probe : this.measuredBps > 0 ? this.measuredBps : RETURN_BUSY_BPS;
      // Never below half the busy rate (a lasting pressure must not slow it to a stall, N1).
      this.rate = this.pressure() ? Math.max(Math.floor(busy / 2), Number.isFinite(probe) ? 1 : RETURN_BUSY_BPS / 2) : probe;
      this.rateAt = now;
      return;
    }
    const { done, total } = this.bytes();
    const remaining = total - done;
    // The budget counts from approval (cams-admin's clock, the switch-over included); the copy start
    // only for a record without one.
    const budgetS = this.r.budgetS ?? this.r.plan?.budgetS ?? 0;
    const elapsedS = (now - (this.r.approvedAt ?? this.r.copyStartedAt ?? now)) / 1000;
    const remainingS = budgetS - elapsedS;
    const aimS = paceS(budgetS, elapsedS);
    const over = remainingS <= 0 && remaining > 0;
    if (over && !this.r.budgetExceeded) {
      this.r.budgetExceeded = true;
      this.save(true);
      // A return has no approved budget (ruling 8): the pace only, nothing to audit.
      if (!this.r.returnOf) this.audit('move-budget-exceeded', 'failure', `the time budget of ${this.r.budgetS ?? this.r.plan?.budgetS}s is over with ${remaining} bytes left; copying goes on, never faster`, {
        budgetS: this.r.budgetS ?? this.r.plan?.budgetS ?? null, elapsedS: Math.round(elapsedS), bytesDone: done, bytesTotal: total,
      });
    }
    const probe = this.r.probeBps ?? 0;
    const base = rateFor(remaining, aimS, probe, false, over || this.r.budgetExceeded === true, this.r.lastRateBps ?? 0);
    if (Number.isFinite(base)) this.r.lastRateBps = base;
    this.rate = this.pressure() ? rateFor(remaining, aimS, probe, true, over || this.r.budgetExceeded === true, this.r.lastRateBps ?? 0) : base;
    this.rateAt = now;
  }

  private currentRate(): number {
    if (this.now() - this.rateAt >= MINUTE) this.updateRate();
    return this.rate;
  }

  private states(): { id: string; state: ChunkState }[] {
    return this.manifest.slice(0, PROGRESS_CHUNKS_MAX).map((c) => ({ id: c.id, state: this.r.chunks[c.id]?.state ?? 'pending' }));
  }

  // move.progress every 10 % of the bytes or 60 s; the audit at the same 10 % steps and at least hourly.
  private progress(force = false): void {
    const now = this.now();
    const { done, total } = this.bytes();
    const decile = total > 0 ? Math.floor((done * 10) / total) : 10;
    const step = decile > this.lastDecile;
    if (!force && !step && now - this.lastEmit < MINUTE && now - this.lastAuditAt < HOUR) return;
    const rateBps = Number.isFinite(this.rate) ? Math.max(0, Math.floor(this.rate)) : 0;
    const etaS = rateBps > 0 ? Math.ceil((total - done) / rateBps) : 0;
    if (force || step || now - this.lastEmit >= MINUTE) {
      this.d.emit({ kind: 'move.progress', moveId: this.r.id, chunks: this.states(), bytesDone: done, bytesTotal: total, rateBps, etaS });
      this.lastEmit = now;
    }
    if (step || now - this.lastAuditAt >= HOUR) {
      const percent = step ? decile * 10 : total > 0 ? Math.floor((done * 100) / total) : 100;
      const count = (s: ChunkState) => Object.values(this.r.chunks).filter((c) => c.state === s).length;
      this.audit('move-progress', 'success', `${percent}% copied (${done} of ${total} bytes)`, {
        percent, bytesDone: done, bytesTotal: total, rateBps, etaS,
        chunks: { total: this.manifest.length, verified: count('verified'), skipped: count('skipped'), failed: count('failed') },
      });
      this.lastAuditAt = now;
      if (step) this.lastDecile = decile;
    }
  }

  // `check`: the completeness check (none for a move without transfer); audited as move-check.
  private finish(check?: MoveCheck): void {
    const counts = { verified: 0, skipped: 0, failed: 0, bytes: 0 };
    for (const c of this.manifest) {
      const rec = this.r.chunks[c.id];
      if (!rec) continue;
      counts.verified += rec.v ?? 0;
      counts.skipped += rec.s ?? 0;
      counts.failed += rec.f ?? 0;
      counts.bytes += rec.vb ?? 0;
    }
    if (this.manifest.length) {
      this.save(true);
      this.progress(true);
    }
    rmSync(this.paths.staging, { recursive: true, force: true });
    const fresh = this.d.journal.load(this.r.id);
    if (!fresh || fresh.phase !== 'copying') return;
    if (check) {
      const sum = (k: 'missing' | 'recovered' | 'failed' | 'expired') => Object.values(check[k]).reduce((a, b) => a + (b ?? 0), 0);
      this.audit('move-check', check.complete ? 'success' : 'failure',
        `${check.complete ? 'complete' : 'not complete'}: ${sum('missing')} missing, ${sum('recovered')} recovered, ${sum('failed')} failed, ${sum('expired')} expired at the source`,
        { check });
      // Kept with the record: a repeated move.return.start sends copied again with it (Task 11).
      fresh.check = check;
    }
    this.d.setPhase(fresh, 'copied', {
      detail: `${this.manifest.length} chunks: ${counts.verified} files verified, ${counts.skipped} skipped, ${counts.failed} failed, ${counts.bytes} bytes`,
      extra: { counts },
      ...(check ? { check } : {}),
    });
  }
}

// One Copier per move (startCopy may come again: a resent move.start, a
// resume); stop() aborts it and waits for its end (Task 10's cancel).
export class CopyRunner {
  private readonly runs = new Map<string, { ctl: AbortController; done: Promise<void> }>();

  constructor(private readonly d: CopierDeps) {}

  start(moveId: string): void {
    if (this.runs.has(moveId)) return;
    let r: MoveRecord | null;
    try {
      r = this.d.journal.load(moveId);
    } catch {
      return;
    }
    if (!r || r.role !== 'target' || r.phase !== 'copying') return;
    const ctl = new AbortController();
    const entry = { ctl, done: Promise.resolve() };
    entry.done = new Copier(this.d, r)
      .run(ctl.signal)
      .catch(() => this.crashed(moveId))
      .finally(() => {
        if (this.runs.get(moveId) === entry) this.runs.delete(moveId);
      });
    this.runs.set(moveId, entry);
  }

  running(moveId: string): boolean {
    return this.runs.has(moveId);
  }

  idle(moveId: string): Promise<void> {
    return this.runs.get(moveId)?.done ?? Promise.resolve();
  }

  async stop(moveId: string): Promise<void> {
    const run = this.runs.get(moveId);
    if (!run) return;
    run.ctl.abort();
    await run.done;
  }

  // The process stop: every copier aborted; waited for at most `waitMs` (a
  // file in flight that ignores the abort must not hold up the stop, as
  // MoveTarget.stopAll).
  async stopAll(waitMs = 3000): Promise<void> {
    const all = Promise.all([...this.runs.keys()].map((id) => this.stop(id)));
    let t: NodeJS.Timeout | undefined;
    await Promise.race([all, new Promise<void>((r) => (t = setTimeout(r, waitMs)))]);
    clearTimeout(t);
  }

  // An unexpected throw (the journal or the catalog unwritable): a fixed line, the move failed.
  private crashed(moveId: string): void {
    logger.error({ moveId }, 'move_copy_failed');
    try {
      const r = this.d.journal.load(moveId);
      if (r && r.phase === 'copying') {
        const cam = r.camera;
        removeMoveParts(this.d.dataDir, moveId, cam);
        this.d.setPhase(r, 'failed', { code: 'copy_failed' });
      }
    } catch {
      logger.error({ moveId }, 'move_copy_failure_not_recorded');
    }
  }
}
