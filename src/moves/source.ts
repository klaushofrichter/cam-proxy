import type { AuditLog } from '../audit/audit-log';
import { activeCameraIds } from '../config/cameras';
import type { CameraNode, Config } from '../config/defaults';
import { keepDaysOf } from './retention';
import { applyOverrides, planUnset, removeOverride, writeOverridesFile, type Loaded } from '../config/load';
import { planProblem, type MoveAnswerArgs, type MoveBeginArgs, type MoveCancelArgs, type MoveFinishArgs, type MoveGoArgs, type MoveOpenArgs, type MoveReleaseArgs, type MoveSummaryArgs, type MoveTargetsArgs } from '../fleet/command-args';
import type { Done, Handler } from '../fleet/commands';
import { fingerprint, newId } from '../fleet/protocol';
import { listChunks, summarize, type InventoryDeps } from './inventory';
import type { PushResult } from '../tls/push';
import { moveEnded, type MoveJournal, type MoveRecord, type MoveTombstone } from './journal';
import { autoPlan, type AutoWaitReason } from './plan';
import type { Purged, purgeExcept } from './purge';
import { moveDetail } from './detail';
import { failed, ok, samePlan, zeros } from './done';
import type { MoveActor, MoveAnswer, MoveBounds, MoveCameraConnection, MoveCopied, MoveEvent, MoveKind, MovePlan, MoveSummary, Settings } from './types';
import { HOUR } from '../time-units';

// The source side of a camera move (camera-move plan Task 7, S §4, §7, §9.1):
// the source proxy's page starts a move (move.targets, move.request events),
// cams-admin opens it (move.open: the journal with the token hash and the
// target's address), relays the target's answer (move.answer), the admin
// approves here (move.approve), cams-admin starts the switch-over (move.go:
// the target's key, its leaf as the expected one, the manifest frozen) and
// releases the camera once the target has it (move.release: hidden live).
// Never a password, a token or a key in an event, a record or an answer.
export type SourceRefusal = 'no_site_ca' | 'external_cert' | 'moves_not_allowed' | 'busy';
export interface MoveTarget { proxyId: string; name: string; site: string | null }

export interface SourceDeps {
  journal: Pick<MoveJournal, 'load' | 'save' | 'remove' | 'all' | 'active' | 'bury' | 'ended' | 'failed'>;
  audit: Pick<AuditLog, 'write'>;
  emit: (e: MoveEvent) => void;
  // The retention in effect: finished and cancelled phases carry what ages out (keepDays); left out, they carry none.
  retention?: () => Pick<Config['retention'], 'stillsDays' | 'previewsDays' | 'clipsDays' | 'eventsDays'>;
  // The settings in effect (cameras, tls.site) and the loaded configuration (release writes `moved`).
  running: () => Config;
  loaded: () => Loaded;
  setLoaded: (l: Loaded) => void;
  // move.send in the effective allow list (commands on, not paused).
  sendAllowed: () => boolean;
  // tls.site set and its CA loaded.
  siteReady: () => boolean;
  inventory: InventoryDeps;
  // The camera certificates' expected leaf (P8); undefined without a site CA.
  certs: () => { setExpected(id: string, fingerprint: string | null, who?: { user: string }): void } | undefined;
  // Task 5's refreshManifest with the router's cache (P12).
  refreshManifest: (moveId: string) => void;
  // This proxy's id at cams-admin (audit records name source and target); '' before enrollment.
  proxyId?: () => string;
  now?: () => number;
  // Task 10, the end of a move (move.finish, move.cancel): the camera's
  // content purged, its stored password deleted, its leaf files and trust
  // state forgotten (CameraCerts.forget); at a cancel after the switch-over
  // the source's own leaf pushed back ("Push now" with that leaf staged; the
  // expected leaf honoured), the camera's FTP pointed here again and read back,
  // and the camera workers settled after a configuration change. Without
  // them both answer internal.
  end?: {
    // The move's cached manifests, on disk and in memory (ManifestCache.forget).
    dropManifests: (moveId: string) => void;
    // Step 4 Task 6: everything of the camera but what the receiver reported to keep (purgeExcept).
    purge: (cam: string, o: Parameters<typeof purgeExcept>[2]) => { deleted: Purged; kept: Purged };
    deletePassword: (cam: string) => void;
    forgetLeaf: (cam: string) => void;
    pushOwnLeaf: (cam: string) => Promise<PushResult>;
    ftp: (cam: string) => Promise<'skipped' | { verified: boolean; mismatch: string[] }>;
    settled: () => Promise<void>;
  };
  // The give-back retries of a cancel (backoff from cancelRetryMs to cancelRetryCapMs).
  timing?: { cancelRetryMs?: number; cancelRetryCapMs?: number };
}

// Who asked, from the request (for the audit record and the move.request event).
export interface Asker { actor: MoveActor; user: string; ip?: string; userAgent?: string }
// cams-admin starting a move (move.begin), and approving it within the bounds (R1, B10).
export const BEGIN_ASKER: Asker = { actor: { origin: 'managed', label: 'cams-admin move' }, user: 'cams-admin' };
export const AUTO_ASKER: Asker = { actor: { origin: 'managed', label: 'cams-admin auto-approval' }, user: 'cams-admin' };

// One move as the source's page shows it (GET /control/moves).
export interface MoveView {
  id?: string;
  requestId: string;
  camera: string;
  target: { proxyId: string; name: string };
  phase: string;
  answer?: MoveAnswer;
  settings: Settings;
  summary: MoveSummary;
  plan: MovePlan | null;
  // What cams-admin lets this proxy approve by itself (move.begin); null: a person approves.
  bounds: MoveBounds | null;
  // The auto-approval's outcome: approved, or waiting for a person and why.
  autoApproval?: { state: 'approved' | 'waiting'; reason?: AutoWaitReason };
  progress?: { bytesDone: number; bytesTotal: number; rateBps: number; etaS: number };
  budgetExceeded: boolean;
  // The code a failed move ended with.
  failure?: string;
}

interface Pending {
  requestId: string;
  camera: string;
  target: string;
  actor: MoveActor;
  summary: MoveSummary;
  settings: Settings;
  connection: MoveCameraConnection;
  at: number;
  moveId?: string;
  targetName?: string;
  answer?: MoveAnswer;
  bounds: MoveBounds | null;
}

// A give-back step that failed, with its code (cert_failed, ftp_failed, camera_failed, no_site_ca).
class StepFailed extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
const RETRY_MS = 2000;
const RETRY_CAP_MS = 5 * 60_000;
const KEEP_MS = 30 * 60_000; // an offer not approved within 30 minutes expires (S §7)
// An opened move with no approval after that and 5 minutes slack closes here on its own (final review 5).
export const OFFER_EXPIRY_MS = KEEP_MS + 5 * 60_000;
const KEEP_MAX = 32;
// move.summary's answer is kept that long: summarize walks every still of the camera (~55k on the mini PC).
export const SUMMARY_CACHE_MS = 30_000;
const SWITCHED: readonly string[] = ['switching', 'switched', 'released', 'copying', 'copied'];
const RELEASED: readonly string[] = ['released', 'copying', 'copied'];

const sum = (d: Purged) => Object.values(d).reduce((n, k) => ({ files: n.files + k.files, bytes: n.bytes + k.bytes }), { files: 0, bytes: 0 });
const has = (s: MoveSummary, k: MoveKind) => s[k].files + s[k].rows > 0;

// The camera node's settings as they move (the contract's Settings): never the
// address, the user's password or the FTP user (the target uses its own).
export function settingsOf(n: CameraNode): Settings {
  const defined = <T extends object>(o: T): T | undefined => {
    const e = Object.entries(o).filter(([, v]) => v !== undefined);
    return e.length ? (Object.fromEntries(e) as T) : undefined;
  };
  const s: Settings = { name: n.name, statusPollS: n.statusPollS };
  const ftp = defined({ enabled: n.ftp?.enabled, stream: n.ftp?.stream });
  const stills = defined({ enabled: n.stills?.enabled, stream: n.stills?.stream, intervalS: n.stills?.intervalS });
  const storage = defined({ sharePercent: n.storage?.sharePercent });
  const kinds = defined({ person: n.analytics?.kinds?.person, vehicle: n.analytics?.kinds?.vehicle, pet: n.analytics?.kinds?.pet });
  const poll = defined({ enabled: n.events?.poll?.enabled });
  return { ...s, ...(ftp ? { ftp } : {}), ...(stills ? { stills } : {}), ...(storage ? { storage } : {}), ...(kinds ? { analytics: { kinds } } : {}), ...(poll ? { events: { poll } } : {}) };
}

export function connectionOf(n: CameraNode): MoveCameraConnection {
  return { proxyCameraId: n.id, name: n.name, host: n.host, protocol: n.protocol, user: n.user, onvifPort: n.onvifPort, rtspPort: n.rtspPort, baichuanPort: n.baichuanPort };
}

// Why the panel's plan can't be approved (S §7), or null. The structure first
// (the contract's planProblem), then against the target's answer: the estimate
// is the answer's, the budget at least that; kinds only with content; the
// space option the answer allows: all when it fits; else omit (the kinds left
// must fit), fit, or retention (the target's proposed limits, each at least the
// proposal; storage.maxBytes included). Target settings only with retention.
export function approveProblem(plan: unknown, summary: MoveSummary, answer: MoveAnswer | undefined): string | null {
  const bad = planProblem(plan);
  if (bad) return bad === 'plan.budget' ? 'plan.budgetS' : bad;
  const p = plan as MovePlan;
  if (!answer?.accept) return 'answer';
  if (answer.estimateS !== undefined && p.estimateS !== answer.estimateS) return 'plan.estimateS';
  if (p.budgetS < p.estimateS) return 'plan.budgetS';
  if (p.kinds.some((k) => !has(summary, k))) return 'plan.kinds';
  if (!p.transfer) return p.targetSettings === null ? null : 'plan.targetSettings';
  const space = answer.space;
  if (!space || space.fits) {
    if (p.space !== 'all') return 'plan.space';
    return p.targetSettings === null ? null : 'plan.targetSettings';
  }
  if (p.space === 'all') return 'plan.space';
  if (p.space === 'omit' && p.kinds.reduce((n, k) => n + summary[k].bytes, 0) > space.available) return 'plan.kinds';
  if (p.space !== 'retention') return p.targetSettings === null ? null : 'plan.targetSettings';
  const proposal = space.retentionProposal;
  if (!proposal) return 'plan.space';
  const ts = p.targetSettings;
  if (!ts || !Object.keys(ts).length) return 'plan.targetSettings';
  for (const [k, v] of Object.entries(ts)) {
    const want = proposal[k];
    if (typeof want !== 'number' || typeof v !== 'number' || v < want) return 'plan.targetSettings';
  }
  return null;
}

export class MoveSource {
  private readonly pending = new Map<string, Pending>();
  private readonly targets = new Map<string, { camera: string; at: number; targets: MoveTarget[] | null }>();
  // A source cancel's give-back: the pass running, the next one scheduled, the last failure audited.
  private readonly giving = new Map<string, Promise<boolean>>();
  private readonly retry = new Map<string, { timer: NodeJS.Timeout; delay: number; attempts: number }>();
  private readonly failAudited = new Map<string, number>();
  // The last summary per camera (move.summary, refreshed by every request).
  private readonly summaries = new Map<string, { at: number; summary: MoveSummary }>();
  private stopped = false;

  constructor(private readonly d: SourceDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }
  private self(): string | null {
    return this.d.proxyId?.() || null;
  }

  private prune(): void {
    const t = this.now();
    for (const m of [this.pending, this.targets] as Map<string, { at: number }>[]) {
      for (const [k, v] of m) if (t - v.at > KEEP_MS) m.delete(k);
      while (m.size > KEEP_MAX) m.delete(m.keys().next().value as string);
    }
  }

  // P10: the source's refusals before any event. undefined: no such camera.
  // Since 2026-10-26 (Klaus) a proxy without a site CA (the Pi) and a camera
  // whose certificate is managed elsewhere (tlsName) may be a move source:
  // no_site_ca and external_cert are no longer refusals here (managesCert).
  refusal(cam: string): SourceRefusal | 'unknown_camera' | null {
    const c = this.d.running();
    if (!activeCameraIds(c).includes(cam)) return 'unknown_camera';
    if (!this.d.sendAllowed()) return 'moves_not_allowed';
    return this.busy() ? 'busy' : null;
  }

  // No site CA here (tls.site unset, the Pi; or its CA not loaded).
  noSite(): boolean {
    return !this.d.running().tls.site || !this.d.siteReady();
  }
  // Whether this proxy manages the camera's certificate, as CameraCerts
  // decides it: a site CA loaded, tls.cameraCerts on, an https camera without
  // tlsName. Otherwise the source never expects, checks or pushes its leaf
  // (move.go sets no expected leaf; a cancel skips the certificate step).
  managesCert(cam: string): boolean {
    const c = this.d.running();
    const n = c.cameras[cam];
    return !this.noSite() && c.tls.cameraCerts !== false && !!n && n.protocol !== 'http' && !n.tlsName;
  }
  // Host-level refusals for a step of a move already started (approve).
  hostRefusal(): 'moves_not_allowed' | null {
    return this.d.sendAllowed() ? null : 'moves_not_allowed';
  }

  // One move per proxy at a time; an unreadable journal counts as busy.
  private busy(): boolean {
    try {
      return this.d.journal.active().length > 0;
    } catch {
      return true;
    }
  }

  private source(id: string): MoveRecord | null {
    const r = this.d.journal.load(id);
    return r && r.role === 'source' ? r : null;
  }

  private targetName(proxyId: string): string | undefined {
    for (const t of this.targets.values()) {
      const hit = t.targets?.find((x) => x.proxyId === proxyId);
      if (hit) return hit.name;
    }
    return undefined;
  }

  private phaseEvent(r: MoveRecord, who?: Asker): void {
    if (r.phase === 'failed') return;
    this.d.emit({ kind: 'move.phase', moveId: r.id, role: 'source', phase: r.phase, ok: true, ...(r.phase === 'finished' || r.phase === 'cancelled' ? this.keep() : {}) });
    this.d.audit.write({
      action: 'move-phase', category: ['configuration'], type: ['change'], outcome: 'success',
      user: who?.user ?? 'cams-admin', camera: r.camera,
      message: `Camera move ${r.id} (${r.camera} to ${r.peer.name || r.peer.proxyId}): ${r.phase}`,
      details: { moveId: r.id, camera: r.camera, source: this.self(), target: r.peer.proxyId, role: 'source', phase: r.phase },
    });
  }

  // POST /control/moves/targets: cams-admin answers with move.targets.
  startTargets(cam: string): { requestId: string } {
    this.prune();
    const requestId = newId('rq_');
    this.targets.set(requestId, { camera: cam, at: this.now(), targets: null });
    this.d.emit({ kind: 'move.targets', requestId, camera: cam });
    return { requestId };
  }

  targetsFor(requestId: string): { targets: MoveTarget[] | null } | null {
    const t = this.targets.get(requestId);
    return t ? { targets: t.targets } : null;
  }

  // POST /control/moves and move.begin (after refusal() said null); bounds only from move.begin.
  request(cam: string, target: string, who: Asker, bounds: MoveBounds | null = null): { requestId: string } {
    this.prune();
    const node = this.d.running().cameras[cam];
    const requestId = newId('rq_');
    const p: Pending = { requestId, camera: cam, target, actor: who.actor, summary: this.summaryOf(cam, true), settings: settingsOf(node), connection: connectionOf(node), at: this.now(), targetName: this.targetName(target), bounds };
    this.pending.set(requestId, p);
    this.d.emit({ kind: 'move.request', requestId, camera: p.connection, target, actor: p.actor, summary: p.summary, settings: p.settings, bounds });
    const bytes = Object.values(p.summary).reduce((n, k) => n + k.bytes, 0);
    this.d.audit.write({
      action: 'move-request', category: ['configuration'], type: ['creation'], outcome: 'success',
      user: who.user, ip: who.ip, userAgent: who.userAgent, camera: cam,
      message: `Camera move requested: ${cam} to ${p.targetName ?? target} by ${who.actor.label}`,
      details: { requestId, camera: cam, source: this.self(), target, targetName: p.targetName ?? null, origin: who.actor.origin, label: who.actor.label, bytes, summary: p.summary, bounds, autoApprove: bounds !== null },
    });
    return { requestId };
  }

  // What the source's page shows: the requests not opened, and the source moves of the journal.
  list(): MoveView[] {
    this.prune();
    let records: MoveRecord[] = [];
    try {
      records = this.d.journal.all().filter((r) => r.role === 'source');
    } catch {
      records = [];
    }
    const opened = new Set(records.map((r) => r.id));
    const pend: MoveView[] = [...this.pending.values()].filter((p) => !p.moveId || !opened.has(p.moveId)).map((p) => ({
      ...(p.moveId ? { id: p.moveId } : {}),
      requestId: p.requestId, camera: p.camera, target: { proxyId: p.target, name: p.targetName ?? '' },
      phase: p.answer && !p.answer.accept ? 'rejected' : p.moveId ? 'offered' : 'requested',
      ...(p.answer ? { answer: p.answer } : {}), settings: p.settings, summary: p.summary, plan: null, bounds: p.bounds, budgetExceeded: false,
    }));
    const moves: MoveView[] = records.map((r) => ({
      id: r.id, requestId: r.requestId ?? '', camera: r.camera, target: { proxyId: r.peer.proxyId, name: r.peer.name },
      phase: r.phase !== 'opened' ? r.phase : r.plan ? 'approved' : r.answer?.accept ? 'awaiting-approval' : 'offered',
      ...(r.answer ? { answer: r.answer } : {}), settings: r.settings ?? {}, summary: r.summary ?? summarize(this.d.inventory, r.camera), plan: r.plan, bounds: r.bounds ?? null, budgetExceeded: r.budgetExceeded === true,
      ...(r.autoApproval ? { autoApproval: { state: r.autoApproval.state, ...(r.autoApproval.reason ? { reason: r.autoApproval.reason } : {}) } } : {}),
      ...(r.failure ? { failure: r.failure } : {}),
    }));
    return [...moves, ...pend];
  }

  // POST /control/moves/:id/approve. 404 unknown, 409 not now, 400 the plan.
  approve(id: string, plan: unknown, who: Asker): { status: 202 | 400 | 404 | 409; body: object } {
    const r = this.source(id);
    if (!r) return { status: 404, body: { error: 'unknown_move' } };
    if (r.phase !== 'opened') return { status: 409, body: { error: 'wrong_phase', phase: r.phase } };
    if (!r.answer?.accept) return { status: 409, body: { error: 'not_ready' } };
    const bad = approveProblem(plan, r.summary ?? summarize(this.d.inventory, r.camera), r.answer);
    if (bad) return { status: 400, body: { error: 'invalid', detail: bad } };
    const p = plan as MovePlan;
    if (r.plan) {
      // Approved once: the same plan again only re-sends the event (cams-admin may have missed it).
      if (!samePlan(r.plan, p)) return { status: 409, body: { error: 'already_approved' } };
      this.d.emit({ kind: 'move.approve', moveId: id, plan: r.plan });
      return { status: 202, body: {} };
    }
    r.plan = p;
    r.approvedAt = this.now();
    r.budgetS = p.budgetS;
    this.d.journal.save(r);
    this.d.emit({ kind: 'move.approve', moveId: id, plan: p });
    this.d.audit.write({
      action: 'move-approve', category: ['configuration'], type: ['change'], outcome: 'success',
      user: who.user, ip: who.ip, userAgent: who.userAgent, camera: r.camera,
      message: `Camera move ${id} approved: ${r.camera} to ${r.peer.name || r.peer.proxyId}, ${p.transfer ? `content ${p.kinds.join(', ') || 'none'} (${p.space})` : 'no content'}, budget ${p.budgetS} s for an estimate of ${p.estimateS} s`,
      details: { moveId: id, camera: r.camera, source: this.self(), target: r.peer.proxyId, origin: who.actor.origin, label: who.actor.label, plan: p, kinds: p.kinds, space: p.space, settings: r.settings ?? null, budgetS: p.budgetS, estimateS: p.estimateS },
    });
    return { status: 202, body: {} };
  }

  // POST /control/moves/:id/cancel: cams-admin runs it (move.cancel to both sides, Task 10).
  requestCancel(id: string, copied: MoveCopied): { status: 202 | 404 | 409; body: object } {
    const r = this.source(id);
    if (!r) return { status: 404, body: { error: 'unknown_move' } };
    if (moveEnded(r.phase)) return { status: 409, body: { error: 'wrong_phase', phase: r.phase } };
    this.d.emit({ kind: 'move.cancel', moveId: id, copied });
    return { status: 202, body: {} };
  }

  // The expected leaf on this camera (P8), set by move.go, cleared by Task 10
  // (a cancel before the switch-over (B48), the end of the move). A camera
  // whose certificate this proxy does not manage: nothing to expect (true).
  setExpectedLeaf(cam: string, fingerprint: string | null): boolean {
    if (!this.managesCert(cam)) return true;
    const c = this.d.certs();
    if (!c) return false;
    c.setExpected(cam, fingerprint, { user: 'cams-admin' });
    return true;
  }

  // move.finish {role: source} (S §11, B49/X13): after the release (the
  // camera hidden, `moved` = this move), never while the camera runs here.
  // The end is journalled first (the target's token is refused from then on),
  // then all the camera's content is purged (copied or not), an
  // overrides-added camera removed (a config.json entry stays hidden, P2), its
  // stored password, leaf files, trust state and expected leaf deleted, the
  // move's cached manifests removed; `finished` reported and the record
  // removed. Audited move-cleanup (per kind) and move-done. The answer counts
  // the five kinds only. Again: zeros, nothing more.
  async finish(a: MoveFinishArgs): Promise<Done> {
    const end = this.d.end;
    if (!end) return failed('internal');
    // Ended here before (its tombstone, kept 7 days): the terminal phase again, the first answer.
    const past = this.past(a.moveId);
    if (past) return past.phase === 'finished' ? ok({ deleted: past.deleted ?? zeros() }) : failed('wrong_phase');
    const r = this.source(a.moveId);
    if (!r) return ok({ deleted: zeros() });
    // A return's record (step 4): only move.finish {return: true} ends it, and a return can't be cancelled (spec §1).
    if (r.returnOf) return failed('wrong_phase');
    if (r.phase === 'failed') {
      this.terminalEvent(r.id, 'failed', r.failure);
      return failed('wrong_phase');
    }
    if (r.phase !== 'released' && r.phase !== 'finished') return failed('wrong_phase');
    const cam = r.camera;
    const l = this.d.loaded();
    const node = l.config.cameras[cam];
    if (activeCameraIds(this.d.running()).includes(cam) || (node && node.moved !== r.id)) return failed('camera_active');
    if (r.phase !== 'finished') {
      r.phase = 'finished';
      r.endedAt = this.now();
      this.d.journal.save(r);
    }
    // Only what arrived (step 4 Task 6): the receiver's keep list stays, and
    // every Archive item not shown copied, with a "Kept here" note.
    const { deleted, kept } = end.purge(cam, {
      keep: r.keep ?? null,
      listed: new Set((r.manifest ?? []).map((c) => c.id)),
      note: { moveId: r.id, to: { proxyId: r.peer.proxyId, name: r.peer.name }, at: this.now() },
      ...(r.keepMissing ? { missing: r.keepMissing } : {}),
      ...(r.keepCopied ? { copied: r.keepCopied } : {}),
    });
    if (node && l.addedCameras.includes(cam)) {
      this.d.setLoaded(removeOverride(l, `cameras.${cam}`));
      await end.settled();
    }
    const entry = this.d.loaded().config.cameras[cam] ? 'hidden' : 'removed';
    end.deletePassword(cam);
    this.setExpectedLeaf(cam, null);
    end.forgetLeaf(cam);
    end.dropManifests(r.id);
    this.dropPending(r.id);
    this.phaseEvent(r);
    const total = sum(deleted);
    const stayed = sum(kept);
    const who = { source: this.self(), target: r.peer.proxyId, role: 'source' };
    this.d.audit.write({
      action: 'move-cleanup', category: ['configuration'], type: ['deletion'], outcome: 'success',
      user: 'cams-admin', camera: cam,
      message: `Camera move ${r.id}: ${cam} cleaned up after its move to ${r.peer.name || r.peer.proxyId}: ${total.files} files (${total.bytes} bytes) and the camera's catalog entries deleted${stayed.files ? `, ${stayed.files} files (${stayed.bytes} bytes) stay on this proxy (they age out with retention; Archive items keep their own expiry)` : ''}; its entry ${entry === 'hidden' ? 'stays hidden in config.json (you can delete it there)' : 'removed'}`,
      details: { moveId: r.id, camera: cam, ...who, deleted, kept, files: total.files, bytes: total.bytes, cameraEntry: entry },
    });
    this.d.audit.write({
      action: 'move-done', category: ['configuration'], type: ['change'], outcome: 'success',
      user: 'cams-admin', camera: cam,
      message: `Camera move ${r.id} (${cam} to ${r.peer.name || r.peer.proxyId}) done${a.abandoned ? ', the transfer ended early' : ''}`,
      details: { moveId: r.id, camera: cam, ...who, abandoned: a.abandoned, files: total.files, bytes: total.bytes, durationS: Math.max(0, Math.round(((r.endedAt ?? this.now()) - r.startedAt) / 1000)) },
    });
    this.d.journal.bury({ moveId: r.id, role: 'source', phase: 'finished', deleted });
    this.d.journal.remove(r.id);
    return ok({ deleted });
  }

  // move.cancel {role: source} (S §10.3). The end is journalled first (the
  // target's token is refused from then on). Before the switch-over (B48:
  // nothing switched): only an expected leaf is cleared, the camera runs here
  // untouched; the move closes. After it the camera comes back (giveBack):
  // `moved` is cleared first (the camera is this proxy's again at once,
  // whatever fails later), the target's leaf it serves is the expected one,
  // the source's own leaf is pushed, the camera's FTP points here again, and
  // only then is the expected leaf cleared and `cancelled` reported. A step
  // that fails is audited (at most hourly) and the source retries by itself
  // with a backoff, also after a restart (resume); until then the move counts
  // as open (busy). The answer is ok once the cancel is taken on. Again: nothing more.
  async cancel(a: MoveCancelArgs): Promise<Done> {
    const end = this.d.end;
    if (!end) return failed('internal');
    const past = this.past(a.moveId);
    if (past) return past.phase === 'cancelled' ? ok() : failed('wrong_phase');
    const r = this.source(a.moveId);
    if (!r) return ok();
    // A return's record (step 4): only move.finish {return: true} ends it, and a return can't be cancelled (spec §1).
    if (r.returnOf) return failed('wrong_phase');
    if (r.phase === 'finished') return failed('wrong_phase');
    const cam = r.camera;
    if (r.phase !== 'cancelled') {
      r.cancelledFrom = r.phase;
      r.switchedOver = r.expectedLeaf !== undefined || this.d.loaded().config.cameras[cam]?.moved === r.id;
      if (r.switchedOver) r.cancelPending = true;
      if (a.expectedLeaf) r.expectedLeaf = a.expectedLeaf;
      r.phase = 'cancelled';
      r.endedAt = this.now();
      this.d.journal.save(r);
    }
    end.dropManifests(r.id);
    if (!r.switchedOver) {
      this.setExpectedLeaf(cam, null);
      this.closeCancelled(r, {});
      return ok();
    }
    await this.giveBack(r.id);
    return ok();
  }

  // Every source cancel still giving its camera back (at process start).
  resume(): void {
    let open: MoveRecord[] = [];
    try {
      open = this.d.journal.all().filter((r) => r.role === 'source' && r.cancelPending === true);
    } catch {
      return;
    }
    this.stopped = false;
    for (const r of open) void this.giveBack(r.id);
  }

  // The process stop: no further give-back pass is started (the journal keeps the cancel).
  stop(): void {
    this.stopped = true;
    for (const t of this.retry.values()) clearTimeout(t.timer);
    this.retry.clear();
  }

  // One give-back pass at a time per move; true when the cancel completed.
  private giveBack(id: string): Promise<boolean> {
    const running = this.giving.get(id);
    if (running) return running;
    const p = this.giveBackOnce(id).catch(() => false).finally(() => this.giving.delete(id));
    this.giving.set(id, p);
    return p;
  }

  private async giveBackOnce(id: string): Promise<boolean> {
    const end = this.d.end;
    const r = this.source(id);
    if (!end || !r || !r.cancelPending) return true;
    clearTimeout(this.retry.get(id)?.timer);
    const cam = r.camera;
    const leaf = r.expectedLeaf ?? null;
    let step: 'camera' | 'cert' | 'ftp' = 'camera';
    const detail: Record<string, unknown> = {};
    // Decided once per pass: the certificate step only where this proxy manages the camera's certificate.
    const managed = this.managesCert(cam);
    try {
      // (a) `moved` first: the camera is this proxy's again from here on.
      const l = this.d.loaded();
      if (l.config.cameras[cam]?.moved === r.id) {
        const plan = planUnset(l, [`cameras.${cam}.moved`]);
        writeOverridesFile(l.files.overrides, plan.overrides);
        this.d.setLoaded(plan.next);
      }
      step = 'cert';
      if (leaf && !this.setExpectedLeaf(cam, leaf)) throw new StepFailed('no_site_ca', 'no site CA here');
      step = 'camera';
      await end.settled();
      if (!activeCameraIds(this.d.running()).includes(cam)) throw new StepFailed('camera_failed', `${cam} does not run here`);
      if (managed) {
        step = 'cert';
        const push = await end.pushOwnLeaf(cam);
        if ((push.outcome !== 'pushed' && push.outcome !== 'current') || !push.served || push.served === leaf) throw new StepFailed('cert_failed', `push ${push.outcome}${push.detail ? `: ${push.detail}` : ''}`);
        Object.assign(detail, { push: push.outcome, leafFingerprint: push.served });
      } else {
        // Not this proxy's certificate (no site CA, tlsName, http, cameraCerts off): the camera keeps the target's leaf.
        detail.cert = 'not_managed';
      }
      step = 'ftp';
      let ftp: 'skipped' | { verified: boolean; mismatch: string[] };
      try {
        ftp = await end.ftp(cam);
      } catch {
        // An unmanaged camera may still serve the target's leaf, which this proxy's client does not trust.
        throw new StepFailed('ftp_failed', `the camera's FTP could not be set${managed ? '' : " (if the camera still serves the target's certificate, restore the camera's own certificate where it is managed, e.g. the cam1-cert-push job)"}`);
      }
      if (ftp !== 'skipped' && !ftp.verified) throw new StepFailed('ftp_failed', `the camera's FTP does not match (${ftp.mismatch.join(', ')})`);
      detail.ftp = ftp === 'skipped' ? 'skipped' : 'ok';
    } catch (err) {
      const e = err instanceof StepFailed ? err : new StepFailed('internal', 'unexpected error');
      this.giveBackFailed(r, step, e);
      this.scheduleGiveBack(id);
      return false;
    }
    this.setExpectedLeaf(cam, null);
    const fresh = this.source(id) ?? r;
    delete fresh.cancelPending;
    this.retry.delete(id);
    this.failAudited.delete(id);
    this.closeCancelled(fresh, detail);
    return true;
  }

  // A failed give-back step: audited at most hourly per move, never silent.
  private giveBackFailed(r: MoveRecord, step: string, e: StepFailed): void {
    const t = this.now();
    const last = this.failAudited.get(r.id);
    const attempts = (this.retry.get(r.id)?.attempts ?? 0) + 1;
    if (last !== undefined && t - last < HOUR) return;
    this.failAudited.set(r.id, t);
    this.d.audit.write({
      action: 'move-cancel', category: ['configuration'], type: ['change'], outcome: 'failure',
      user: 'cams-admin', camera: r.camera,
      message: `Camera move ${r.id} (${r.camera} to ${r.peer.name || r.peer.proxyId}): giving the camera back is not done yet, ${step} failed (${e.code}): ${e.message}; the camera runs here, trying again`,
      details: { moveId: r.id, camera: r.camera, source: this.self(), target: r.peer.proxyId, role: 'source', phase: r.cancelledFrom ?? 'opened', step, code: e.code, detail: e.message.slice(0, 200), attempts },
    });
  }

  private scheduleGiveBack(id: string): void {
    if (this.stopped) return;
    const t = this.d.timing ?? {};
    const prev = this.retry.get(id);
    const delay = prev ? Math.min(prev.delay * 2, t.cancelRetryCapMs ?? RETRY_CAP_MS) : (t.cancelRetryMs ?? RETRY_MS);
    const timer = setTimeout(() => void this.giveBack(id), delay);
    timer.unref();
    this.retry.set(id, { timer, delay, attempts: (prev?.attempts ?? 0) + 1 });
  }

  // A cancelled source move's end: `cancelled` reported, audited, its tombstone written, the record removed.
  private closeCancelled(r: MoveRecord, detail: Record<string, unknown>, reason?: 'offer_expired'): void {
    const phase = r.cancelledFrom ?? 'opened';
    this.dropPending(r.id);
    this.phaseEvent(r);
    this.d.audit.write({
      action: 'move-cancel', category: ['configuration'], type: ['change'], outcome: 'success',
      user: reason ? 'system' : 'cams-admin', camera: r.camera,
      message: `Camera move ${r.id} (${r.camera} to ${r.peer.name || r.peer.proxyId}) ${reason ? 'expired: not approved within 30 minutes' : `cancelled in ${phase}`}: ${!r.switchedOver ? 'the camera stayed here' : detail.cert === 'not_managed' ? "the camera is back here with its FTP; its certificate was not restored because this proxy does not manage it: the camera keeps the target's certificate; restore it where it is managed (e.g. the cam1-cert-push job)" : 'the camera is back here with its own certificate and FTP'}`,
      details: { moveId: r.id, camera: r.camera, source: this.self(), target: r.peer.proxyId, role: 'source', phase, switchedBack: r.switchedOver === true, ...(reason ? { reason } : {}), ...detail },
    });
    this.d.journal.bury({ moveId: r.id, role: 'source', phase: 'cancelled', ...(r.switchedOver ? { camera: r.camera } : {}) });
    this.d.journal.remove(r.id);
  }

  // A move ended here before (its tombstone): the terminal phase sent again
  // (cams-admin may have missed it, a restart may have lost it); a record
  // left behind by a crash between the tombstone and its removal goes.
  private past(id: string): MoveTombstone | null {
    const t = this.d.journal.ended(id, 'source');
    if (!t) return null;
    this.terminalEvent(id, t.phase, t.code);
    const r = this.d.journal.load(id);
    if (r && r.role === 'source' && moveEnded(r.phase) && !r.cancelPending) this.d.journal.remove(id);
    return t;
  }

  private terminalEvent(id: string, phase: MoveTombstone['phase'], code?: string): void {
    if (phase === 'failed') this.d.emit({ kind: 'move.phase', moveId: id, role: 'source', phase: 'failed', ok: false, code: code ?? 'internal' });
    else this.d.emit({ kind: 'move.phase', moveId: id, role: 'source', phase, ok: true, ...this.keep() });
  }

  private keep(): { keepDays?: number } {
    const r = this.d.retention?.();
    return r ? { keepDays: keepDaysOf(r) } : {};
  }

  // Offers never approved (final review 5): an opened move with no plan
  // OFFER_EXPIRY_MS after it opened closes here (nothing was switched),
  // audited move-cancel (reason offer_expired), `cancelled` reported.
  expireOffers(): void {
    let open: MoveRecord[];
    try {
      open = this.d.journal.all().filter((r) => r.role === 'source' && r.phase === 'opened' && !r.plan && this.now() - r.startedAt > OFFER_EXPIRY_MS);
    } catch {
      return;
    }
    for (const r of open) {
      r.cancelledFrom = 'opened';
      r.switchedOver = false;
      r.phase = 'cancelled';
      r.endedAt = this.now();
      this.d.journal.save(r);
      this.d.end?.dropManifests(r.id);
      this.closeCancelled(r, {}, 'offer_expired');
    }
  }

  // After every welcome: the failure of each failed move kept here (its record stays until a cancel).
  reemitFailed(): void {
    let list: { moveId: string; role: 'source' | 'target'; code: string }[];
    try {
      list = this.d.journal.failed();
    } catch {
      return;
    }
    for (const f of list) this.d.emit({ kind: 'move.phase', moveId: f.moveId, role: f.role, phase: 'failed', ok: false, code: f.code });
  }

  // A valid move token from another address (B46/X15): the move fails here,
  // in the journal too (a restart does not resume it), and cams-admin hears it.
  wrongAddress(r: MoveRecord): void {
    const fresh = this.source(r.id);
    if (fresh && !moveEnded(fresh.phase)) {
      fresh.phase = 'failed';
      fresh.failure = 'token_address';
      fresh.endedAt = this.now();
      this.d.journal.save(fresh);
      this.d.end?.dropManifests(fresh.id);
      this.d.audit.write({
        action: 'move-phase', category: ['configuration'], type: ['change'], outcome: 'failure',
        user: 'system', camera: fresh.camera,
        message: `Camera move ${fresh.id} (${fresh.camera} to ${fresh.peer.name || fresh.peer.proxyId}): failed (token_address: the move token was used from another address)`,
        details: { moveId: fresh.id, camera: fresh.camera, source: this.self(), target: fresh.peer.proxyId, role: 'source', phase: 'failed', code: 'token_address' },
      });
    }
    this.d.emit({ kind: 'move.phase', moveId: r.id, role: 'source', phase: 'failed', ok: false, code: 'token_address' });
  }

  // The page's pending request of an ended move goes with it.
  private dropPending(moveId: string): void {
    for (const [k, p] of this.pending) if (p.moveId === moveId) this.pending.delete(k);
  }

  // After every welcome (B2): the open move's phase again.
  reemit(current: { moveId: string; role: 'source' | 'target'; phase: string; code?: string } | null): void {
    if (!current || current.phase === 'failed') return;
    this.d.emit({ kind: 'move.phase', moveId: current.moveId, role: current.role, phase: current.phase as Exclude<MoveRecord['phase'], 'failed'>, ok: true, ...(current.code ? { code: current.code } : {}) });
  }

  handlers(): Record<string, Handler> {
    const guard = (fn: (a: never) => Done): Handler => (args) => {
      try {
        return fn(args as never);
      } catch {
        return failed('internal');
      }
    };
    return {
      'move.targets': guard((a: MoveTargetsArgs) => {
        const t = this.targets.get(a.requestId);
        if (!t) return failed('unknown_request');
        t.targets = a.targets.map((x) => ({ proxyId: x.proxyId, name: x.name, site: x.site }));
        for (const p of this.pending.values()) if (!p.targetName) p.targetName = this.targetName(p.target);
        return ok();
      }),
      'move.begin': guard((a: MoveBeginArgs) => this.begin(a)),
      'move.summary': guard((a: MoveSummaryArgs) => this.preSummary(a)),
      'move.open': guard((a: MoveOpenArgs) => this.open(a)),
      'move.answer': guard((a: MoveAnswerArgs) => this.answer(a)),
      'move.go': guard((a: MoveGoArgs) => this.go(a)),
      'move.release': guard((a: MoveReleaseArgs) => this.release(a)),
    };
  }

  // move.begin (R1): cams-admin starts a move as the page would, with the
  // same refusals; the move.request event (with the bounds) goes out before this result.
  begin(a: MoveBeginArgs): Done {
    const why = this.refusal(a.camera);
    if (why) return failed(why);
    return ok({ requestId: this.request(a.camera, a.target, BEGIN_ASKER, a.bounds).requestId });
  }

  // move.summary: the summary a move.request for this camera would carry, before
  // cams-admin starts the move. Read only: no event, no move record, no audit
  // of its own (the runner journals and audits it like config.get).
  preSummary(a: MoveSummaryArgs): Done {
    if (!activeCameraIds(this.d.running()).includes(a.camera)) return failed('unknown_camera');
    return ok({ summary: this.summaryOf(a.camera) });
  }

  // summarize() for the camera; `fresh` (a request) always reads, the rest take a summary younger than SUMMARY_CACHE_MS.
  private summaryOf(cam: string, fresh = false): MoveSummary {
    const hit = this.summaries.get(cam);
    if (!fresh && hit && this.now() - hit.at < SUMMARY_CACHE_MS) return hit.summary;
    const summary = summarize(this.d.inventory, cam);
    this.summaries.set(cam, { at: this.now(), summary });
    return summary;
  }

  private open(a: MoveOpenArgs): Done {
    const existing = this.d.journal.load(a.moveId);
    if (existing) return existing.role === 'source' && existing.tokenHash === a.tokenHash && existing.camera === a.camera && existing.requestId === a.requestId ? ok() : failed('move_exists');
    const p = this.pending.get(a.requestId);
    if (!p || p.camera !== a.camera) return failed('unknown_request');
    const why = this.refusal(a.camera);
    if (why) return failed(why);
    const r: MoveRecord = {
      v: 1, id: a.moveId, role: 'source', camera: a.camera, phase: 'opened', plan: null,
      peer: { proxyId: p.target, name: p.targetName ?? '', ip: a.targetIp },
      tokenHash: a.tokenHash, requestId: a.requestId, actor: p.actor, bounds: p.bounds,
      summary: p.summary, settings: p.settings, cameraConnection: p.connection,
      ...(p.answer ? { answer: p.answer } : {}),
      chunks: {}, bytesDone: 0, startedAt: this.now(),
    };
    this.d.journal.save(r);
    p.moveId = a.moveId;
    this.phaseEvent(r);
    // The target answered before the open: the pending request kept it.
    this.autoApprove(r);
    return ok();
  }

  private answer(a: MoveAnswerArgs): Done {
    // The detail is kept as one line (moveDetail): the page and the audit show it next to the reason.
    const detail = a.detail !== undefined ? moveDetail(a.detail) : undefined;
    const answer: MoveAnswer = { accept: a.accept, ...(a.reason !== undefined ? { reason: a.reason } : {}), ...(detail ? { detail } : {}), ...(a.space !== undefined ? { space: a.space } : {}), ...(a.estimateS !== undefined ? { estimateS: a.estimateS } : {}) };
    const same = (x?: MoveAnswer) => JSON.stringify(x) === JSON.stringify(answer);
    const r = this.d.journal.load(a.moveId);
    if (r) {
      if (r.role !== 'source' || r.requestId !== a.requestId || r.peer.proxyId !== a.target.proxyId) return failed('mismatch');
      if (same(r.answer)) return ok();
      if (r.phase !== 'opened' || r.answer) return failed('wrong_phase');
      if (!a.accept) {
        // Rejected (an end): the record goes; the page shows the reason until the request expires.
        this.d.journal.remove(r.id);
        const p = this.pending.get(a.requestId);
        if (p) Object.assign(p, { answer, moveId: r.id, targetName: a.target.name });
        this.rejected(r.id, r.camera, a, detail);
        return ok();
      }
      r.answer = answer;
      r.peer.name = a.target.name;
      this.d.journal.save(r);
      this.autoApprove(r);
      return ok();
    }
    // Answered before an open (cams-admin refused it, or the target answered first): the pending request keeps it.
    const p = this.pending.get(a.requestId);
    if (!p || p.target !== a.target.proxyId || (p.moveId && p.moveId !== a.moveId)) return failed(p ? 'mismatch' : 'unknown_request');
    if (same(p.answer)) return ok();
    Object.assign(p, { answer, moveId: a.moveId, targetName: a.target.name });
    if (!a.accept) this.rejected(a.moveId, p.camera, a, detail);
    return ok();
  }

  // R2: an accepted answer to a move cams-admin began with bounds. The plan
  // the panel would build is approved by approve() itself, as a click would,
  // with all its checks; otherwise the offer waits for a person, and why is
  // audited and kept on the record (B5). Once per move.
  private autoApprove(r: MoveRecord): void {
    if (!r.bounds || r.plan || !r.answer?.accept || r.autoApproval) return;
    try {
      const host = this.hostRefusal();
      if (host) return this.autoWait(r, 'not_allowed', host);
      const built = autoPlan(r.bounds, r.summary ?? summarize(this.d.inventory, r.camera), r.answer);
      if ('reason' in built) return this.autoWait(r, built.reason);
      const res = this.approve(r.id, built.plan, AUTO_ASKER);
      if (res.status !== 202) {
        const body = res.body as { error?: string; detail?: string };
        return this.autoWait(r, 'plan', body.detail ?? body.error);
      }
      const fresh = this.source(r.id);
      if (fresh) {
        fresh.autoApproval = { state: 'approved', at: this.now() };
        this.d.journal.save(fresh);
      }
    } catch {
      // The answer is kept regardless; without a decision the offer waits for a person.
    }
  }

  private autoWait(r: MoveRecord, reason: AutoWaitReason, detail?: string): void {
    const fresh = this.source(r.id) ?? r;
    fresh.autoApproval = { state: 'waiting', reason, at: this.now() };
    this.d.journal.save(fresh);
    this.d.audit.write({
      action: 'move-auto-approve', category: ['configuration'], type: ['info'], outcome: 'failure',
      user: 'cams-admin', camera: fresh.camera,
      message: `Camera move ${fresh.id} (${fresh.camera} to ${fresh.peer.name || fresh.peer.proxyId}): not approved automatically (${reason}); waiting for approval here`,
      details: { moveId: fresh.id, camera: fresh.camera, source: this.self(), target: fresh.peer.proxyId, role: 'source', reason, ...(detail ? { detail } : {}), bounds: fresh.bounds ?? null, estimateS: fresh.answer?.estimateS ?? null },
    });
  }

  // After every welcome (B7): the plan of each move approved here and not
  // started yet, again (a lost move.approve would leave it waiting with nobody to click).
  reemitApprovals(): void {
    let list: MoveRecord[];
    try {
      list = this.d.journal.all();
    } catch {
      return;
    }
    for (const r of list) if (r.role === 'source' && r.phase === 'opened' && r.plan) this.d.emit({ kind: 'move.approve', moveId: r.id, plan: r.plan });
  }

  private rejected(moveId: string, cam: string, a: MoveAnswerArgs, detail: string | undefined): void {
    this.d.audit.write({
      action: 'move-phase', category: ['configuration'], type: ['change'], outcome: 'failure',
      user: 'cams-admin', camera: cam,
      message: `Camera move ${moveId} (${cam} to ${a.target.name || a.target.proxyId}): rejected (${a.reason ?? 'no reason'}${detail ? `: ${detail}` : ''})`,
      details: { moveId, camera: cam, source: this.self(), target: a.target.proxyId, role: 'source', phase: 'rejected', reason: a.reason ?? null, ...(detail ? { detail } : {}) },
    });
  }

  private go(a: MoveGoArgs): Done {
    const r = this.source(a.moveId);
    if (!r) return failed('unknown_move');
    if (SWITCHED.includes(r.phase)) {
      // Again (a new cmdId): the same state; the expected leaf set again, nothing listed again.
      if (r.expectedLeaf !== a.expectedLeaf || r.targetPublicSpki !== a.targetPublicKey || !r.plan || !samePlan(r.plan, a.plan)) return failed('conflict');
      if (!RELEASED.includes(r.phase) && !this.setExpectedLeaf(r.camera, a.expectedLeaf)) return failed('no_site_ca');
      return ok();
    }
    if (r.phase !== 'opened') return failed('wrong_phase');
    if (!r.plan) return failed('not_approved');
    // Only what the admin approved here (S §7: approving is the only approval).
    if (!samePlan(r.plan, a.plan)) return failed('plan_mismatch');
    if (this.managesCert(r.camera) && !this.d.certs()) return failed('no_site_ca');
    r.targetPublicSpki = a.targetPublicKey;
    r.expectedLeaf = a.expectedLeaf;
    r.manifest = r.plan.transfer ? listChunks(this.d.inventory, r.camera, r.plan.kinds) : [];
    r.phase = 'switching';
    this.d.journal.save(r);
    this.setExpectedLeaf(r.camera, a.expectedLeaf);
    this.d.audit.write({
      action: 'move-switch', category: ['configuration'], type: ['change'], outcome: 'success',
      user: 'cams-admin', camera: r.camera,
      message: `Camera move ${r.id}: switch-over to ${r.peer.name || r.peer.proxyId} started; ${r.camera} may serve the leaf ${a.expectedLeaf}; ${r.manifest.length} chunks listed`,
      details: { moveId: r.id, camera: r.camera, source: this.self(), target: r.peer.proxyId, step: 'go', outcome: 'ok', leafFingerprint: a.expectedLeaf, publicKeyFingerprint: fingerprint(a.targetPublicKey), chunks: r.manifest.length },
    });
    this.phaseEvent(r);
    return ok();
  }

  private release(a: MoveReleaseArgs): Done {
    const r = this.source(a.moveId);
    if (!r) return failed('unknown_move');
    if (!SWITCHED.includes(r.phase)) return failed('wrong_phase');
    // Hidden live (P2): worker stopped, not listed, its FTP user refused; config and content stay.
    const l = this.d.loaded();
    if (l.config.cameras[r.camera]?.moved !== r.id) this.d.setLoaded(applyOverrides(l, { cameras: { [r.camera]: { moved: r.id } } }));
    if (RELEASED.includes(r.phase)) return ok();
    // What the source captured during the overlap is listed again (P12).
    this.d.refreshManifest(r.id);
    const fresh = this.source(r.id) ?? r;
    fresh.phase = 'released';
    this.d.journal.save(fresh);
    this.phaseEvent(fresh);
    return ok();
  }
}
