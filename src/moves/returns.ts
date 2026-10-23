import type { AuditLog } from '../audit/audit-log';
import type { MoveFinishArgs, MoveReturnOpenArgs, MoveReturnStartArgs } from '../fleet/command-args';
import type { Done, Handler } from '../fleet/commands';
import { capturedFilter } from './captured';
import { listChunks, type InventoryDeps } from './inventory';
import { moveEnded, type ChunkMeta, type MoveJournal, type MoveRecord } from './journal';
import { MOVE_KINDS, type MoveEvent } from './types';

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
export interface ReturnDeps {
  journal: Pick<MoveJournal, 'load' | 'save'>;
  audit: Pick<AuditLog, 'write'>;
  emit: (e: MoveEvent) => void;
  inventory: InventoryDeps;
  // This proxy's id at cams-admin (audit details).
  proxyId?: () => string;
  now?: () => number;
}

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
  // Unknown cancelled move: unknown_move; not (yet) waiting for its copy back,
  // or without a high water: wrong_phase. Again with the same token hash: the
  // same answer, nothing changes. With a new one (cams-admin restarted and
  // lost the plaintext, ruling 20): the record takes it, the old token stops
  // working; the manifest stays as listed (the original copies the same chunks).
  open(a: MoveReturnOpenArgs): Done {
    const cancelled = this.d.journal.load(a.returnOf);
    if (!cancelled) return failed('unknown_move');
    if (cancelled.role !== 'target' || cancelled.phase !== 'cancelled' || cancelled.returnPending !== true || !cancelled.captured) return failed('wrong_phase');
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

  // The return's target side on the original proxy: Task 10.
  start(_a: MoveReturnStartArgs): Done {
    return failed('internal');
  }

  // The return's end on either side (move.finish {return: true}): Task 11.
  async finish(_a: MoveFinishArgs): Promise<Done> {
    return failed('internal');
  }

  // Return target copiers after a restart: Task 10.
  resume(): void {}

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
