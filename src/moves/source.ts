import { createHash } from 'crypto';
import type { AuditLog } from '../audit/audit-log';
import { activeCameraIds } from '../config/cameras';
import type { CameraNode, Config } from '../config/defaults';
import { applyOverrides, type Loaded } from '../config/load';
import { planProblem, type MoveAnswerArgs, type MoveGoArgs, type MoveOpenArgs, type MoveReleaseArgs, type MoveTargetsArgs } from '../fleet/command-args';
import type { Done, Handler } from '../fleet/commands';
import { newId } from '../fleet/protocol';
import { listChunks, summarize, type InventoryDeps } from './inventory';
import { moveEnded, type MoveJournal, type MoveRecord } from './journal';
import type { MoveActor, MoveAnswer, MoveCameraConnection, MoveCopied, MoveEvent, MoveKind, MovePlan, MoveSummary, Settings } from './types';

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
  journal: Pick<MoveJournal, 'load' | 'save' | 'remove' | 'all' | 'active'>;
  audit: Pick<AuditLog, 'write'>;
  emit: (e: MoveEvent) => void;
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
}

// Who asked, from the request (for the audit record and the move.request event).
export interface Asker { actor: MoveActor; user: string; ip?: string; userAgent?: string }

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
  progress?: { bytesDone: number; bytesTotal: number; rateBps: number; etaS: number };
  budgetExceeded: boolean;
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
}

const KEEP_MS = 30 * 60_000; // an offer not approved within 30 minutes expires (S §7)
const KEEP_MAX = 32;
const SWITCHED: readonly string[] = ['switching', 'switched', 'released', 'copying', 'copied'];
const RELEASED: readonly string[] = ['released', 'copying', 'copied'];

const ok = (): Done => ({ status: 'ok', result: {} });
const failed = (code: string): Done => ({ status: 'failed', code });
const has = (s: MoveSummary, k: MoveKind) => s[k].files + s[k].rows > 0;
// Two plans alike: kinds in any order, target settings in any key order.
const canonical = (p: MovePlan): string => JSON.stringify([p.transfer, [...p.kinds].sort(), p.space, p.targetSettings ? Object.entries(p.targetSettings).sort(([a], [b]) => (a < b ? -1 : 1)) : null, p.budgetS, p.estimateS]);
const samePlan = (a: MovePlan, b: MovePlan) => canonical(a) === canonical(b);
// The fingerprint of the target's public key: audited, never the key.
const keyFingerprint = (spkiB64: string) => `SHA256:${createHash('sha256').update(Buffer.from(spkiB64, 'base64')).digest('hex').toUpperCase()}`;

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

  // P10: the source's refusals before any event. The Pi (no tls.site) refuses
  // every move as no_site_ca, whatever it names. undefined: no such camera.
  refusal(cam: string): SourceRefusal | 'unknown_camera' | null {
    const c = this.d.running();
    if (this.noSite()) return 'no_site_ca';
    if (!activeCameraIds(c).includes(cam)) return 'unknown_camera';
    if (c.cameras[cam].tlsName) return 'external_cert';
    if (!this.d.sendAllowed()) return 'moves_not_allowed';
    return this.busy() ? 'busy' : null;
  }

  // No site CA here (tls.site unset, the Pi; or its CA not loaded): no move at all.
  noSite(): boolean {
    return !this.d.running().tls.site || !this.d.siteReady();
  }
  // Host-level refusals for a step of a move already started (approve).
  hostRefusal(): 'no_site_ca' | 'moves_not_allowed' | null {
    return this.noSite() ? 'no_site_ca' : this.d.sendAllowed() ? null : 'moves_not_allowed';
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
    this.d.emit({ kind: 'move.phase', moveId: r.id, role: 'source', phase: r.phase, ok: true });
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

  // POST /control/moves (after refusal() said null).
  request(cam: string, target: string, who: Asker): { requestId: string } {
    this.prune();
    const node = this.d.running().cameras[cam];
    const requestId = newId('rq_');
    const p: Pending = { requestId, camera: cam, target, actor: who.actor, summary: summarize(this.d.inventory, cam), settings: settingsOf(node), connection: connectionOf(node), at: this.now(), targetName: this.targetName(target) };
    this.pending.set(requestId, p);
    this.d.emit({ kind: 'move.request', requestId, camera: p.connection, target, actor: p.actor, summary: p.summary, settings: p.settings });
    const bytes = Object.values(p.summary).reduce((n, k) => n + k.bytes, 0);
    this.d.audit.write({
      action: 'move-request', category: ['configuration'], type: ['creation'], outcome: 'success',
      user: who.user, ip: who.ip, userAgent: who.userAgent, camera: cam,
      message: `Camera move requested: ${cam} to ${p.targetName ?? target} by ${who.actor.label}`,
      details: { requestId, camera: cam, source: this.self(), target, targetName: p.targetName ?? null, origin: who.actor.origin, label: who.actor.label, bytes, summary: p.summary },
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
      ...(p.answer ? { answer: p.answer } : {}), settings: p.settings, summary: p.summary, plan: null, budgetExceeded: false,
    }));
    const moves: MoveView[] = records.map((r) => ({
      id: r.id, requestId: r.requestId ?? '', camera: r.camera, target: { proxyId: r.peer.proxyId, name: r.peer.name },
      phase: r.phase !== 'opened' ? r.phase : r.plan ? 'approved' : r.answer?.accept ? 'awaiting-approval' : 'offered',
      ...(r.answer ? { answer: r.answer } : {}), settings: r.settings ?? {}, summary: r.summary ?? summarize(this.d.inventory, r.camera), plan: r.plan, budgetExceeded: r.budgetExceeded === true,
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
  cancel(id: string, copied: MoveCopied): { status: 202 | 404 | 409; body: object } {
    const r = this.source(id);
    if (!r) return { status: 404, body: { error: 'unknown_move' } };
    if (moveEnded(r.phase)) return { status: 409, body: { error: 'wrong_phase', phase: r.phase } };
    this.d.emit({ kind: 'move.cancel', moveId: id, copied });
    return { status: 202, body: {} };
  }

  // The expected leaf on this camera (P8), set by move.go, cleared by Task 10
  // (a cancel before the switch-over (B48), the end of the move).
  setExpectedLeaf(cam: string, fingerprint: string | null): boolean {
    const c = this.d.certs();
    if (!c) return false;
    c.setExpected(cam, fingerprint, { user: 'cams-admin' });
    return true;
  }

  // After every welcome (B2): the open move's phase again.
  reemit(current: { moveId: string; role: 'source' | 'target'; phase: string } | null): void {
    if (!current || current.phase === 'failed') return;
    this.d.emit({ kind: 'move.phase', moveId: current.moveId, role: current.role, phase: current.phase as Exclude<MoveRecord['phase'], 'failed'>, ok: true });
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
      'move.open': guard((a: MoveOpenArgs) => this.open(a)),
      'move.answer': guard((a: MoveAnswerArgs) => this.answer(a)),
      'move.go': guard((a: MoveGoArgs) => this.go(a)),
      'move.release': guard((a: MoveReleaseArgs) => this.release(a)),
    };
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
      tokenHash: a.tokenHash, requestId: a.requestId, actor: p.actor,
      summary: p.summary, settings: p.settings, cameraConnection: p.connection,
      ...(p.answer ? { answer: p.answer } : {}),
      chunks: {}, bytesDone: 0, startedAt: this.now(),
    };
    this.d.journal.save(r);
    p.moveId = a.moveId;
    this.phaseEvent(r);
    return ok();
  }

  private answer(a: MoveAnswerArgs): Done {
    const answer: MoveAnswer = { accept: a.accept, ...(a.reason !== undefined ? { reason: a.reason } : {}), ...(a.space !== undefined ? { space: a.space } : {}), ...(a.estimateS !== undefined ? { estimateS: a.estimateS } : {}) };
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
        this.rejected(r.id, r.camera, a);
        return ok();
      }
      r.answer = answer;
      r.peer.name = a.target.name;
      this.d.journal.save(r);
      return ok();
    }
    // Answered before an open (cams-admin refused it, or the target answered first): the pending request keeps it.
    const p = this.pending.get(a.requestId);
    if (!p || p.target !== a.target.proxyId || (p.moveId && p.moveId !== a.moveId)) return failed(p ? 'mismatch' : 'unknown_request');
    if (same(p.answer)) return ok();
    Object.assign(p, { answer, moveId: a.moveId, targetName: a.target.name });
    if (!a.accept) this.rejected(a.moveId, p.camera, a);
    return ok();
  }

  private rejected(moveId: string, cam: string, a: MoveAnswerArgs): void {
    this.d.audit.write({
      action: 'move-phase', category: ['configuration'], type: ['change'], outcome: 'failure',
      user: 'cams-admin', camera: cam,
      message: `Camera move ${moveId} (${cam} to ${a.target.name || a.target.proxyId}): rejected (${a.reason ?? 'no reason'})`,
      details: { moveId, camera: cam, source: this.self(), target: a.target.proxyId, role: 'source', phase: 'rejected', reason: a.reason ?? null },
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
    if (!this.d.certs()) return failed('no_site_ca');
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
      details: { moveId: r.id, camera: r.camera, source: this.self(), target: r.peer.proxyId, step: 'go', outcome: 'ok', leafFingerprint: a.expectedLeaf, publicKeyFingerprint: keyFingerprint(a.targetPublicKey), chunks: r.manifest.length },
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
