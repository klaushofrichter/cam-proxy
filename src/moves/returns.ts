import type { AuditLog } from '../audit/audit-log';
import type { MoveFinishArgs, MoveReturnOpenArgs, MoveReturnStartArgs } from '../fleet/command-args';
import type { Done, Handler } from '../fleet/commands';
import { capturedFilter } from './captured';
import { listChunks, type InventoryDeps } from './inventory';
import { moveEnded, type ChunkMeta, type MoveJournal, type MoveRecord } from './journal';
import type { CopyRunner } from './copier';
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
export interface ReturnDeps {
  journal: Pick<MoveJournal, 'load' | 'save'> & Partial<Pick<MoveJournal, 'ended' | 'all'>>;
  audit: Pick<AuditLog, 'write'>;
  emit: (e: MoveEvent) => void;
  inventory: InventoryDeps;
  // This proxy's id at cams-admin (audit details).
  proxyId?: () => string;
  now?: () => number;
  // The original's side (Task 10): the copier, and the target's phase change (MoveTarget.setPhase).
  copy?: Pick<CopyRunner, 'start' | 'stop'>;
  setPhase?: (r: MoveRecord, phase: MovePhaseName) => void;
}

// A return's plan (ruling 8): everything, all space; the budget only paces the
// copy (no move-budget-exceeded for a return), nothing to estimate or approve.
export const RETURN_PLAN: MovePlan = { transfer: true, kinds: [...MOVE_KINDS], space: 'all', targetSettings: null, budgetS: 3600, estimateS: 0 };

const ok = (result: Record<string, unknown> = {}): Done => ({ status: 'ok', result });
const failed = (code: string): Done => ({ status: 'failed', code });
const totals = (m: ChunkMeta[]) => ({ chunks: m.length, bytes: m.reduce((n, c) => n + c.bytes, 0) });

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
    if (this.d.journal.load(a.returnOf)) return failed('wrong_phase');
    const stone = this.d.journal.ended?.(a.returnOf, 'source') ?? null;
    if (!stone) return failed('unknown_move');
    if (stone.phase !== 'cancelled' || !stone.camera) return failed('wrong_phase');
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

  private phase(r: MoveRecord, phase: MovePhaseName): void {
    if (this.d.setPhase) return this.d.setPhase(r, phase);
    r.phase = phase;
    this.d.journal.save(r);
    this.d.emit({ kind: 'move.phase', moveId: r.id, role: 'target', phase: phase as Exclude<MovePhaseName, 'failed'>, ok: true });
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

  // The return's end on either side (move.finish {return: true}): Task 11.
  async finish(_a: MoveFinishArgs): Promise<Done> {
    return failed('internal');
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
