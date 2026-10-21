import { createHash, generateKeyPairSync } from 'crypto';
import type { AuditLog } from '../audit/audit-log';
import { bareHost, splitHost } from '../camera/http';
import type { CameraPasswordStore } from '../config/camera-passwords';
import { planOverrides, planUnset, writeOverridesFile, setPath, type Loaded } from '../config/load';
import type { MoveOfferArgs, MoveStartArgs } from '../fleet/command-args';
import type { Done, Handler } from '../fleet/commands';
import type { SiteCa } from '../tls/ca';
import { issueLeaf, leafOf, type Leaf } from '../tls/leaf';
import type { PushResult } from '../tls/push';
import { sourceGet } from './evaluate';
import { moveEnded, SWITCH_STEPS, type MoveJournal, type MoveRecord, type SwitchStep } from './journal';
import { unseal } from './seal';
import { logger } from '../log';
import type { MoveEvent, MovePhaseName, MovePlan, Space } from './types';

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
  journal: Pick<MoveJournal, 'load' | 'save' | 'active'>;
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
  // Task 9's copier starts here (after switched, P12); a no-op until then.
  startCopy?: (moveId: string) => void;
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
// A step that can't succeed by retrying (the move fails at once), with its detail.
class Refused extends Error {}

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
    r.phase = phase;
    if (code) r.failure = code;
    this.d.journal.save(r);
    if (phase === 'failed') this.d.emit({ kind: 'move.phase', moveId: r.id, role: 'target', phase: 'failed', ok: false, code: code ?? 'internal', ...(detail ? { detail } : {}) });
    else this.d.emit({ kind: 'move.phase', moveId: r.id, role: 'target', phase, ok: true });
    this.d.audit.write({
      action: 'move-phase', category: ['configuration'], type: ['change'], outcome: phase === 'failed' ? 'failure' : 'success',
      user: 'cams-admin', camera: r.camera,
      message: `Camera move ${r.id} (${r.camera} from ${r.peer.name || r.peer.proxyId}): ${phase}${code ? ` (${code})` : ''}`,
      details: this.details(r, { phase, ...(code ? { code } : {}), ...(detail ? { detail } : {}) }),
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
    const pair = generateKeyPairSync('x25519');
    const fresh = this.target(a.moveId) ?? r;
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

  // Ends the runner (Task 10's cancel, the process stop): the journal keeps the
  // step it was in. A step in flight finishes or fails first.
  async stop(moveId: string): Promise<void> {
    const run = this.runs.get(moveId);
    if (!run) return;
    run.stopped = true;
    run.wake?.();
    await run.done;
  }

  // The process stop: every runner told to stop; a step in flight (a push can
  // take a minute) is waited for at most `waitMs`, its result then not recorded.
  async stopAll(waitMs = 3000): Promise<void> {
    const all = Promise.all([...this.runs.keys()].map((id) => this.stop(id)));
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
        this.phase(r, 'failed', CODES[step], typeof outcome === 'object' && outcome ? outcome.refused : undefined);
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
    if (r.phase === 'copying') this.d.startCopy?.(r.id);
  }

  // One step with its retries: 'ok', 'skipped', 'failed' when it gave up, or
  // {refused} when retrying can't help (each audited once); null when stopped.
  private async attempt(run: Run, r: MoveRecord, step: SwitchStep): Promise<'ok' | 'skipped' | 'failed' | { refused: string } | null> {
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
          return { refused: err.message };
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
      this.d.passwords.set(r.camera, plain.toString('utf8'));
    } finally {
      plain.fill(0);
    }
    return { message: 'the camera password stored' };
  }

  // The camera node (the offer's connection and settings; the approved target
  // settings with plan.space retention), in one override write, live (P1). A
  // hidden `moved` leftover of this camera goes in the same write (B7).
  private async camera(r: MoveRecord): Promise<{ message: string; details: Record<string, unknown> }> {
    const c = r.cameraConnection;
    if (!c) throw new Error('the journal lacks the camera');
    const patch: Record<string, unknown> = {
      cameras: { [r.camera]: { name: c.name, host: c.host, protocol: c.protocol, user: c.user, onvifPort: c.onvifPort, rtspPort: c.rtspPort, baichuanPort: c.baichuanPort, ...(r.settings ?? {}) } },
    };
    const host = r.plan?.space === 'retention' && r.plan.targetSettings ? r.plan.targetSettings : {};
    for (const [path, v] of Object.entries(host)) setPath(patch, path, v);
    const loaded = this.d.loaded();
    // A camera of this id added here since the offer (not a hidden leftover, not this step's own earlier write): never overwritten.
    const existing = loaded.config.cameras[r.camera];
    if (existing && existing.moved === undefined && !r.cameraWritten) throw new Refused('id_taken');
    let plan = planOverrides(loaded, patch);
    const leftover = plan.next.config.cameras[r.camera]?.moved !== undefined;
    if (leftover) plan = planUnset(plan.next, [`cameras.${r.camera}.moved`]);
    r.cameraWritten = true;
    this.d.journal.save(r);
    writeOverridesFile(loaded.files.overrides, plan.overrides);
    await this.d.setLoaded(plan.next);
    return { message: `${r.camera} added${leftover ? ' (its hidden entry shown again)' : ''}${Object.keys(host).length ? `; target settings ${Object.keys(host).join(', ')}` : ''}`, details: { leftover, targetSettings: Object.keys(host).length ? host : null } };
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
