import type { AuditLog } from '../audit/audit-log';
import { InventoryBusyError, InventoryStoppingError, type InventoryReport, type InventoryRunner } from '../inventory/runner';
import { errorMessage, logger } from '../log';
import { HOUR, MINUTE } from '../time-units';
import { moveEnded, type MoveJournal } from './journal';
import type { MoveSyncClips, MoveSyncRecord, MoveSyncTrigger } from './sync-types';
import type { MoveRole } from './types';

// The post-move sync (issue #311; spec 2026-10-21-camera-move-design,
// amendment 2026-11-02). A move's completeness check (check.ts) compares the
// two proxies only; a clip that reached neither (recorded while the camera
// switched, an FTP gap around the move) stays unnoticed. So the proxy that has
// the camera at the end compares with the camera's own SD card and fetches
// what is missing:
// - the receiving proxy once its move finished (move.finish {role: target});
// - the original proxy after a cancel past the switch-over (the camera runs
//   here again), once the copy back (the return) finished, or 30 minutes after
//   the cancel when no copy back runs here by then (it brings what the other
//   proxy captured; fetched from the camera first, a clip could come twice).
// The loop, with the inventory runner in process (the same runs and records
// as the admin's): the clips check with the camera, a clips repair while
// recordings are missing, again, until nothing is missing, a repair fetches
// nothing, it stops (retention-full, paused, failures, refused) or 20 checks
// ran; then the events check and one events repair when events are missing.
// The repair's own rules hold (newest first, within retention, 50 clips /
// 200 MB per run, Baichuan at low priority: viewers first). One sync at a
// time; another inventory running: it waits (30 s) and tries again. The
// camera offline or not running here, a run failing: tried again later
// (1 min, doubling, at most 30 min), given up 24 h after it became due. The
// state is in the move's tombstone (journal.ts): a restart resumes it. Audited
// `move-sync`: its start, its end, and a give-up; the retries only in the log.

export const SYNC_RETRY_MS = MINUTE;
export const SYNC_RETRY_CAP_MS = 30 * MINUTE;
export const SYNC_GIVE_UP_MS = 24 * HOUR;
export const SYNC_BUSY_MS = 30_000;
export const SYNC_RETURN_GRACE_MS = 30 * MINUTE;
export const SYNC_RETURN_POLL_MS = 5 * MINUTE;
export const SYNC_MAX_ROUNDS = 20;
// A repair run's own caps: the next round goes on.
const CAPS = new Set(['clip-cap', 'byte-cap', 'event-cap']);
const ENDED = new Set(['done', 'failed', 'gave-up']);
// The runs it starts: the system's, on behalf of the move sync.
const WHO = { user: 'move-sync', requestedBy: 'system' as const };

// ok: the camera runs here and is online; offline: not online (or not
// running yet); gone: no longer this proxy's camera (removed, moved on).
export type SyncReadiness = 'ok' | 'offline' | 'gone';

export interface MoveSyncDeps {
  journal: Pick<MoveJournal, 'ended' | 'setSync' | 'syncs' | 'all'>;
  runner: Pick<InventoryRunner, 'start' | 'repair'>;
  audit: Pick<AuditLog, 'write'>;
  ready: (cam: string) => SyncReadiness;
  now?: () => number;
  proxyId?: () => string;
  // Tests: when to process a sync again (default: a timer), and the busy wait.
  schedule?: (key: string, at: number) => void;
  sleep?: (ms: number) => Promise<void>;
  timing?: { retryMs?: number; retryCapMs?: number; giveUpMs?: number; busyMs?: number; returnGraceMs?: number; returnPollMs?: number };
}

class Retry extends Error {}
class Stopped extends Error {}
class Cancelled extends Error {}

export interface MoveSyncView { moveId: string; role: MoveRole; camera: string; sync: MoveSyncRecord }

export class MoveSync {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly waits = new Set<() => void>();
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly d: MoveSyncDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private t<K extends keyof NonNullable<MoveSyncDeps['timing']>>(k: K, dflt: number): number {
    return this.d.timing?.[k] ?? dflt;
  }

  // The receiving proxy: its move finished (the tombstone is written).
  finished(moveId: string, camera: string): void {
    this.request(moveId, 'target', camera, 'finished', this.now(), false);
  }

  // The original proxy: a cancel past the switch-over closed, the camera runs
  // here again; it waits for the copy back (returned()) or its grace.
  cancelled(moveId: string, camera: string): void {
    this.request(moveId, 'source', camera, 'cancelled', this.now() + this.t('returnGraceMs', SYNC_RETURN_GRACE_MS), true);
  }

  // The copy back of a cancelled move finished here: its sync is due now.
  returned(moveId: string): void {
    const s = this.d.journal.ended(moveId, 'source')?.sync;
    if (!s || s.state !== 'pending') return;
    const next: MoveSyncRecord = { ...s, dueAt: this.now() };
    delete next.waitReturn;
    this.save(moveId, 'source', next);
    this.schedule(moveId, 'source', next.dueAt);
  }

  private request(moveId: string, role: MoveRole, camera: string, trigger: MoveSyncTrigger, dueAt: number, waitReturn: boolean): void {
    try {
      const stone = this.d.journal.ended(moveId, role);
      if (!stone || stone.sync) return;
      const s: MoveSyncRecord = { state: 'pending', trigger, camera, requestedAt: this.now(), dueAt, ...(waitReturn ? { waitReturn: true } : {}), attempts: 0 };
      if (!this.d.journal.setSync(moveId, role, s)) return;
      this.schedule(moveId, role, dueAt);
    } catch (err) {
      // Never fails the move's end: logged.
      logger.warn({ moveId, err: errorMessage(err) }, 'move_sync_request_failed');
    }
  }

  // At process start: every sync not ended, pending again (a crash may have left one running).
  resume(): void {
    this.stopped = false;
    let all: ReturnType<MoveSyncDeps['journal']['syncs']> = [];
    try {
      all = this.d.journal.syncs();
    } catch {
      return;
    }
    for (const x of all) {
      if (ENDED.has(x.sync.state)) continue;
      if (x.sync.state === 'running') this.save(x.moveId, x.role, { ...x.sync, state: 'pending' });
      this.schedule(x.moveId, x.role, x.sync.dueAt);
    }
  }

  // The process stops: no new try; a waiting one ends (it stays pending).
  stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const w of this.waits) w();
    return this.chain;
  }

  // The syncs within their tombstones' keep, newest first.
  list(): MoveSyncView[] {
    let all: ReturnType<MoveSyncDeps['journal']['syncs']> = [];
    try {
      all = this.d.journal.syncs();
    } catch {
      return [];
    }
    return all.sort((a, b) => b.sync.requestedAt - a.sync.requestedAt).map((x) => ({ moveId: x.moveId, role: x.role, camera: x.sync.camera, sync: x.sync }));
  }

  private schedule(moveId: string, role: MoveRole, at: number): void {
    const key = `${moveId}.${role}`;
    if (this.d.schedule) return this.d.schedule(key, at);
    if (this.stopped) return;
    clearTimeout(this.timers.get(key));
    const timer = setTimeout(() => {
      this.timers.delete(key);
      // One sync at a time, in the order they come due.
      this.chain = this.chain.then(() => this.process(moveId, role)).catch((err) => logger.warn({ moveId, err: errorMessage(err) }, 'move_sync_failed'));
    }, Math.max(0, at - this.now()));
    timer.unref();
    this.timers.set(key, timer);
  }

  private save(moveId: string, role: MoveRole, s: MoveSyncRecord): void {
    this.d.journal.setSync(moveId, role, s);
  }

  // One try of a sync when it is due (otherwise it is scheduled for then).
  async process(moveId: string, role: MoveRole): Promise<void> {
    if (this.stopped) return;
    let s = this.d.journal.ended(moveId, role)?.sync;
    if (!s || ENDED.has(s.state)) return;
    const now = this.now();
    if (s.waitReturn) {
      if (now < s.dueAt) return this.schedule(moveId, role, s.dueAt);
      if (this.returnOpen(moveId)) return this.schedule(moveId, role, now + this.t('returnPollMs', SYNC_RETURN_POLL_MS));
      s = { ...s, dueAt: now };
      delete s.waitReturn;
    }
    if (now < s.dueAt) return this.schedule(moveId, role, s.dueAt);
    s = { ...s, since: s.since ?? now, attempts: s.attempts + 1 };
    if (s.startedAt === undefined) {
      s.startedAt = now;
      this.audit(moveId, role, s, 'start');
    }
    const ready = this.d.ready(s.camera);
    if (ready === 'gone') return this.end(moveId, role, s, 'failed', 'camera_gone');
    if (ready === 'offline') return this.retry(moveId, role, s, 'camera_offline');
    s.state = 'running';
    this.save(moveId, role, s);
    try {
      await this.job(moveId, role, s);
    } catch (err) {
      if (err instanceof Stopped) {
        this.save(moveId, role, { ...s, state: 'pending' });
        return;
      }
      if (err instanceof Cancelled) return this.end(moveId, role, s, 'failed', 'cancelled');
      return this.retry(moveId, role, s, err instanceof Retry ? err.message : errorMessage(err));
    }
    this.end(moveId, role, s, 'done');
  }

  // A copy back of this cancelled move running here (its target record).
  private returnOpen(moveId: string): boolean {
    try {
      return this.d.journal.all().some((r) => r.role === 'target' && r.returnOf === moveId && !moveEnded(r.phase));
    } catch {
      return false;
    }
  }

  // The work; `s` is updated (and saved) as it goes, so a retry goes on from its step.
  private async job(moveId: string, role: MoveRole, s: MoveSyncRecord): Promise<void> {
    const cam = s.camera;
    const save = () => this.save(moveId, role, s);
    if ((s.step ?? 'clips') === 'clips') {
      for (;;) {
        const check = await this.run(() => this.d.runner.start('clips', WHO, { cam, camera: true }));
        const missing = count(check.counts.missingLocally);
        const c: MoveSyncClips = s.clips ? { ...s.clips, rounds: s.clips.rounds + 1, missingAfter: missing } : { missingBefore: missing, fetched: 0, missingAfter: missing, rounds: 1, stopped: null };
        s.clips = c;
        save();
        if (missing === 0 || c.stopped) break;
        if (c.rounds >= SYNC_MAX_ROUNDS) {
          c.stopped = 'round-cap';
          break;
        }
        const rep = await this.run(() => this.d.runner.repair('clips', WHO, check.runId));
        const done = count(rep.counts.done);
        c.fetched += done;
        save();
        if (rep.stopped === 'camera_offline') throw new Retry('camera_offline');
        // A stop (not a run's cap) or nothing fetched: one more check says what is left.
        if (rep.stopped && !CAPS.has(rep.stopped)) c.stopped = rep.stopped;
        else if (done === 0) c.stopped = 'nothing-fetched';
      }
      s.step = 'events';
      save();
    }
    const ev = await this.run(() => this.d.runner.start('events', WHO, { cam }));
    const missing = count(ev.counts.missingEvents);
    let added = 0;
    if (missing > 0) {
      const rep = await this.run(() => this.d.runner.repair('events', WHO, ev.runId));
      added = count(rep.counts.done);
    }
    s.events = { missing, added };
    save();
  }

  // Starts a run (waiting while another inventory runs) and answers its report when it ended ok.
  private async run(start: () => { runId: string; done: Promise<InventoryReport> } | Promise<{ runId: string; done: Promise<InventoryReport> }>): Promise<InventoryReport> {
    for (;;) {
      if (this.stopped) throw new Stopped();
      let started: { runId: string; done: Promise<InventoryReport> };
      try {
        started = await start();
      } catch (err) {
        if (err instanceof InventoryBusyError) {
          await this.sleep(this.t('busyMs', SYNC_BUSY_MS));
          continue;
        }
        if (err instanceof InventoryStoppingError) throw new Stopped();
        throw new Retry(errorMessage(err));
      }
      const r = await started.done;
      if (r.outcome === 'ok') return r;
      if (r.outcome === 'cancelled') throw r.cancelledBy === 'stop' ? new Stopped() : new Cancelled();
      throw new Retry(r.error ?? 'failed');
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.d.sleep) return this.d.sleep(ms);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.waits.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      t.unref();
      this.waits.add(done);
    });
  }

  private retry(moveId: string, role: MoveRole, s: MoveSyncRecord, reason: string): void {
    const now = this.now();
    if (now - (s.since ?? now) >= this.t('giveUpMs', SYNC_GIVE_UP_MS)) return this.end(moveId, role, s, 'gave-up', reason);
    const delay = Math.min(this.t('retryMs', SYNC_RETRY_MS) * 2 ** Math.min(s.attempts - 1, 20), this.t('retryCapMs', SYNC_RETRY_CAP_MS));
    const next: MoveSyncRecord = { ...s, state: 'pending', dueAt: now + delay, error: reason.slice(0, 200) };
    this.save(moveId, role, next);
    logger.info({ moveId, role, camera: s.camera, attempts: s.attempts, reason, retryInMs: delay }, 'move_sync_retry');
    this.schedule(moveId, role, next.dueAt);
  }

  private end(moveId: string, role: MoveRole, s: MoveSyncRecord, state: 'done' | 'failed' | 'gave-up', error?: string): void {
    const fin: MoveSyncRecord = { ...s, state, finishedAt: this.now() };
    delete fin.waitReturn;
    if (error) fin.error = error.slice(0, 200);
    else delete fin.error;
    this.save(moveId, role, fin);
    this.audit(moveId, role, fin, state === 'gave-up' ? 'give-up' : 'end');
    logger.info({ moveId, role, camera: s.camera, state, attempts: s.attempts }, 'move_sync_end');
  }

  private audit(moveId: string, role: MoveRole, s: MoveSyncRecord, step: 'start' | 'end' | 'give-up'): void {
    const why = s.trigger === 'finished' ? 'after its move to this proxy' : 'back on this proxy after a cancelled move';
    const head = `Camera move ${moveId}: ${s.camera} ${why}`;
    const base = { moveId, camera: s.camera, role, trigger: s.trigger, proxy: this.d.proxyId?.() || null, step };
    if (step === 'start') {
      this.d.audit.write({
        action: 'move-sync', category: ['configuration'], type: ['start'], outcome: 'success', user: 'system', camera: s.camera,
        message: `${head}: checking its clips and events against the camera's SD card and fetching what is missing`,
        details: base,
      });
      return;
    }
    const durationS = Math.max(0, Math.round(((s.finishedAt ?? this.now()) - (s.startedAt ?? s.requestedAt)) / 1000));
    if (step === 'give-up') {
      this.d.audit.write({
        action: 'move-sync', category: ['configuration'], type: ['end'], outcome: 'failure', user: 'system', camera: s.camera,
        message: `${head}: the check against the camera's SD card gave up after ${s.attempts} attempts in 24 hours (${s.error})${s.clips ? `; ${clipsText(s.clips)}` : ''}`,
        error: s.error,
        details: { ...base, state: s.state, reason: s.error, attempts: s.attempts, clips: s.clips ?? null, events: s.events ?? null, durationS },
      });
      return;
    }
    const ok = s.state === 'done';
    this.d.audit.write({
      action: 'move-sync', category: ['configuration'], type: ['end'], outcome: ok ? 'success' : 'failure', user: 'system', camera: s.camera,
      message: ok
        ? `${head}: checked against the camera's SD card: ${s.clips ? clipsText(s.clips) : 'no clips check'}; events: ${s.events ? `${s.events.missing} missing, ${s.events.added} added` : 'not checked'}`
        : `${head}: the check against the camera's SD card ended: ${s.error === 'camera_gone' ? 'the camera no longer runs here' : s.error === 'cancelled' ? 'one of its inventory runs was cancelled' : s.error}`,
      ...(ok ? {} : { error: s.error }),
      details: { ...base, state: s.state, attempts: s.attempts, clips: s.clips ?? null, events: s.events ?? null, stopped: s.clips?.stopped ?? null, ...(s.error ? { error: s.error } : {}), durationS },
    });
  }
}

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

function clipsText(c: MoveSyncClips): string {
  return `clips: ${c.missingBefore} missing, ${c.fetched} fetched, ${c.missingAfter} still missing after ${c.rounds} check${c.rounds === 1 ? '' : 's'}${c.stopped ? ` (stopped: ${c.stopped})` : ''}`;
}
