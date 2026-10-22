import { lstatSync, readdirSync, renameSync, rmSync } from 'fs';
import { join } from 'path';
import { PrivateFileInvalid, readPrivateJson, writePrivateJson } from '../fleet/private-file';
import type { ChunkState, MoveActor, MoveAnswer, MoveCameraConnection, MoveCopied, MoveKind, MovePhaseName, MovePlan, MoveRole, MoveSummary, Settings, Space } from './types';

// The durable record of one move on this proxy: <dataDir>/admin/moves/<id>.json,
// mode 600 (it holds the move token hash or the plain token and the target's
// X25519 private key). Never printed, logged or served.
export type SwitchStep = 'secrets' | 'camera' | 'cert' | 'ftp';
export const SWITCH_STEPS: readonly SwitchStep[] = ['secrets', 'camera', 'cert', 'ftp'];
export interface ChunkMeta { id: string; kind: MoveKind; day: string; files: number; bytes: number; rows: number }
// A chunk on the target (Task 9), kept small: no per-file list for stills
// (a day has 1440+ files; a resumed chunk checks its files on disk instead).
export interface ChunkRecord {
  state: ChunkState;
  // Once the chunk ended: files verified, skipped (expired at the source, or a
  // file of that name the target stored itself), failed; bytes verified; bytes handled.
  v?: number;
  s?: number;
  f?: number;
  vb?: number;
  b?: number;
  // Rows imported and skipped (duplicates, files not verified or expired).
  rowsInserted?: number;
  rowsSkipped?: number;
  // The chunk as the source listed it when copied (P12: copied again when it changes).
  // Its verified id-named files and import map: chunk-parts.ts (final review 6).
  meta?: { files: number; bytes: number; rows: number };
}

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
  // source: the target's X25519 public key (SPKI DER, base64) stored by move.go;
  // the camera password is sealed to it (GET /api/moves/:id/secrets).
  targetPublicSpki?: string;
  // source (Task 7): the request it came from, who asked, and the target's answer.
  requestId?: string;
  actor?: MoveActor;
  answer?: MoveAnswer;
  // source: when the chunks from the approval day on were listed again (at released, P12).
  manifestRefreshedAt?: number;
  // target only
  x25519?: { privatePkcs8: string; publicSpki: string };
  // target (Task 8): the leaf move.start issued for the camera (pushed by the
  // cert step); its key never leaves this record but in the push.
  leaf?: { certPem: string; keyPem: string; fingerprint: string };
  // target: the switch-over step running or next (secrets, camera, cert, ftp).
  step?: SwitchStep;
  // target: the chunks cams-admin reported done at move.start (B34), at most 512.
  done?: string[];
  // the code a failed move ended with (move.phase failed).
  failure?: string;
  // target: its own space answer at accept (Task 6); move.start's targetSettings must stay within its proposal.
  space?: Space | null;
  // target: the camera step wrote the camera node (a resumed step is not id_taken by its own write).
  cameraWritten?: boolean;
  // target: the secrets step stored the camera's password (a cancel deletes only that one).
  passwordWritten?: boolean;
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
  // target: the rate the offer's probe measured (0: none), when copying began, the last rate before halving.
  probeBps?: number;
  copyStartedAt?: number;
  lastRateBps?: number;
  copied?: MoveCopied;
  // Task 10: the phase a cancel came in (kept while the cancel's steps run
  // again after a failed one), and whether the camera had been switched over.
  cancelledFrom?: MovePhaseName;
  switchedOver?: boolean;
  // source: a cancel after the switch-over whose give-back steps (push, FTP)
  // have not all succeeded yet: the move still counts as open (busy).
  cancelPending?: boolean;
  endedAt?: number;
}

const TERMINAL: readonly MovePhaseName[] = ['finished', 'cancelled', 'failed'];
export const moveEnded = (phase: MovePhaseName): boolean => TERMINAL.includes(phase);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isMoveId = (id: string): boolean => ID.test(id);

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
      // Only a file that is not valid JSON is corrupt; an unsafe owner, EACCES,
      // EIO, EMFILE ... may pass: the file stays and the error is rethrown.
      if (err instanceof PrivateFileInvalid) return this.setAside(path, err.message);
      throw err;
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

  // Compact JSON: the copier saves the record up to once a second.
  save(r: MoveRecord): void {
    writePrivateJson(this.path(r.id), r, false);
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
    // Records only: <id>.json files; the <id>.manifests/ folders (the source's
    // cached chunk manifests) and anything else are not records.
    for (const n of names.sort()) {
      const m = /^(.+)\.json$/.exec(n);
      if (!m || !ID.test(m[1])) continue;
      try {
        if (!lstatSync(join(this.dir, n)).isFile()) continue;
      } catch {
        continue;
      }
      const r = this.load(m[1]);
      if (r) out.push(r);
    }
    return out;
  }

  // Records whose phase is not final, and a source cancel still giving the camera back.
  active(): MoveRecord[] {
    return this.all().filter((r) => !TERMINAL.includes(r.phase) || r.cancelPending === true);
  }

  // The phase of the open move (the newest by startedAt), for the welcome
  // re-emit (B2); null when none is open.
  currentPhase(): { moveId: string; role: MoveRole; phase: MovePhaseName } | null {
    const a = this.active().filter((r) => !moveEnded(r.phase)).sort((x, y) => y.startedAt - x.startedAt)[0];
    return a ? { moveId: a.id, role: a.role, phase: a.phase } : null;
  }
}
