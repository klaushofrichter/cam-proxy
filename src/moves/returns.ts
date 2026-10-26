import { lstatSync } from 'fs';
import { join } from 'path';
import type { AuditLog } from '../audit/audit-log';
import type { MoveFinishArgs, MoveReturnOpenArgs, MoveReturnStartArgs } from '../fleet/command-args';
import type { Done, Handler } from '../fleet/commands';
import type { Config } from '../config/defaults';
import type { Storage } from '../storage';
import { cancelMinuteFiles, capturedFilter } from './captured';
import { removeChunkParts } from './chunk-parts';
import { removeMoveParts, type CopyRunner } from './copier';
import { failed, ok, zeros } from './done';
import { listChunks, type InventoryDeps } from './inventory';
import { moveEnded, type ChunkMeta, type MoveJournal, type MoveRecord, type MoveTombstone } from './journal';
import { removeImported, removeLanded, removeReturned, type Purged } from './purge';
import { keepDaysOf } from './retention';
import { MOVE_KINDS, type MoveEvent, type MovePhaseName, type MovePlan } from './types';

// The copy back after a cancel after the switch-over (step 4, spec §1,
// rulings 1, 2, 7, 20): a return move linked to the cancelled one
// (`returnOf`), roles swapped. On the new proxy (the cancelled move's target)
// move.return.open makes a fresh source record for the return, so the move
// endpoints (/api/moves/:id/..., token-guard.ts: a source record not ended)
// serve it with its own token bound to the original proxy's address. Its
// manifest lists only what this proxy captured itself for the camera
// (captured.ts capturedFilter: not imported by the move, not above the cancel's
// high water); its chunks and rows are filtered the same way per request
// (moves-api.ts). The original proxy's side (move.return.start, Task 10) and
// the finish with its selective delete (Task 11) live here too.
//
// On the original proxy (Task 10) move.return.start makes the return's target
// record: copy only (RETURN_PLAN; no camera node, key pair, leaf, secrets or
// FTP step: the camera is already back here), the camera named by the
// cancelled move's tombstone, and starts the copier (CopyRunner). A chunk that
// doesn't fit waits (copier.ts waitRoom, Decision 5).
//
// The finish (Task 11, move.finish {return: true}). The original's copier
// reports what it could not verify to the new proxy like any target
// (PUT /api/moves/:id/outcome, accepted for the return's source record). For
// a return that report is the proof of verification: without one nothing of
// the capture is deleted, with one what it doesn't keep is deleted, but only
// in chunks whose listing the original fetched (record.served; review M1).
// The new proxy then deletes what the original verified (purge.ts
// removeReturned) and
// what the move had imported (removeImported); Give up (abandoned) deletes
// nothing on either side. Both records close, so neither proxy is busy any more.
export interface ReturnDeps {
  journal: Pick<MoveJournal, 'load' | 'save'> & Partial<Pick<MoveJournal, 'ended' | 'all' | 'bury' | 'remove'>>;
  audit: Pick<AuditLog, 'write'>;
  emit: (e: MoveEvent) => void;
  inventory: InventoryDeps;
  // This proxy's id at cams-admin (audit details).
  proxyId?: () => string;
  now?: () => number;
  // The original's side (Task 10): the copier, and the target's phase change (MoveTarget.setPhase).
  copy?: Pick<CopyRunner, 'start' | 'stop'>;
  setPhase?: (r: MoveRecord, phase: MovePhaseName, o?: { keepDays?: number }) => void;
  // The finish (Task 11): storage recounted after the new proxy's delete; the
  // retention in effect for keepDays on finished (left out: none).
  storage?: Pick<Storage, 'recount'>;
  retention?: () => Pick<Config['retention'], 'stillsDays' | 'previewsDays' | 'clipsDays' | 'eventsDays'>;
}

// A return's plan (ruling 8): everything, all space; nothing to estimate or
// approve. A return is not paced and has no budget (fix round 1): its budgetS
// is unused (no move-budget-exceeded), only pressure halves its rate.
export const RETURN_PLAN: MovePlan = { transfer: true, kinds: [...MOVE_KINDS], space: 'all', targetSettings: null, budgetS: 3600, estimateS: 0 };

const totals = (m: ChunkMeta[]) => ({ chunks: m.length, bytes: m.reduce((n, c) => n + c.bytes, 0) });
// The cancel minute's still files (captured.ts cancelMinuteFiles): never
// copied back, they stay here; counted kept so the finish names them.
const cancelMinute = (dataDir: string, c: MoveRecord): Purged => {
  const t = zeros();
  for (const rel of cancelMinuteFiles(dataDir, c)) {
    try {
      const st = lstatSync(join(dataDir, ...rel.split('/')));
      if (!st.isFile()) continue;
      t.stills.files++;
      t.stills.bytes += st.size;
    } catch {
      /* gone meanwhile */
    }
  }
  return t;
};
const add = (x: Purged, y: Purged): Purged => Object.fromEntries(MOVE_KINDS.map((k) => [k, { files: x[k].files + y[k].files, bytes: x[k].bytes + y[k].bytes }])) as Purged;

export class MoveReturns {
  constructor(private readonly d: ReturnDeps) {}

  handlers(): Record<string, Handler> {
    const guard = (fn: (a: never) => Done | Promise<Done>): Handler => async (args) => {
      try {
        return await fn(args as never);
      } catch {
        return failed('internal');
      }
    };
    return {
      'move.return.open': guard((a: MoveReturnOpenArgs) => this.open(a)),
      'move.return.start': guard((a: MoveReturnStartArgs) => this.start(a)),
    };
  }

  // move.return.open (new proxy): the return's source record, from the
  // cancelled move's kept target record (returnPending, with its high water).
  // Unknown cancelled move: unknown_move; not (yet) waiting for its copy back
  // (its cancel not closed), or without a high water, or another return of it
  // open under another id: wrong_phase. Again with the same token hash: the
  // same answer, nothing changes. With a new one (cams-admin restarted and
  // lost the plaintext, ruling 20): the record takes it, the old token stops
  // working; the manifest stays as listed (the original copies the same chunks).
  open(a: MoveReturnOpenArgs): Done {
    const cancelled = this.d.journal.load(a.returnOf);
    if (!cancelled) return failed('unknown_move');
    if (cancelled.role !== 'target' || cancelled.phase !== 'cancelled' || cancelled.returnPending !== true || cancelled.cancelClosed !== true || !cancelled.captured) return failed('wrong_phase');
    const existing = this.d.journal.load(a.moveId);
    if (existing) {
      if (existing.role !== 'source' || existing.returnOf !== a.returnOf || existing.camera !== cancelled.camera || moveEnded(existing.phase) || !existing.manifest) return failed('wrong_phase');
      const rekeyed = existing.tokenHash !== a.tokenHash || existing.peer.ip !== a.targetIp;
      if (rekeyed) {
        existing.tokenHash = a.tokenHash;
        existing.peer = { ...existing.peer, ip: a.targetIp };
        this.d.journal.save(existing);
      }
      return this.opened(existing, cancelled, rekeyed);
    }
    // One return per cancelled move: another open one under another id is refused.
    if ((this.d.journal.all?.() ?? []).some((x) => x.id !== a.moveId && x.role === 'source' && x.returnOf === a.returnOf && !moveEnded(x.phase))) return failed('wrong_phase');
    const manifest = listChunks(this.d.inventory, cancelled.camera, [...MOVE_KINDS], capturedFilter(this.d.inventory.dataDir, cancelled));
    const now = this.now();
    const r: MoveRecord = {
      v: 1, id: a.moveId, role: 'source', returnOf: a.returnOf, camera: cancelled.camera, phase: 'released', plan: null,
      peer: { proxyId: cancelled.peer.proxyId, name: cancelled.peer.name, ip: a.targetIp },
      tokenHash: a.tokenHash, manifest, manifestRefreshedAt: now, chunks: {}, bytesDone: 0, startedAt: now,
    };
    this.d.journal.save(r);
    return this.opened(r, cancelled, false);
  }

  // move.return.start (original proxy): the return's target record, copying at
  // once. The camera is the one the cancelled move gave back here (its
  // tombstone; none: unknown_move; a cancel before the switch-over, or one
  // still giving the camera back: wrong_phase). Again for the same return
  // (cams-admin missed the answer, or re-sends it after a failure or after its
  // restart with a new token, ruling 20): copying with the same token and
  // source, the copier only made sure of; a new token or source, or a failed
  // return: the copier stops and starts again with the record's chunk states
  // and the given `done`. A return already copied (or ended): ok, nothing changes.
  async start(a: MoveReturnStartArgs): Promise<Done> {
    const copy = this.d.copy;
    if (!copy) return failed('internal');
    if (a.moveId === a.returnOf) return failed('wrong_phase');
    const s = a.source;
    const peer = { proxyId: s.proxyId, name: s.name, url: s.url, caFingerprints: [...s.caFingerprints], tlsServername: s.tlsServername };
    const existing = this.d.journal.load(a.moveId);
    if (existing) {
      if (existing.role !== 'target' || existing.returnOf !== a.returnOf) return failed('wrong_phase');
      // Copied already: copied again with its check (cams-admin may have missed the event).
      if (existing.phase === 'copied') this.d.emit({ kind: 'move.phase', moveId: existing.id, role: 'target', phase: 'copied', ok: true, ...(existing.check ? { check: existing.check } : {}) });
      if (existing.phase !== 'copying' && existing.phase !== 'failed') return ok();
      const rekeyed = existing.token !== a.token || JSON.stringify(existing.peer) !== JSON.stringify(peer);
      if (existing.phase === 'copying' && !rekeyed) {
        copy.start(a.moveId);
        return ok();
      }
      // The copier holds the old token's client: stopped first, the record read again after it.
      await copy.stop(a.moveId);
      const r = this.d.journal.load(a.moveId);
      if (!r || r.role !== 'target' || (r.phase !== 'copying' && r.phase !== 'failed')) return ok();
      const was = r.phase;
      r.token = a.token;
      r.peer = peer;
      r.done = [...a.done];
      delete r.failure;
      if (was === 'failed') this.phase(r, 'copying');
      else this.d.journal.save(r);
      this.startAudit(r, was === 'failed' ? 'started again after a failure' : 'started again with a new move token');
      copy.start(a.moveId);
      return ok();
    }
    // This return ended here before (its tombstone): nothing starts again.
    const done = this.d.journal.ended?.(a.moveId, 'target') ?? null;
    if (done) return done.phase === 'finished' ? ok() : failed('wrong_phase');
    if (this.d.journal.load(a.returnOf)) return failed('wrong_phase');
    const stone = this.d.journal.ended?.(a.returnOf, 'source') ?? null;
    if (!stone) return failed('unknown_move');
    // A cancel before the switch-over (no camera named), or one copied back already (another return of it).
    if (stone.phase !== 'cancelled' || !stone.camera || stone.returned) return failed('wrong_phase');
    const now = this.now();
    const r: MoveRecord = {
      v: 1, id: a.moveId, role: 'target', returnOf: a.returnOf, camera: stone.camera, phase: 'copying',
      plan: { ...RETURN_PLAN, kinds: [...RETURN_PLAN.kinds] }, peer, token: a.token, done: [...a.done],
      chunks: {}, bytesDone: 0, startedAt: now, approvedAt: now, budgetS: RETURN_PLAN.budgetS,
    };
    this.phase(r, 'copying');
    this.startAudit(r, 'started');
    copy.start(a.moveId);
    return ok();
  }

  private phase(r: MoveRecord, phase: MovePhaseName, o: { keepDays?: number } = {}): void {
    if (this.d.setPhase) return this.d.setPhase(r, phase, o);
    r.phase = phase;
    this.d.journal.save(r);
    this.d.emit({ kind: 'move.phase', moveId: r.id, role: 'target', phase: phase as Exclude<MovePhaseName, 'failed'>, ok: true, ...o });
  }

  private startAudit(r: MoveRecord, what: string): void {
    const peer = r.peer.name || r.peer.proxyId;
    this.d.audit.write({
      action: 'move-return', category: ['configuration'], type: ['change'], outcome: 'success',
      user: 'cams-admin', camera: r.camera,
      message: `Camera move ${r.id} (copy back of ${r.returnOf}, ${r.camera} from ${peer}): ${what}, copy only`,
      details: { moveId: r.id, returnOf: r.returnOf, camera: r.camera, source: r.peer.proxyId, target: this.d.proxyId?.() || null, role: 'target', step: 'start', done: r.done?.length ?? 0 },
    });
  }

  // The return's end (move.finish {return: true}, Task 11; ruling 11), by the
  // role the args name. Again (cams-admin missed the answer): the first
  // answer from the tombstone, the end reported again. A return this proxy
  // knows nothing of: abandoned (Give up before it reached here) ok with
  // nothing deleted, else unknown_move.
  async finish(a: MoveFinishArgs): Promise<Done> {
    const stone = this.d.journal.ended?.(a.moveId, a.role) ?? null;
    if (stone) {
      if (stone.phase !== 'finished') return failed('wrong_phase');
      this.d.emit({ kind: 'move.phase', moveId: a.moveId, role: a.role, phase: 'finished', ok: true, ...this.keep() });
      return ok({ deleted: stone.deleted ?? zeros() });
    }
    const r = this.d.journal.load(a.moveId);
    if (!r) return a.abandoned ? ok({ deleted: zeros() }) : failed('unknown_move');
    if (r.role !== a.role || !r.returnOf) return failed('wrong_phase');
    return a.role === 'source' ? this.finishSource(r, a.abandoned) : this.finishTarget(r, a.abandoned);
  }

  // The new proxy (the return's source). Not abandoned: what the original
  // verified goes (purge.ts removeReturned: the return's items minus its keep
  // list, nothing of it without one), then what the move had imported
  // (removeImported). Abandoned (Give up, design decision 3): nothing is
  // deleted. Either way the cancelled record's import log (chunk parts) and
  // landed log go and both records end: the return `finished` (tombstone with
  // the counts), the cancelled move no longer waiting (returnPending gone,
  // its tombstone written again): the proxy is not busy any more.
  private finishSource(r: MoveRecord, abandoned: boolean): Done {
    const storage = this.d.storage;
    if (!storage) return failed('internal');
    const dataDir = this.d.inventory.dataDir;
    const cancelled = this.d.journal.load(r.returnOf!);
    const c = cancelled && cancelled.role === 'target' && cancelled.camera === r.camera ? cancelled : null;
    let deleted = zeros();
    let kept = zeros();
    if (!abandoned && c?.captured) {
      const purge = { catalog: this.d.inventory.catalog, dataDir, storage };
      // The filter reads the import log: built before anything of it goes.
      const back = removeReturned(purge, r, capturedFilter(dataDir, c));
      const imported = removeImported(purge, c);
      deleted = add(back.deleted, imported.deleted);
      kept = add(add(back.kept, imported.kept), cancelMinute(dataDir, c));
    }
    // The cancelled record closes first (review M2): a crash before the
    // return's tombstone can't leave it waiting (busy) for ever; a retry finds
    // the return's record still open and ends it.
    if (c) {
      removeLanded(dataDir, c.id);
      removeChunkParts(dataDir, c.id);
      this.d.journal.bury?.({ moveId: c.id, role: 'target', phase: 'cancelled' });
      this.d.journal.remove?.(c.id);
    }
    const now = this.now();
    r.phase = 'finished';
    r.endedAt ??= now;
    this.d.journal.save(r);
    this.d.emit({ kind: 'move.phase', moveId: r.id, role: 'source', phase: 'finished', ok: true, ...this.keep() });
    this.finishAudit(r, 'source', abandoned, deleted, kept);
    this.d.journal.bury?.({ moveId: r.id, role: 'source', phase: 'finished', deleted, kept });
    this.d.journal.remove?.(r.id);
    // The contract's answer is the counts deleted; what stayed is in the audit record and the tombstone.
    return ok({ deleted });
  }

  // The original proxy (the return's target): copied, or abandoned in any
  // phase (the copier stops first). Its temporary files, landed log and chunk
  // parts go; what it copied back stays (it is this proxy's camera). The
  // record ends `finished` with keepDays and is removed; the cancelled
  // move's tombstone is marked `returned` (no second return of it).
  private async finishTarget(r: MoveRecord, abandoned: boolean): Promise<Done> {
    if (!abandoned && r.phase !== 'copied') return failed('wrong_phase');
    await this.d.copy?.stop(r.id);
    const fresh = this.d.journal.load(r.id) ?? r;
    const dataDir = this.d.inventory.dataDir;
    removeMoveParts(dataDir, fresh.id, fresh.camera);
    delete fresh.token;
    fresh.endedAt ??= this.now();
    this.phase(fresh, 'finished', this.keep());
    this.finishAudit(fresh, 'target', abandoned, zeros(), zeros());
    removeLanded(dataDir, fresh.id);
    removeChunkParts(dataDir, fresh.id);
    this.d.journal.bury?.({ moveId: fresh.id, role: 'target', phase: 'finished', deleted: zeros() });
    const stone: MoveTombstone | null = this.d.journal.ended?.(fresh.returnOf!, 'source') ?? null;
    if (stone && stone.phase === 'cancelled') this.d.journal.bury?.({ moveId: stone.moveId, role: 'source', phase: 'cancelled', ...(stone.camera ? { camera: stone.camera } : {}), returned: true });
    this.d.journal.remove?.(fresh.id);
    return ok({ deleted: zeros() });
  }

  private finishAudit(r: MoveRecord, role: 'source' | 'target', abandoned: boolean, deleted: Purged, kept: Purged): void {
    const peer = r.peer.name || r.peer.proxyId;
    const n = (p: Purged) => Object.values(p).reduce((x, k) => x + k.files, 0);
    const what = role === 'source'
      ? abandoned ? 'given up, nothing deleted here' : `done: ${n(deleted)} files deleted here (copied back or imported by the move), ${n(kept)} kept`
      : abandoned ? 'given up, what was copied back stays' : 'done, copied back';
    this.d.audit.write({
      action: 'move-return', category: ['configuration'], type: ['change'], outcome: 'success',
      user: 'cams-admin', camera: r.camera,
      message: `Camera move ${r.id} (copy back of ${r.returnOf}, ${r.camera} ${role === 'source' ? 'to' : 'from'} ${peer}): ${what}`,
      details: {
        moveId: r.id, returnOf: r.returnOf, camera: r.camera, role, step: 'finish', abandoned,
        source: role === 'source' ? this.d.proxyId?.() || null : r.peer.proxyId, target: role === 'source' ? r.peer.proxyId : this.d.proxyId?.() || null,
        deleted, kept,
      },
    });
  }

  private keep(): { keepDays?: number } {
    const r = this.d.retention?.();
    return r ? { keepDays: keepDaysOf(r) } : {};
  }

  // At process start: the copier of every return target here still copying
  // (MoveTarget.resume leaves them out: no switch-over to run).
  resume(): void {
    const copy = this.d.copy;
    if (!copy) return;
    let open: MoveRecord[];
    try {
      open = this.d.journal.all?.() ?? [];
    } catch {
      return;
    }
    for (const r of open) if (r.role === 'target' && r.returnOf && r.phase === 'copying') copy.start(r.id);
  }

  private opened(r: MoveRecord, cancelled: MoveRecord, rekeyed: boolean): Done {
    const t = totals(r.manifest ?? []);
    this.d.emit({ kind: 'move.phase', moveId: r.id, role: 'source', phase: 'released', ok: true });
    const peer = r.peer.name || r.peer.proxyId;
    this.d.audit.write({
      action: 'move-return', category: ['configuration'], type: ['change'], outcome: 'success',
      user: 'cams-admin', camera: r.camera,
      message: `Camera move ${r.id} (copy back of ${cancelled.id}, ${r.camera} to ${peer}): opened, ${t.chunks} chunks, ${t.bytes} bytes${rekeyed ? ', with a new move token' : ''}`,
      details: { moveId: r.id, returnOf: cancelled.id, camera: r.camera, source: this.d.proxyId?.() || null, target: r.peer.proxyId, role: 'source', step: 'open', ...t, rekeyed },
    });
    return ok(t);
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }
}
