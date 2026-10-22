import { createHash, generateKeyPairSync } from 'crypto';
import type { AuditLog } from '../audit/audit-log';
import { bareHost, splitHost } from '../camera/http';
import { activeCameraIds } from '../config/cameras';
import type { CameraPasswordStore } from '../config/camera-passwords';
import { cameraDefaults } from '../config/defaults';
import { applyOverrides, getPath, planOverrides, rebuildWith, removeOverride, writeOverridesFile, setPath, type Loaded } from '../config/load';
import { cameraPasswordEnv } from '../config/password-env';
import type { MoveCancelArgs, MoveFinishArgs, MoveOfferArgs, MoveStartArgs } from '../fleet/command-args';
import type { Done, Handler } from '../fleet/commands';
import type { SiteCa } from '../tls/ca';
import { issueLeaf, leafOf, type Leaf } from '../tls/leaf';
import type { PushResult } from '../tls/push';
import { removeChunkParts } from './chunk-parts';
import { removeMoveParts } from './copier';
import { sourceGet } from './evaluate';
import { moveEnded, SWITCH_STEPS, type MoveJournal, type MoveRecord, type MoveTombstone, type SwitchStep } from './journal';
import { OFFER_EXPIRY_MS } from './source';
import { removeLanded, type Purged } from './purge';
import { unseal } from './seal';
import { logger } from '../log';
import { MOVE_KINDS, type MoveCopied, type MoveEvent, type MovePhaseName, type MovePlan, type Space } from './types';

// The target side of a camera move from move.start on (camera-move plan Task 8,
// S §9.1, §9.3, §10.1, P1, P12): move.start makes the move's X25519 pair and
// the camera's leaf (both kept in the journal, mode 600); the runner then
// takes the camera over step by step: `secrets` (the sealed password from the
// source, opened, stored) → `camera` (the camera node in overrides.json, live)
// → `cert` (the leaf pushed) → `ftp` (the camera's upload pointed here) →
// `switched` → `copying` at once (the copier, Task 9). Each step can run
// again; the journal names the step running, so a restart repeats it from its
// start. Never a password, a token or a private key in a log line, an event or
// an audit record.

export interface TargetDeps {
  journal: Pick<MoveJournal, 'load' | 'save' | 'active'> & Partial<Pick<MoveJournal, 'remove' | 'all' | 'bury' | 'ended'>>;
  audit: Pick<AuditLog, 'write'>;
  emit: (e: MoveEvent) => void;
  ca: () => SiteCa | null;
  site: () => string | undefined;
  loaded: () => Loaded;
  // The written configuration in effect (setLoaded), resolved once an added camera's worker runs.
  setLoaded: (l: Loaded) => Promise<void>;
  passwords: Pick<CameraPasswordStore, 'set'>;
  // The camera certificates (P8 code): the move's leaf staged for the camera, and pushed.
  stageLeaf: (cam: string, leaf: Leaf | null) => void;
  pushLeaf: (cam: string, leaf: Leaf) => Promise<PushResult>;
  // The camera's FTP pointed at this proxy and read back (verifyFtp); 'skipped' when FTP is off for it.
  ftp: (cam: string) => Promise<'skipped' | { verified: boolean; mismatch: string[] }>;
  // The copier (Task 9's CopyRunner) starts here, after switched (P12); one per
  // move however often it is called. stopCopy ends it (stop(), stopAll()).
  startCopy?: (moveId: string) => void;
  stopCopy?: (moveId: string) => Promise<void>;
  // This proxy's id at cams-admin (audit records name source and target).
  proxyId?: () => string;
  // A camera event is open: the certificate push waits for its end (it never pushes during one).
  eventOpen?: (cam: string) => boolean;
  // GET /api/moves/<id>/secrets at the source (overridable for tests).
  fetchSecrets?: (source: MoveOfferArgs['source'], moveId: string, token: string) => Promise<{ status: number; sealed?: string }>;
  // Retries: each step `attempts` times with a backoff from retryMs up to
  // retryCapMs; the source's 409 not_ready (move.go not there yet) is waited
  // for up to notReadyMs without using up attempts, an open camera event at
  // the cert step up to eventWaitMs.
  timing?: { attempts?: number; retryMs?: number; retryCapMs?: number; notReadyMs?: number; eventWaitMs?: number };
  // Task 10, the end of a move (move.finish, move.cancel): the data folder (the
  // copier's temporary files), what the move imported removed (a cancel with
  // copied delete; never the target's own capture), the camera's stored
  // password deleted, its leaf files and trust state forgotten
  // (CameraCerts.forget). Without them both answer internal.
  end?: {
    dataDir: string;
    removeImported: (r: MoveRecord) => { deleted: Purged };
    deletePassword: (cam: string) => void;
    forgetLeaf: (cam: string) => void;
  };
  now?: () => number;
}

const ATTEMPTS = 5;
const RETRY_MS = 2000;
const RETRY_CAP_MS = 30_000;
const NOT_READY_MS = 30 * 60_000; // an offer not approved in 30 minutes expires (S §7)
const EVENT_WAIT_MS = 10 * 60_000; // a camera event longer than this: the cert step gives up
// The host limits move.start may set (plan.space retention), each at most the target's own proposal.
const TARGET_SETTINGS: readonly string[] = ['storage.maxBytes', 'ftp.maxGB', 'stills.maxGB', 'previews.maxGB'];
const DONE_MAX = 512;
const CODES: Record<SwitchStep, string> = { secrets: 'secrets_failed', camera: 'camera_failed', cert: 'cert_failed', ftp: 'ftp_failed' };

const ok = (result: Record<string, unknown> = {}): Done => ({ status: 'ok', result });
const failed = (code: string): Done => ({ status: 'failed', code });
const zeros = (): Purged => Object.fromEntries(MOVE_KINDS.map((k) => [k, { files: 0, bytes: 0 }])) as Purged;
// The camera taken over here: every switch-over step ran (a failure after
// them is the copier's), so the camera node here is the move's.
const switchedOver = (r: MoveRecord): boolean => r.cameraWritten === true && r.step === undefined && !!r.plan && r.phase !== 'opened' && r.phase !== 'switching';
const keyFingerprint = (spkiB64: string) => `SHA256:${createHash('sha256').update(Buffer.from(spkiB64, 'base64')).digest('hex').toUpperCase()}`;
// Two plans alike: kinds in any order, target settings in any key order (as the source compares them).
const canonical = (p: MovePlan): string => JSON.stringify([p.transfer, [...p.kinds].sort(), p.space, p.targetSettings ? Object.entries(p.targetSettings).sort(([x], [y]) => (x < y ? -1 : 1)) : null, p.budgetS, p.estimateS]);
const samePlan = (a: MovePlan | null, b: MovePlan) => a !== null && canonical(a) === canonical(b);

// A wait that does not use up a step's attempts: the source without the key yet, an open camera event.
class Wait extends Error {
  constructor(message: string, readonly kind: 'source' | 'event') {
    super(message);
  }
}
// A step that can't succeed by retrying (the move fails at once), with its
// detail; `code` when the failure is another step's (a camera refusal found
// early, in the secrets step, is camera_failed).
class Refused extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}
// The camera node's leaves whose absence means the host value: a leftover's
// own value is replaced by the host's when the move does not set it.
const HOST_LEAVES = ['ftp.enabled', 'ftp.stream', 'stills.enabled', 'stills.stream', 'stills.intervalS', 'analytics.kinds.person', 'analytics.kinds.vehicle', 'analytics.kinds.pet', 'events.poll.enabled'];
type CameraPlan = { problem: string } | { next: Loaded; overrides: object; leftover: boolean; host: Record<string, unknown> };

// Target settings within the target's own proposal (a forged plan never reaches overrides.json).
export function targetSettingsProblem(ts: MovePlan['targetSettings'], space: Space | null | undefined): string | null {
  if (!ts || !Object.keys(ts).length) return null;
  const proposal = space?.retentionProposal;
  if (!proposal) return 'plan.targetSettings';
  for (const [k, v] of Object.entries(ts)) {
    const want = proposal[k];
    if (!TARGET_SETTINGS.includes(k) || typeof want !== 'number' || typeof v !== 'number' || !Number.isFinite(v) || v > want) return 'plan.targetSettings';
  }
  return null;
}

interface Run {
  stopped: boolean;
  wake: (() => void) | null;
  done: Promise<void>;
}

export async function fetchSecrets(source: MoveOfferArgs['source'], moveId: string, token: string): Promise<{ status: number; sealed?: string }> {
  const r = await sourceGet(source, `/api/moves/${moveId}/secrets`, token);
  if (r.status !== 200) return { status: r.status };
  const body = JSON.parse(r.body.toString('utf8')) as { sealed?: unknown };
  return { status: 200, ...(typeof body.sealed === 'string' ? { sealed: body.sealed } : {}) };
}

export class MoveTarget {
  private readonly runs = new Map<string, Run>();
  private readonly starting = new Map<string, Promise<Done>>();
  // Moves whose copier was started here (stopAll stops them).
  private readonly copying = new Set<string>();

  constructor(private readonly d: TargetDeps) {}

  private self(): string | null {
    return this.d.proxyId?.() || null;
  }

  private target(id: string): MoveRecord | null {
    const r = this.d.journal.load(id);
    return r && r.role === 'target' ? r : null;
  }

  private details(r: MoveRecord, extra: Record<string, unknown>): Record<string, unknown> {
    return { moveId: r.id, camera: r.camera, source: r.peer.proxyId, target: this.self(), role: 'target', ...extra };
  }

  private switchAudit(r: MoveRecord, step: SwitchStep | 'start', outcome: 'ok' | 'failed' | 'skipped', message: string, extra: Record<string, unknown> = {}): void {
    this.d.audit.write({
      action: 'move-switch', category: ['configuration'], type: ['change'], outcome: outcome === 'failed' ? 'failure' : 'success',
      user: 'cams-admin', camera: r.camera,
      message: `Camera move ${r.id} (${r.camera} from ${r.peer.name || r.peer.proxyId}): ${message}`,
      details: this.details(r, { step, outcome, ...extra }),
    });
  }

  private phase(r: MoveRecord, phase: MovePhaseName, code?: string, detail?: string): void {
    this.setPhase(r, phase, { code, detail });
  }

  // A phase change of a target move: journal, move.phase event, move-phase
  // audit (`extra` goes into the audit details only: the copier's counts).
  setPhase(r: MoveRecord, phase: MovePhaseName, o: { code?: string; detail?: string; extra?: Record<string, unknown> } = {}): void {
    const { code, detail } = o;
    r.phase = phase;
    if (code) r.failure = code;
    this.d.journal.save(r);
    if (phase === 'failed') this.d.emit({ kind: 'move.phase', moveId: r.id, role: 'target', phase: 'failed', ok: false, code: code ?? 'internal', ...(detail ? { detail } : {}) });
    else this.d.emit({ kind: 'move.phase', moveId: r.id, role: 'target', phase, ok: true, ...(detail ? { detail: detail.slice(0, 200) } : {}) });
    this.d.audit.write({
      action: 'move-phase', category: ['configuration'], type: ['change'], outcome: phase === 'failed' ? 'failure' : 'success',
      user: 'cams-admin', camera: r.camera,
      message: `Camera move ${r.id} (${r.camera} from ${r.peer.name || r.peer.proxyId}): ${phase}${code ? ` (${code})` : ''}${detail && phase !== 'failed' ? `, ${detail}` : ''}`,
      details: this.details(r, { phase, ...(code ? { code } : {}), ...(detail ? { detail } : {}), ...(o.extra ?? {}) }),
    });
  }

  handlers(): Record<string, Handler> {
    return {
      'move.start': async (args) => {
        try {
          return await this.start(args as MoveStartArgs);
        } catch {
          return failed('internal');
        }
      },
    };
  }

  // move.start: the same answer for the same move every time (one key pair,
  // one leaf); the runner starts in the background.
  start(a: MoveStartArgs): Promise<Done> {
    const busy = this.starting.get(a.moveId);
    if (busy) return busy;
    const p = this.startOnce(a).finally(() => this.starting.delete(a.moveId));
    this.starting.set(a.moveId, p);
    return p;
  }

  private async startOnce(a: MoveStartArgs): Promise<Done> {
    const r = this.target(a.moveId);
    if (!r) return failed('unknown_move');
    if (r.x25519 && r.leaf) {
      if (!samePlan(r.plan, a.plan)) return failed('conflict');
      if (moveEnded(r.phase)) return failed('wrong_phase');
      this.d.stageLeaf(r.camera, leafOf(r.leaf.certPem, r.leaf.keyPem));
      this.run(r.id);
      return ok({ publicKey: r.x25519.publicSpki, leafFingerprint: r.leaf.fingerprint });
    }
    if (r.phase !== 'opened') return failed('wrong_phase');
    if (targetSettingsProblem(a.plan.targetSettings, r.space)) return failed('invalid_args');
    const ca = this.d.ca();
    const site = this.d.site();
    if (!ca || !site || !r.cameraConnection) return failed('no_site_ca');
    const name = `${r.camera}.${site}.internal`;
    const address = bareHost(splitHost(r.cameraConnection.host).hostname);
    let leaf: Leaf;
    try {
      leaf = await issueLeaf(ca, { cn: name, dns: [name], ips: [address] });
    } catch {
      return failed('ca_does_not_cover_camera');
    }
    // A cancel while the leaf was made (Task 8 minor): the record is gone or closed; nothing is kept.
    const fresh = this.target(a.moveId);
    if (!fresh || fresh.phase !== 'opened') return failed('wrong_phase');
    const pair = generateKeyPairSync('x25519');
    fresh.x25519 = {
      privatePkcs8: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      publicSpki: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    };
    fresh.leaf = { certPem: leaf.certPem, keyPem: leaf.keyPem, fingerprint: leaf.fingerprint };
    fresh.plan = a.plan;
    // The settings at approval win over those of the offer (bounded to the camera node by the args check).
    fresh.settings = a.settings;
    fresh.approvedAt = Date.now();
    fresh.budgetS = a.plan.budgetS;
    // B34: what cams-admin already knows as done; the newest are last.
    fresh.done = a.done.slice(-DONE_MAX);
    this.d.journal.save(fresh);
    this.d.stageLeaf(fresh.camera, leaf);
    this.switchAudit(fresh, 'start', 'ok', `switch-over accepted; leaf ${leaf.fingerprint} issued for ${name}`, { leafFingerprint: leaf.fingerprint, publicKeyFingerprint: keyFingerprint(fresh.x25519.publicSpki), plan: a.plan, done: fresh.done.length });
    this.run(fresh.id);
    return ok({ publicKey: fresh.x25519.publicSpki, leafFingerprint: leaf.fingerprint });
  }

  // move.finish {role: target} (A5/B45, S §11): the move is done here, or
  // cams-admin ended the transfer early (abandoned, S §10.4). The camera stays
  // (it is this proxy's now); the copier stops, its temporary files and the
  // staging folder go, the X25519 and leaf private keys leave the journal, the
  // record ends `finished` (journal, event) and is removed; audited move-done.
  // Before the switch-over it is refused. Again: the same answer, nothing more.
  async finish(a: MoveFinishArgs): Promise<Done> {
    const end = this.d.end;
    if (!end) return failed('internal');
    // Ended here before (its tombstone, kept 7 days): the terminal phase again, the first answer.
    const past = this.past(a.moveId);
    if (past) return past.phase === 'finished' ? ok({ deleted: past.deleted ?? zeros() }) : failed('wrong_phase');
    const r = this.target(a.moveId);
    if (!r) return ok({ deleted: zeros() });
    if (r.phase === 'cancelled') return failed('wrong_phase');
    if (r.phase === 'failed') {
      this.terminalEvent(r.id, 'failed', r.failure);
      return failed('wrong_phase');
    }
    if (r.phase !== 'finished' && (!switchedOver(r) || (r.phase !== 'copied' && !a.abandoned))) return failed('wrong_phase');
    await this.stop(r.id);
    removeMoveParts(end.dataDir, r.id, r.camera);
    const fresh = this.target(r.id) ?? r;
    this.d.stageLeaf(fresh.camera, null);
    this.dropKeys(fresh);
    fresh.endedAt ??= this.now();
    const totals = this.totals(fresh);
    // The end in the journal first (a restart in between does not resume it), then the event.
    this.setPhase(fresh, 'finished');
    this.d.audit.write({
      action: 'move-done', category: ['configuration'], type: ['change'], outcome: 'success',
      user: 'cams-admin', camera: fresh.camera,
      message: `Camera move ${fresh.id} (${fresh.camera} from ${fresh.peer.name || fresh.peer.proxyId}) done${a.abandoned ? ', the transfer ended early' : ''}: ${totals.files.verified} files copied, ${totals.files.skipped} skipped, ${totals.files.failed} failed, ${totals.chunks.abandoned} chunks abandoned`,
      details: this.details(fresh, { abandoned: a.abandoned, ...totals }),
    });
    if (this.d.end) {
      removeLanded(this.d.end.dataDir, fresh.id);
      removeChunkParts(this.d.end.dataDir, fresh.id);
    }
    this.d.journal.bury?.({ moveId: fresh.id, role: 'target', phase: 'finished', deleted: zeros() });
    this.d.journal.remove?.(fresh.id);
    this.copying.delete(fresh.id);
    return ok({ deleted: zeros() });
  }

  // move.cancel {role: target} (S §10.3, B36): the camera goes back to the
  // source. Not started yet (an offer that expired, a cancel before
  // move.start): the record only closes. Else the runner and the copier stop,
  // the end is journalled, then the camera's node written by the move leaves
  // the configuration (live; a config.json entry is hidden again), its stored
  // password and its leaf go, and with copied `delete` what the move imported
  // is removed (rows and files; the target's own capture since the
  // switch-over stays and ages out, as everything does with age-out). A camera of that id
  // this proxy had itself (the camera step refused it) is never touched. No
  // leaf of the source is expected here: the target lets go of the camera
  // before the source pushes its own leaf back (B36). Again: nothing more.
  async cancel(a: MoveCancelArgs): Promise<Done> {
    const end = this.d.end;
    if (!end) return failed('internal');
    const past = this.past(a.moveId);
    if (past) return past.phase === 'cancelled' ? ok() : failed('wrong_phase');
    const r = this.target(a.moveId);
    if (!r) return ok();
    if (r.phase === 'finished') return failed('wrong_phase');
    const copied: MoveCopied = r.copied ?? a.copied ?? 'age-out';
    // Synchronous up to here: a move.start making its leaf finds the record gone and keeps nothing.
    if (r.phase === 'opened' && !r.plan) {
      this.closeCancelled(r, copied, 'untouched', null);
      return ok();
    }
    await this.stop(r.id);
    let fresh = this.target(r.id) ?? r;
    if (fresh.phase !== 'cancelled') {
      fresh.cancelledFrom = fresh.phase;
      fresh.switchedOver = switchedOver(fresh);
      fresh.copied = copied;
      fresh.phase = 'cancelled';
      fresh.endedAt = this.now();
      this.d.journal.save(fresh);
    }
    this.d.stageLeaf(fresh.camera, null);
    removeMoveParts(end.dataDir, fresh.id, fresh.camera);
    const cam = fresh.camera;
    let entry: 'removed' | 'hidden' | 'untouched' = 'untouched';
    let deleted: Purged | null = null;
    if (fresh.cameraWritten) {
      const l = this.d.loaded();
      const node = l.config.cameras[cam];
      if (node && node.moved === undefined) {
        // The camera stops here at once (live, P1): its worker, streams and FTP user go.
        await this.d.setLoaded(l.addedCameras.includes(cam) ? removeOverride(l, `cameras.${cam}`) : applyOverrides(l, { cameras: { [cam]: { moved: fresh.id } } }));
      }
      entry = this.d.loaded().config.cameras[cam] ? 'hidden' : 'removed';
      end.forgetLeaf(cam);
      if (fresh.passwordWritten) end.deletePassword(cam);
      if (copied === 'delete') {
        // Only what the move brought; the camera no longer runs here. The
        // target's own capture since the switch-over stays and ages out.
        if (activeCameraIds(this.d.loaded().config).includes(cam)) return failed('camera_active');
        deleted = end.removeImported(this.target(fresh.id) ?? fresh).deleted;
      }
    } else if (fresh.passwordWritten) {
      // The secrets step stored the password of a camera that never came here
      // (only one it stored: a camera of this id here keeps its own, final review 7).
      end.deletePassword(cam);
    }
    fresh = this.target(fresh.id) ?? fresh;
    this.closeCancelled(fresh, copied, entry, deleted);
    return ok();
  }

  // A cancelled move's end: no private key left in the record, the phase
  // journalled and reported (event, move-phase), move-cancel audited, the record removed.
  private closeCancelled(r: MoveRecord, copied: MoveCopied, entry: 'removed' | 'hidden' | 'untouched', deleted: Purged | null, reason?: 'offer_expired'): void {
    const from = r.cancelledFrom ?? r.phase;
    this.dropKeys(r);
    r.endedAt ??= this.now();
    this.setPhase(r, 'cancelled');
    this.d.audit.write({
      action: 'move-cancel', category: ['configuration'], type: ['change'], outcome: 'success',
      user: reason ? 'system' : 'cams-admin', camera: r.camera,
      message: `Camera move ${r.id} (${r.camera} from ${r.peer.name || r.peer.proxyId}) ${reason ? 'expired: not approved within 30 minutes' : `cancelled in ${from}`}: the camera ${entry === 'untouched' ? 'was not here' : entry === 'removed' ? 'removed here' : 'hidden here'}${entry === 'untouched' ? '' : `, copied content ${copied === 'delete' ? 'deleted' : 'left to age out'}`}`,
      details: this.details(r, { phase: from, copied, cameraEntry: entry, deleted, ...(reason ? { reason } : {}) }),
    });
    this.d.journal.bury?.({ moveId: r.id, role: 'target', phase: 'cancelled' });
    if (this.d.end) {
      removeLanded(this.d.end.dataDir, r.id);
      removeChunkParts(this.d.end.dataDir, r.id);
    }
    this.d.journal.remove?.(r.id);
    this.copying.delete(r.id);
  }

  // A move ended here before (its tombstone): the terminal phase sent again;
  // a record left behind by a crash between the tombstone and its removal goes.
  private past(id: string): MoveTombstone | null {
    const t = this.d.journal.ended?.(id, 'target') ?? null;
    if (!t) return null;
    this.terminalEvent(id, t.phase, t.code);
    const r = this.target(id);
    if (r && moveEnded(r.phase)) this.d.journal.remove?.(id);
    return t;
  }

  private terminalEvent(id: string, phase: MoveTombstone['phase'], code?: string): void {
    if (phase === 'failed') this.d.emit({ kind: 'move.phase', moveId: id, role: 'target', phase: 'failed', ok: false, code: code ?? 'internal' });
    else this.d.emit({ kind: 'move.phase', moveId: id, role: 'target', phase, ok: true });
  }

  // Offers never approved (final review 5): an opened move with no move.start
  // OFFER_EXPIRY_MS after the offer closes here (nothing was taken over),
  // audited move-cancel (reason offer_expired), `cancelled` reported.
  expireOffers(): void {
    let open: MoveRecord[];
    try {
      open = (this.d.journal.all?.() ?? this.d.journal.active()).filter((r) => r.role === 'target' && r.phase === 'opened' && !r.plan && this.now() - r.startedAt > OFFER_EXPIRY_MS);
    } catch {
      return;
    }
    for (const r of open) this.closeCancelled(r, r.copied ?? 'age-out', 'untouched', null, 'offer_expired');
  }

  private dropKeys(r: MoveRecord): void {
    delete r.x25519;
    delete r.leaf;
    delete r.token;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  // What the copy did, for move-done: chunks of the manifest by state (not
  // ended: abandoned), files and the bytes verified, the time since the start.
  private totals(r: MoveRecord) {
    const chunks = { total: 0, verified: 0, skipped: 0, failed: 0, abandoned: 0 };
    for (const c of r.manifest ?? []) {
      chunks.total++;
      const st = r.chunks[c.id]?.state;
      if (st === 'verified' || st === 'skipped' || st === 'failed') chunks[st]++;
      else chunks.abandoned++;
    }
    const files = { verified: 0, skipped: 0, failed: 0 };
    let bytes = 0;
    for (const c of Object.values(r.chunks)) {
      files.verified += c.v ?? 0;
      files.skipped += c.s ?? 0;
      files.failed += c.f ?? 0;
      bytes += c.vb ?? 0;
    }
    return { chunks, files, bytes, durationS: Math.max(0, Math.round(((r.endedAt ?? this.now()) - r.startedAt) / 1000)) };
  }

  // The runner of one move, once (a second call while it runs does nothing).
  run(moveId: string): void {
    if (this.runs.has(moveId)) return;
    const run: Run = { stopped: false, wake: null, done: Promise.resolve() };
    run.done = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.loop(moveId, run))
      .catch(() => this.crashed(moveId))
      .finally(() => {
        if (this.runs.get(moveId) === run) this.runs.delete(moveId);
      });
    this.runs.set(moveId, run);
  }

  // An unexpected throw (a full disk under the journal, the audit log): a fixed
  // line (no error text, it could carry anything) and the move failed if that can be recorded.
  private crashed(moveId: string): void {
    logger.error({ moveId }, 'move_target_runner_failed');
    try {
      const r = this.target(moveId);
      if (r && !moveEnded(r.phase)) this.phase(r, 'failed', 'internal');
    } catch {
      logger.error({ moveId }, 'move_target_failure_not_recorded');
    }
  }

  // Resolves when the move's runner is not running (a test seam, and the stop).
  idle(moveId: string): Promise<void> {
    return this.runs.get(moveId)?.done ?? Promise.resolve();
  }

  // Ends the runner and the copier (Task 10's cancel, the process stop): the
  // journal keeps the step it was in. A step in flight finishes or fails
  // first; the copier drops the file in flight (its temporary file).
  async stop(moveId: string): Promise<void> {
    const run = this.runs.get(moveId);
    if (run) {
      run.stopped = true;
      run.wake?.();
      await run.done;
    }
    await this.d.stopCopy?.(moveId);
  }

  // The process stop: every runner told to stop; a step in flight (a push can
  // take a minute) is waited for at most `waitMs`, its result then not recorded.
  async stopAll(waitMs = 3000): Promise<void> {
    const ids = new Set([...this.runs.keys(), ...this.copying]);
    const all = Promise.all([...ids].map((id) => this.stop(id)));
    let t: NodeJS.Timeout | undefined;
    await Promise.race([all, new Promise<void>((r) => (t = setTimeout(r, waitMs)))]);
    clearTimeout(t);
  }

  // At process start: every target move the journal has open, from its phase and step.
  resume(): void {
    let open: MoveRecord[];
    try {
      open = this.d.journal.active();
    } catch {
      return;
    }
    for (const r of open) {
      // A target move not started (no plan yet) waits for move.start.
      if (r.role !== 'target' || !r.plan) continue;
      if (r.leaf) this.d.stageLeaf(r.camera, leafOf(r.leaf.certPem, r.leaf.keyPem));
      this.run(r.id);
    }
  }

  private sleep(run: Run, ms: number): Promise<void> {
    if (run.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        run.wake = null;
        resolve();
      }, ms);
      t.unref();
      run.wake = () => {
        clearTimeout(t);
        run.wake = null;
        resolve();
      };
    });
  }

  private async loop(moveId: string, run: Run): Promise<void> {
    let r = this.target(moveId);
    if (!r || moveEnded(r.phase) || !r.plan) return;
    if (r.phase === 'opened') {
      r.step = SWITCH_STEPS[0];
      this.phase(r, 'switching');
    }
    while (r.phase === 'switching') {
      const step = r.step ?? SWITCH_STEPS[0];
      const outcome = await this.attempt(run, r, step);
      if (run.stopped) return;
      r = this.target(moveId);
      if (!r || r.phase !== 'switching') return;
      if (outcome === 'failed' || (typeof outcome === 'object' && outcome)) {
        this.phase(r, 'failed', typeof outcome === 'object' && outcome?.code ? outcome.code : CODES[step], typeof outcome === 'object' && outcome ? outcome.refused : undefined);
        return;
      }
      const next = SWITCH_STEPS[SWITCH_STEPS.indexOf(step) + 1];
      if (next) {
        r.step = next;
        this.d.journal.save(r);
      } else {
        delete r.step;
        this.phase(r, 'switched');
      }
    }
    if (run.stopped) return;
    // P12: copying starts right after switched, without waiting for the source's release.
    if (r.phase === 'switched') this.phase(r, 'copying');
    if (r.phase === 'copying') {
      this.copying.add(r.id);
      this.d.startCopy?.(r.id);
    }
  }

  // One step with its retries: 'ok', 'skipped', 'failed' when it gave up, or
  // {refused} when retrying can't help (each audited once); null when stopped.
  private async attempt(run: Run, r: MoveRecord, step: SwitchStep): Promise<'ok' | 'skipped' | 'failed' | { refused: string; code?: string } | null> {
    const t = this.d.timing ?? {};
    const attempts = t.attempts ?? ATTEMPTS;
    const t0 = Date.now();
    const waitUntil = { source: t0 + (t.notReadyMs ?? NOT_READY_MS), event: t0 + (t.eventWaitMs ?? EVENT_WAIT_MS) };
    let delay = t.retryMs ?? RETRY_MS;
    let tries = 0;
    let why = '';
    for (;;) {
      if (run.stopped) return null;
      try {
        const out = await this.step(r, step);
        if (run.stopped) return null;
        this.switchAudit(r, step, out.skipped ? 'skipped' : 'ok', out.message, out.details);
        return out.skipped ? 'skipped' : 'ok';
      } catch (err) {
        if (run.stopped) return null;
        if (err instanceof Refused) {
          this.switchAudit(r, step, 'failed', `${step} refused: ${err.message}`, { attempts: tries + 1, detail: err.message });
          return { refused: err.message, ...(err.code ? { code: err.code } : {}) };
        }
        if (err instanceof Wait && Date.now() < waitUntil[err.kind]) {
          await this.sleep(run, delay);
          delay = Math.min(delay * 2, t.retryCapMs ?? RETRY_CAP_MS);
          continue;
        }
        why = (err as Error).message;
        if (++tries >= attempts || err instanceof Wait) break;
        await this.sleep(run, delay);
        delay = Math.min(delay * 2, t.retryCapMs ?? RETRY_CAP_MS);
      }
    }
    this.switchAudit(r, step, 'failed', `${step} failed after ${tries} attempts: ${why}`, { attempts: tries, detail: why });
    return 'failed';
  }

  private step(r: MoveRecord, step: SwitchStep): Promise<{ message: string; skipped?: boolean; details?: Record<string, unknown> }> {
    if (step === 'secrets') return this.secrets(r);
    if (step === 'camera') return this.camera(r);
    if (step === 'cert') return this.cert(r);
    return this.ftp(r);
  }

  // The camera's password from the source, sealed to this move's key (S §9.3).
  private async secrets(r: MoveRecord): Promise<{ message: string }> {
    const p = r.peer;
    if (!p.url || !p.caFingerprints || !p.tlsServername || !r.token || !r.x25519) throw new Error('the journal lacks the source or the key');
    const source: MoveOfferArgs['source'] = { proxyId: p.proxyId, name: p.name, url: p.url, caFingerprints: p.caFingerprints, tlsServername: p.tlsServername };
    let res: { status: number; sealed?: string };
    try {
      res = await (this.d.fetchSecrets ?? fetchSecrets)(source, r.id, r.token);
    } catch {
      throw new Error('the source did not answer');
    }
    if (res.status === 409) throw new Wait('the source has no key for this move yet', 'source');
    if (res.status !== 200 || !res.sealed) throw new Error(`the source answered ${res.status}`);
    let plain: Buffer;
    try {
      plain = unseal(r.x25519.privatePkcs8, res.sealed);
    } catch {
      throw new Error('the sealed password does not open');
    }
    try {
      // The camera checks first (final review 7): a password is never stored
      // for a camera this proxy can't take (another camera's would be replaced).
      const plan = this.planCamera(r);
      if ('problem' in plan) throw new Refused(plan.problem, CODES.camera);
      // Noted before the write: a cancel deletes only a password this move stored.
      if (!r.passwordWritten) {
        r.passwordWritten = true;
        this.d.journal.save(r);
      }
      this.d.passwords.set(r.camera, plain.toString('utf8'));
    } finally {
      plain.fill(0);
    }
    return { message: 'the camera password stored' };
  }

  // The camera node as the camera step writes it (not written here), or why
  // not. The node is built whole: the offer's connection, every Settings field
  // of the move; a hidden `moved` leftover of this id (B7, final review 2) is
  // replaced in the same write, never merged: its overrides go, and a value
  // config.json gives it that the move does not set is set to what "absent"
  // means (the host value, the default). Refused: a camera of this id added
  // here since the offer (id_taken; not this step's own earlier write), or a
  // leftover whose config.json keeps what a move can't replace (tlsName, a PoE
  // switch port, a share, `moved` itself), or a per-camera password in the
  // environment (it would win over the moved one): stale_leftover.
  private planCamera(r: MoveRecord): CameraPlan {
    const c = r.cameraConnection;
    if (!c) throw new Error('the journal lacks the camera');
    const loaded = this.d.loaded();
    const id = r.camera;
    const existing = loaded.config.cameras[id];
    if (existing && existing.moved === undefined && !r.cameraWritten) return { problem: 'id_taken' };
    if ((loaded.env[cameraPasswordEnv(id)] ?? '').trim() !== '') return { problem: 'stale_leftover' };
    // The configuration without this camera's overrides: what config.json alone gives it.
    const all = structuredClone(loaded.overrides) as Record<string, unknown>;
    const cams = { ...((all.cameras ?? {}) as Record<string, unknown>) };
    const leftover = existing?.moved !== undefined;
    delete cams[id];
    if (Object.keys(cams).length) all.cameras = cams;
    else delete all.cameras;
    const base = rebuildWith(loaded, all);
    const file = base.config.cameras[id];
    const node: Record<string, unknown> = { name: c.name, host: c.host, protocol: c.protocol, user: c.user, onvifPort: c.onvifPort, rtspPort: c.rtspPort, baichuanPort: c.baichuanPort, ...structuredClone(r.settings ?? {}) };
    if (file) {
      if (file.tlsName !== undefined || file.poeSwitch?.port !== undefined || file.moved !== undefined) return { problem: 'stale_leftover' };
      const unset = (p: string) => getPath(node, p) === undefined;
      const dflt = cameraDefaults(id);
      if (unset('statusPollS') && file.statusPollS !== dflt.statusPollS) node.statusPollS = dflt.statusPollS;
      if (file.webUiUrl !== undefined) node.webUiUrl = `https://${c.host}/`;
      if (file.ftp.user !== undefined) setPath(node, 'ftp.user', id);
      if (file.storage.sharePercent !== undefined && unset('storage.sharePercent')) return { problem: 'stale_leftover' };
      for (const p of HOST_LEAVES) {
        if (getPath(file, p) === undefined || !unset(p)) continue;
        const v = getPath(base.config, p);
        if (v === undefined) return { problem: 'stale_leftover' };
        setPath(node, p, v);
      }
    }
    const patch: Record<string, unknown> = { cameras: { [id]: node } };
    const host = r.plan?.space === 'retention' && r.plan.targetSettings ? r.plan.targetSettings : {};
    for (const [path, v] of Object.entries(host)) setPath(patch, path, v);
    const plan = planOverrides(base, patch);
    return { next: plan.next, overrides: plan.overrides, leftover, host };
  }

  // The camera node (planCamera), in one override write, live (P1).
  private async camera(r: MoveRecord): Promise<{ message: string; details: Record<string, unknown> }> {
    const loaded = this.d.loaded();
    const plan = this.planCamera(r);
    if ('problem' in plan) throw new Refused(plan.problem);
    const { leftover, host } = plan;
    r.cameraWritten = true;
    this.d.journal.save(r);
    writeOverridesFile(loaded.files.overrides, plan.overrides);
    await this.d.setLoaded(plan.next);
    return { message: `${r.camera} added${leftover ? ' (its hidden entry replaced)' : ''}${Object.keys(host).length ? `; target settings ${Object.keys(host).join(', ')}` : ''}`, details: { leftover, targetSettings: Object.keys(host).length ? host : null } };
  }

  private async cert(r: MoveRecord): Promise<{ message: string; details: Record<string, unknown> }> {
    if (!r.leaf) throw new Error('the journal lacks the leaf');
    const leaf = leafOf(r.leaf.certPem, r.leaf.keyPem);
    const event = () => this.d.eventOpen?.(r.camera) === true;
    if (event()) throw new Wait('a camera event is open', 'event');
    const res = await this.d.pushLeaf(r.camera, leaf);
    // The push skips while an event is open (one began meanwhile): waited for like before it.
    if (res.outcome === 'failed' && event()) throw new Wait('a camera event is open', 'event');
    if (!(res.outcome === 'pushed' || res.outcome === 'current') || res.served !== leaf.fingerprint) {
      throw new Error(`push ${res.outcome}${res.detail ? `: ${res.detail}` : ''}`);
    }
    return { message: `the camera serves the leaf ${leaf.fingerprint}`, details: { leafFingerprint: leaf.fingerprint, push: res.outcome } };
  }

  private async ftp(r: MoveRecord): Promise<{ message: string; skipped?: boolean; details?: Record<string, unknown> }> {
    const v = await this.d.ftp(r.camera);
    if (v === 'skipped') return { message: 'FTP is off for the camera here: its upload left as it is', skipped: true };
    if (!v.verified) throw new Error(`the camera's FTP does not match (${v.mismatch.join(', ')})`);
    return { message: "the camera's FTP upload points here" };
  }
}
