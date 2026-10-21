import { readdirSync, renameSync, rmSync } from 'fs';
import { join } from 'path';
import { readPrivateJson, writePrivateJson } from '../fleet/private-file';
import type { ChunkState, MoveCameraConnection, MoveCopied, MoveKind, MovePhaseName, MovePlan, MoveRole, MoveSummary, Settings } from './types';

// The durable record of one move on this proxy: <dataDir>/admin/moves/<id>.json,
// mode 600 (it holds the move token hash or the plain token and the target's
// X25519 private key). Never printed, logged or served.
export interface ChunkMeta { id: string; kind: MoveKind; day: string; files: number; bytes: number; rows: number }
export interface ChunkFile { size: number; sha256?: string; state: string }
export interface ChunkRecord { state: ChunkState; files?: Record<string, ChunkFile> }

export interface MovePeer {
  proxyId: string;
  name: string;
  url?: string;
  caFingerprints?: string[];
  tlsServername?: string;
  ip?: string;
}

export interface MoveRecord {
  v: 1;
  id: string;
  role: MoveRole;
  camera: string;
  phase: MovePhaseName;
  plan: MovePlan | null;
  peer: MovePeer;
  // source: the contract's `sha256:<hex>` (hashMoveToken); target: the plaintext token.
  tokenHash?: string;
  token?: string;
  // target only
  x25519?: { privatePkcs8: string; publicSpki: string };
  // target, stored at accept (Task 6), read at switch-over (Task 8)
  cameraConnection?: MoveCameraConnection;
  summary?: MoveSummary;
  settings?: Settings;
  expectedLeaf?: string;
  manifest?: ChunkMeta[];
  chunks: Record<string, ChunkRecord>;
  bytesDone: number;
  startedAt: number;
  approvedAt?: number;
  budgetS?: number;
  budgetExceeded?: boolean;
  copied?: MoveCopied;
}

const TERMINAL: readonly MovePhaseName[] = ['finished', 'cancelled', 'failed'];
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export class MoveJournal {
  private readonly bad: string[] = [];

  constructor(private readonly dir: string, private readonly onProblem?: (message: string) => void) {}

  private path(id: string): string {
    if (!ID.test(id)) throw new Error('invalid move id');
    return join(this.dir, `${id}.json`);
  }

  // Problems met so far (a corrupt file set aside); messages name files only.
  problems(): readonly string[] {
    return this.bad;
  }

  private problem(message: string): void {
    this.bad.push(message);
    this.onProblem?.(message);
  }

  load(id: string): MoveRecord | null {
    const path = this.path(id);
    let raw: unknown;
    try {
      raw = readPrivateJson(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return this.setAside(path, (err as Error).message);
    }
    const r = raw as Partial<MoveRecord> | null;
    if (!r || r.v !== 1 || r.id !== id || (r.role !== 'source' && r.role !== 'target') || typeof r.phase !== 'string' || !r.chunks || typeof r.chunks !== 'object') {
      return this.setAside(path, `${path} is not a move record`);
    }
    return r as MoveRecord;
  }

  private setAside(path: string, why: string): null {
    try {
      renameSync(path, `${path}.bad-${Date.now()}`);
    } catch {
      /* left where it is; still reported */
    }
    this.problem(`move journal: ${why}; set aside`);
    return null;
  }

  save(r: MoveRecord): void {
    writePrivateJson(this.path(r.id), r);
  }

  remove(id: string): void {
    rmSync(this.path(id), { force: true });
  }

  all(): MoveRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: MoveRecord[] = [];
    for (const n of names.sort()) {
      const m = /^(.+)\.json$/.exec(n);
      if (!m || !ID.test(m[1])) continue;
      const r = this.load(m[1]);
      if (r) out.push(r);
    }
    return out;
  }

  // Records whose phase is not final.
  active(): MoveRecord[] {
    return this.all().filter((r) => !TERMINAL.includes(r.phase));
  }

  // The phase of the open move (the newest by startedAt), for the welcome
  // re-emit (B2); null when none is open.
  currentPhase(): { moveId: string; role: MoveRole; phase: MovePhaseName } | null {
    const a = this.active().sort((x, y) => y.startedAt - x.startedAt)[0];
    return a ? { moveId: a.id, role: a.role, phase: a.phase } : null;
  }
}
