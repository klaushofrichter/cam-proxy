import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync, writeSync } from 'fs';
import { join } from 'path';
import type { AuditLog } from '../audit/audit-log';
import { logger } from '../log';
import { writeSecret, type SiteCa } from './ca';
import { X509Certificate } from 'crypto';
import { issuedBy, issueLeaf, leafOf, renewalDue, type Leaf } from './leaf';
import type { PushOutcome, PushResult } from './push';
import type { Served } from './served';

export type CertMode = 'site-ca' | 'pinned' | 'public' | 'none';
export interface CertState {
  mode: CertMode;
  servername: string | null;
  fingerprint: string | null;
  notAfter: number | null;
  lastPush: { at: number; outcome: PushOutcome } | null;
  problem: string | null;
}
// tls-ca-rotate while another rotation runs.
export class RotateBusyError extends Error {}

// GET /control/tls (the Certificates card); the key never.
export interface TlsView {
  site: string | null;
  caFingerprint: string | null;
  caNotAfter: number | null;
  proxy: { servername: string; fingerprint: string; notAfter: number } | null;
  cameras: (CertState & { id: string })[];
  problems: string[];
}
// Who asked for an admin action (the audit record names them).
export interface Requester { user: string; ip?: string; userAgent?: string; requestedBy?: string }
export interface CertCamera { id: string; address: string; protocol: 'https' | 'http'; tlsName?: string }
export interface CameraCertsDeps {
  dir: string; // <dataDir>/tls
  ca: () => SiteCa | null;
  // The CA certificate to trust while ca() is not usable (its key missing): trust only, never issuing.
  caPem?: () => string | null;
  site: () => string | undefined;
  enabled: () => boolean; // tls.cameraCerts
  cameras: () => CertCamera[];
  served: (id: string) => Promise<Served | null>; // the certificate the camera presents now (null: no answer)
  // One push (src/tls/push.ts); `issue` makes a fresh leaf for each attempt.
  // `factory`: the certificate the camera served after an earlier clear (expected after the next one).
  push: (id: string, issue: () => Promise<Leaf>, o?: { factory?: string }) => Promise<PushResult>;
  openEvent: (id: string) => boolean;
  localHour: (now: number, id: string) => number; // camera time
  // A camera's trust changed (mode, pin, or the CAs): its client follows.
  onTrust?: (id: string) => void;
  audit?: Pick<AuditLog, 'write'>;
  onPush?: (id: string, outcome: PushOutcome) => void; // metrics
  now?: () => number;
}

const WINDOW_HOUR = 4; // renewals and retries after a refusal: 04:00 camera time
const HOUR = 3600_000;
const DAY = 86400_000;
const FAILED_RETRY_MS = HOUR; // a failed first push is tried again after an hour
const PREVIOUS_CA_DAYS = 30; // the previous CA after a rotation: trusted at most this long
const OUTCOMES = ['pushed', 'current', 'refused', 'failed'];
const MODES = ['site-ca', 'pinned', 'public', 'none'];
const CORRUPT = 'the camera certificate state (data/tls/cameras/state.json) is unreadable: no automatic pushes; check each camera, then Push now';

// What is kept per camera besides the public state (state.json).
interface Extra {
  everSiteCa: boolean; // the camera once served our leaf: a mismatch is never pushed to automatically
  pin: Served | null; // what the proxy itself pins (mode pinned)
  pendingRenewal: boolean; // a renewal the 04:00 window couldn't push (an open event): pushed when it ends
  onPrevious: boolean; // serves a leaf of the previous CA (after a rotation)
  factory: string | null; // the certificate seen after a CertificateClear: expected after the next one
  // No automatic push until an admin pushes to (or clears) this camera: 'unreadable' (state.json was), 'cleared' (camera-trust-clear).
  blocked: 'unreadable' | 'cleared' | null;
}
interface Stored extends CertState { everSiteCa?: boolean; pin?: Served | null; onPrevious?: boolean; factory?: string | null; blocked?: string | null }
const BLOCKED = { unreadable: (id: string) => `${id}: no automatic push since the certificate state was unreadable: check the camera, then Push now`, cleared: (id: string) => `${id}: its trust was cleared: Push now to push its first certificate` };

// Each camera's certificate from the site CA (spec 2026-10-05-multi-camera-host-design
// §10.1.3, §10.4): issued, pushed and renewed one camera at a time. Leaf keys
// live in <dir>/cameras/<id>.key (600), only for a leaf the camera took, and
// never leave the proxy except in the push to their own camera.
//
// Trust (security reviews of #178), failing closed:
// - A camera that once served our leaf, or a pinned camera, is never pushed
//   to automatically when it serves another certificate: it keeps its trust
//   (so the proxy refuses it), the health item says so, and an admin's "Push
//   now" decides. Only a first use (a camera never seen with our leaf) is
//   pushed to automatically, bound to what it serves at that moment.
// - `pinned` is a certificate the proxy pins itself; a site-CA camera becomes
//   pinned only by an admin's push. A known trust is never dropped to an
//   unverified one (certificates off, an address outside the CA, a CA that
//   can't be loaded): only the admin's camera-trust-clear does that, audited.
// - Modes, pins and the previous CA survive a restart; a stored or old leaf
//   on disk means the camera served our leaf even without state.json; an
//   unreadable state.json stops every automatic push.
// - After a rotation the previous CA is trusted only for the cameras still
//   serving its leaf, at most 30 days (or until the admin drops it).
export class CameraCerts {
  private readonly states = new Map<string, CertState>();
  private readonly extras = new Map<string, Extra>();
  private readonly leaves = new Map<string, Leaf>();
  private previousCa: string | null = null;
  private previousSince = 0;
  private corrupt = false;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly d: CameraCertsDeps) {
    this.restore();
    // An unreadable state: every camera configured now waits for its own admin push.
    if (this.corrupt) for (const c of this.d.cameras()) this.extra(c.id);
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }
  private blank(): CertState {
    return { mode: 'none', servername: null, fingerprint: null, notAfter: null, lastPush: null, problem: null };
  }
  private camDir(): string {
    const dir = join(this.d.dir, 'cameras');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  // A leaf exists only after a push the camera took: the stored one, or one moved aside by a rotation.
  private hadLeaf(id: string): boolean {
    const dir = join(this.d.dir, 'cameras');
    if (existsSync(join(dir, `${id}.crt`))) return true;
    try {
      return readdirSync(dir).some((f) => f.startsWith(`${id}.crt.old-`));
    } catch {
      return false;
    }
  }
  private extra(id: string): Extra {
    let e = this.extras.get(id);
    if (!e) this.extras.set(id, (e = { everSiteCa: this.hadLeaf(id), pin: null, pendingRenewal: false, onPrevious: false, factory: null, blocked: this.corrupt ? 'unreadable' : null }));
    return e;
  }

  private currentCaPem(): string | null {
    return this.d.ca()?.certPem ?? this.d.caPem?.() ?? null;
  }
  // The CAs a camera's leaf may come from: the current one, and the previous one
  // for a camera still serving its leaf (all of them without a camera).
  trustedCas(id?: string): string[] {
    const cur = this.currentCaPem();
    const prev = this.previousCa && (id === undefined || this.extras.get(id)?.onPrevious) ? [this.previousCa] : [];
    return [...(cur ? [cur] : []), ...prev];
  }
  // What a pinned camera's client pins (null otherwise).
  pin(id: string): Served | null {
    const e = this.extras.get(id);
    return this.states.get(id)?.mode === 'pinned' && e?.pin ? { ...e.pin } : null;
  }
  // Whether the camera ever served our leaf (its client never falls back to unverified).
  everServed(id: string): boolean {
    return this.extra(id).everSiteCa;
  }
  factory(id: string): string | null {
    return this.extras.get(id)?.factory ?? null;
  }
  // Host-level problems for the health item: an unreadable state, cameras on the previous CA.
  problems(): string[] {
    const until = new Date(this.previousSince + PREVIOUS_CA_DAYS * DAY).toISOString().slice(0, 10);
    const lagging = this.previousCa ? [...this.states].filter(([id, st]) => st.mode === 'site-ca' && this.extras.get(id)?.onPrevious).map(([id]) => `${id} still serves a leaf of the previous CA (trusted until ${until})`) : [];
    return [...(this.corrupt ? [CORRUPT] : []), ...lagging];
  }

  private restore(): void {
    const file = join(this.d.dir, 'cameras', 'state.json');
    let raw: { cameras?: Record<string, Stored>; previousCa?: unknown; previousSince?: unknown } = {};
    if (existsSync(file)) {
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
        if (!raw || typeof raw !== 'object') throw new Error('not an object');
      } catch {
        this.corrupt = true;
        raw = {};
      }
    }
    if (typeof raw.previousCa === 'string' && raw.previousCa.includes('BEGIN CERTIFICATE')) {
      this.previousCa = raw.previousCa;
      this.previousSince = typeof raw.previousSince === 'number' ? raw.previousSince : 0; // unknown: dropped at the next pass
    }
    const ids = new Set(Object.keys(raw.cameras ?? {}));
    try {
      for (const f of readdirSync(join(this.d.dir, 'cameras'))) {
        const m = /^([a-z0-9-]+)\.crt$/.exec(f);
        if (m) ids.add(m[1]);
      }
    } catch {
      // no cameras folder yet
    }
    const cas = this.trustedCas();
    for (const id of ids) {
      const r = raw.cameras?.[id];
      if (r !== undefined && (!r || typeof r !== 'object' || !MODES.includes(r.mode))) this.corrupt = true;
      const ok = r && typeof r === 'object' && MODES.includes(r.mode) ? r : undefined;
      const lastPush = ok?.lastPush && typeof ok.lastPush.at === 'number' && OUTCOMES.includes(ok.lastPush.outcome) ? { at: ok.lastPush.at, outcome: ok.lastPush.outcome } : null;
      const st: CertState = { ...this.blank(), lastPush, problem: typeof ok?.problem === 'string' ? ok.problem : null };
      const leaf = this.load(id);
      const pin = ok?.pin && typeof ok.pin.fingerprint === 'string' && typeof ok.pin.pem === 'string' ? { fingerprint: ok.pin.fingerprint, pem: ok.pin.pem } : null;
      const onPrevious = ok?.onPrevious === true && !!this.previousCa;
      // A stored leaf of a trusted CA (or of no known CA: our own file) → site-ca, also without state.json.
      const leafTrusted = leaf && (cas.length === 0 || cas.some((c) => issuedBy(leaf, { certPem: c })));
      if (ok?.mode === 'pinned' && pin) {
        Object.assign(st, { mode: 'pinned', fingerprint: pin.fingerprint });
      } else if ((ok?.mode === 'site-ca' || !ok) && leafTrusted) {
        const site = this.d.site();
        Object.assign(st, { mode: 'site-ca', servername: (typeof ok?.servername === 'string' ? ok.servername : null) ?? (site ? `${id}.${site}.internal` : (leaf.names[0] ?? null)), fingerprint: leaf.fingerprint, notAfter: leaf.notAfter });
      } else if (ok?.mode === 'site-ca' && onPrevious && typeof ok.servername === 'string' && typeof ok.fingerprint === 'string') {
        Object.assign(st, { mode: 'site-ca', servername: ok.servername, fingerprint: ok.fingerprint, notAfter: typeof ok.notAfter === 'number' ? ok.notAfter : null });
      }
      this.states.set(id, st);
      const blocked = ok?.blocked === 'unreadable' || ok?.blocked === 'cleared' ? ok.blocked : this.corrupt ? 'unreadable' : null;
      this.extras.set(id, { everSiteCa: ok?.everSiteCa === true || this.hadLeaf(id), pin, pendingRenewal: false, onPrevious, factory: typeof ok?.factory === 'string' ? ok.factory : null, blocked });
    }
  }
  private save(): void {
    const cameras = Object.fromEntries(
      [...this.states].map(([id, s]) => {
        const e = this.extras.get(id);
        return [id, { ...s, everSiteCa: e?.everSiteCa ?? false, pin: e?.pin ?? null, onPrevious: e?.onPrevious ?? false, factory: e?.factory ?? null, blocked: e?.blocked ?? null }];
      }),
    );
    const file = join(this.camDir(), 'state.json');
    const tmp = `${file}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify({ cameras, previousCa: this.previousCa, previousSince: this.previousCa ? this.previousSince : null }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  }

  state(id: string): CertState {
    return { ...(this.states.get(id) ?? this.blank()) };
  }
  leaf(id: string): Leaf | null {
    return this.leaves.get(id) ?? this.load(id);
  }

  private audit(id: string | null, outcome: 'success' | 'failure', message: string, who?: Requester, details: Record<string, unknown> = {}): void {
    this.d.audit?.write({
      action: 'camera-trust',
      category: ['configuration'],
      type: ['change'],
      outcome,
      user: who?.user ?? 'system',
      ...(who?.ip ? { ip: who.ip } : {}),
      ...(who?.userAgent ? { userAgent: who.userAgent } : {}),
      ...(id ? { camera: id } : {}),
      message,
      details: { ...details, ...(who?.requestedBy ? { requestedBy: who.requestedBy } : {}) },
    });
  }

  // A new CA (tls-ca-rotate): every leaf moved aside (<id>.crt|key.old-<stamp>)
  // and forgotten; the previous CA stays trusted for the cameras still serving
  // its leaf (they are pushed automatically: their sessions start verified
  // against it), at most 30 days.
  reset(stamp: string, previousCa: string | null): void {
    const dir = join(this.d.dir, 'cameras');
    if (existsSync(dir)) for (const f of readdirSync(dir)) if (/^[a-z0-9-]+\.(crt|key)$/.test(f)) renameSync(join(dir, f), join(dir, `${f}.old-${stamp}`));
    this.leaves.clear();
    this.previousCa = previousCa;
    this.previousSince = this.now();
    for (const [id, st] of this.states) this.extra(id).onPrevious = !!previousCa && st.mode === 'site-ca';
    this.save();
    for (const id of this.states.keys()) this.d.onTrust?.(id);
  }

  // An unreadable state is over once no camera waits for its admin push any more
  // (the health item clears; a camera added later starts as a first use).
  private settleCorrupt(): void {
    if (this.corrupt && ![...this.extras.values()].some((e) => e.blocked === 'unreadable')) this.corrupt = false;
  }

  // The admin's "drop the previous CA" (tls-ca-drop-previous); false when there is none.
  dropPreviousCa(who: Requester): boolean {
    if (!this.previousCa) return false;
    this.dropPrevious('Previous site CA dropped by the admin', who);
    return true;
  }
  private dropPrevious(message: string, who?: Requester): void {
    const lagging = [...this.extras].filter(([, e]) => e.onPrevious).map(([id]) => id);
    this.previousCa = null;
    for (const e of this.extras.values()) e.onPrevious = false;
    this.save();
    this.audit(null, 'success', message, who, { lagging });
    for (const id of this.states.keys()) this.d.onTrust?.(id);
  }

  // The admin's camera-trust-clear: the camera back to first use (its leaf moved
  // aside, no pin), audited. The next push to it trusts what it serves then.
  clearTrust(id: string, who: Requester): CertState {
    const prev = this.state(id);
    const dir = join(this.d.dir, 'cameras');
    const stamp = String(this.now());
    for (const f of [`${id}.crt`, `${id}.key`]) if (existsSync(join(dir, f))) renameSync(join(dir, f), join(dir, `${f}.cleared-${stamp}`));
    if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.startsWith(`${id}.crt.old-`) || f.startsWith(`${id}.key.old-`)) renameSync(join(dir, f), join(dir, f.replace('.old-', '.cleared-old-')));
    this.leaves.delete(id);
    const e = this.extra(id);
    const factory = e.factory;
    // Back to first use, but the first push is the admin's: no automatic one.
    Object.assign(e, { everSiteCa: false, pin: null, pendingRenewal: false, onPrevious: false, factory: null, blocked: 'cleared' });
    this.states.set(id, { ...this.blank(), lastPush: prev.lastPush, problem: BLOCKED.cleared(id) });
    this.settleCorrupt();
    this.save();
    this.audit(id, 'success', `Camera trust cleared (${id}): ${prev.mode} → none`, who, { from: prev.mode, fingerprint: prev.fingerprint, factory });
    this.d.onTrust?.(id);
    return this.state(id);
  }

  private load(id: string): Leaf | null {
    const crt = join(this.d.dir, 'cameras', `${id}.crt`);
    const key = join(this.d.dir, 'cameras', `${id}.key`);
    if (!existsSync(crt) || !existsSync(key)) return null;
    try {
      const l = leafOf(readFileSync(crt, 'utf8'), readFileSync(key, 'utf8'));
      this.leaves.set(id, l);
      return l;
    } catch {
      return null;
    }
  }

  // Only a leaf the camera took is stored (a key of a failed import is dropped).
  private store(id: string, l: Leaf): void {
    const dir = this.camDir();
    writeSecret(join(dir, `${id}.key`), l.keyPem);
    writeFileSync(join(dir, `${id}.crt`), l.certPem, { mode: 0o644 });
    this.leaves.set(id, l);
  }

  // A served certificate from a trusted CA, unexpired, for this camera's name.
  private ours(id: string, s: Served, now: number, name: string): { notAfter: number; previous: boolean } | null {
    try {
      const x = new X509Certificate(s.pem);
      const notAfter = Date.parse(x.validTo);
      if (notAfter <= now) return null;
      if (!leafOf(s.pem, '').names.includes(name)) return null;
      const cur = this.currentCaPem();
      if (cur && issuedBy({ certPem: s.pem }, { certPem: cur })) return { notAfter, previous: false };
      if (this.previousCa && this.extra(id).onPrevious && issuedBy({ certPem: s.pem }, { certPem: this.previousCa })) return { notAfter, previous: true };
      return null;
    } catch {
      return null;
    }
  }

  private set(id: string, s: Partial<CertState>): CertState {
    const prev = this.states.get(id);
    const next = { ...(prev ?? this.blank()), ...s };
    this.states.set(id, next);
    const from = prev?.mode ?? 'none';
    const pinChanged = s.fingerprint !== undefined && next.mode === 'pinned' && prev?.fingerprint !== next.fingerprint;
    if (from !== next.mode || pinChanged) {
      this.audit(id, 'success', `Camera trust ${id}: ${from} → ${next.mode}${next.mode === 'pinned' ? ` (${next.fingerprint})` : next.mode === 'site-ca' ? ` (${next.servername})` : ''}`, undefined, { from, to: next.mode, fingerprint: next.fingerprint });
      this.d.onTrust?.(id);
    }
    return next;
  }

  // One thing at a time: a tick and a "Push now" never push to cameras together.
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.lock.then(fn, fn);
    this.lock = p.catch(() => undefined);
    return p;
  }

  tick(): Promise<void> {
    this.running ??= this.exclusive(() => this.pass()).finally(() => (this.running = null));
    return this.running;
  }

  private async pass(): Promise<void> {
    // The window never grows: a clock before the rotation (or an unknown rotation time) ends it too.
    if (this.previousCa && (!this.previousSince || this.now() < this.previousSince)) this.dropPrevious('Previous site CA no longer trusted (the clock is before the rotation)');
    else if (this.previousCa && this.now() - this.previousSince >= PREVIOUS_CA_DAYS * DAY) this.dropPrevious(`Previous site CA no longer trusted (${PREVIOUS_CA_DAYS} days after the rotation)`);
    for (const cam of this.d.cameras()) {
      if (this.stopped) return;
      try {
        await this.one(cam, false);
      } catch (err) {
        logger.warn({ cameraId: cam.id, err: (err as Error).message }, 'camera_cert_check_failed');
      }
    }
    // No camera on the previous CA's leaf any more: it is no longer trusted.
    if (this.previousCa && ![...this.extras.values()].some((e) => e.onPrevious)) this.dropPrevious('Previous site CA no longer trusted (every camera serves a leaf of the new one)');
  }

  // The "Push now" action: no window, no back-off, still never during an open event.
  pushNow(id: string, who?: Requester): Promise<PushResult> {
    return this.exclusive(async () => {
      const cam = this.d.cameras().find((c) => c.id === id);
      if (!cam) return { outcome: 'failed' as const, served: null, detail: 'no such camera', tookMs: 0 };
      return (await this.one(cam, true, who ?? { user: 'admin' })) ?? { outcome: 'current' as const, served: this.state(id).fingerprint, tookMs: 0 };
    });
  }

  private async one(cam: CertCamera, manual: boolean, who?: Requester): Promise<PushResult | null> {
    // Why nothing was pushed: for "Push now", an answer and an audit record.
    const skip = (detail: string, served: string | null = null): PushResult | null => {
      if (!manual) return null;
      this.d.audit?.write({ action: 'camera-cert-push', category: ['configuration'], type: ['change'], outcome: 'failure', user: who?.user ?? 'admin', ...(who?.ip ? { ip: who.ip } : {}), ...(who?.userAgent ? { userAgent: who.userAgent } : {}), camera: cam.id, message: `Camera certificate push not done (${cam.id}): ${detail}`, details: { detail, ...(who?.requestedBy ? { requestedBy: who.requestedBy } : {}) } });
      return { outcome: 'failed', served, detail, tookMs: 0 };
    };
    const known = (): boolean => ['site-ca', 'pinned'].includes(this.states.get(cam.id)?.mode ?? 'none');
    // A known trust stays (never dropped to unverified); the reason is the camera's problem.
    const keepOr = (problem: string | null, why: string): PushResult | null => {
      if (known()) this.set(cam.id, { problem: problem ?? why });
      else this.set(cam.id, { mode: 'none', servername: null, fingerprint: null, notAfter: null, problem });
      return skip(problem ?? why);
    };
    const ca = this.d.ca();
    const site = this.d.site();
    if (cam.protocol !== 'https') {
      this.set(cam.id, { mode: 'none', servername: null, fingerprint: null, notAfter: null, problem: null });
      return skip(`${cam.id} has no site-CA certificate (http)`);
    }
    if (cam.tlsName) {
      const s = await this.d.served(cam.id);
      this.set(cam.id, { mode: 'public', servername: cam.tlsName, fingerprint: s?.fingerprint ?? null, notAfter: null, problem: null });
      return skip(`${cam.id} has no site-CA certificate (verified by its public name ${cam.tlsName})`);
    }
    if (!site) return keepOr(null, `tls.site is not set: ${cam.id} keeps its trust; nothing is pushed`);
    if (!this.d.enabled()) return keepOr(null, `camera certificates are off (tls.cameraCerts): ${cam.id} keeps its trust; nothing is pushed`);
    if (!ca) return keepOr(null, `the site CA is not available: ${cam.id} keeps its trust; nothing is pushed`);
    const name = `${cam.id}.${site}.internal`;
    if (!ca.covers(cam.address) || !ca.coversName(name)) {
      // Ruling P5-3: never a leaf the CA can't vouch for.
      return keepOr(`${ca.covers(cam.address) ? name : cam.address} is outside the site CA: rotate the CA (tls-ca-rotate)`, '');
    }
    const now = this.now();
    const inWindow = this.d.localHour(now, cam.id) === WINDOW_HOUR;
    const e = this.extra(cam.id);
    let stored = this.leaf(cam.id);
    if (stored && (!stored.ips.includes(cam.address) || !stored.names.includes(name) || !issuedBy(stored, ca))) stored = null;
    const served = await this.d.served(cam.id);
    if (!served) return skip('the camera does not answer on HTTPS'); // unreachable: nothing to push to
    const s = this.states.get(cam.id);
    const last = s?.lastPush;
    let renewal = false;
    if (stored && served.fingerprint === stored.fingerprint) {
      e.onPrevious = false;
      const due = renewalDue(stored, now);
      if (!due || !(inWindow || manual || e.pendingRenewal)) {
        // Serving the leaf clears an earlier failed or refused push (Ruling P5-9), unless a renewal is still due.
        const stale = !due && last && last.outcome !== 'pushed' && last.outcome !== 'current';
        e.everSiteCa = true;
        this.set(cam.id, { mode: 'site-ca', servername: name, fingerprint: stored.fingerprint, notAfter: stored.notAfter, problem: null, ...(stale ? { lastPush: { at: now, outcome: 'current' as const } } : {}) });
        this.save();
        return manual ? { outcome: 'current', served: served.fingerprint, tookMs: 0 } : null;
      }
      renewal = true;
    } else {
      const ours = this.ours(cam.id, served, now, name);
      if (ours) {
        // Our leaf for this camera, not the stored one (a new address, the previous CA, lost files): the push starts verified.
        e.everSiteCa = true;
        e.onPrevious = ours.previous;
        this.set(cam.id, { mode: 'site-ca', servername: name, fingerprint: served.fingerprint, notAfter: ours.notAfter, problem: null });
      } else if (!manual && (e.everSiteCa || (e.pin && served.fingerprint !== e.pin.fingerprint))) {
        // Never an automatic push to a camera that served our leaf, or a pinned one, now serving something else.
        const problem = `${cam.id} serves an unexpected certificate (${served.fingerprint}): check the camera, then Push now`;
        if (s?.problem !== problem) logger.warn({ cameraId: cam.id, served: served.fingerprint }, 'camera_cert_unexpected');
        this.set(cam.id, { problem });
        this.save();
        return null;
      } else if (!manual) {
        // Ruling P5-6: after a refusal, the next try is the next 04:00 window (once in it); a failure: an hour later.
        if (last?.outcome === 'refused' && (!inWindow || now - last.at < HOUR)) return null;
        if (last?.outcome === 'failed' && now - last.at < FAILED_RETRY_MS) return null;
      }
    }
    if (e.blocked && !manual) {
      // After an unreadable state or a clear: only the admin pushes to this camera.
      this.set(cam.id, { problem: BLOCKED[e.blocked](cam.id) });
      this.save();
      return null;
    }
    if (this.d.openEvent(cam.id)) {
      if (renewal && inWindow) e.pendingRenewal = true; // never during an event: when it ends (Review Focus 1)
      return skip('an event is open: try again when it has ended', served.fingerprint);
    }
    const r = await this.d.push(cam.id, () => issueLeaf(ca, { cn: name, dns: [name], ips: [cam.address] }), e.factory ? { factory: e.factory } : {});
    e.pendingRenewal = false;
    if (r.clearedTo && !e.factory) e.factory = r.clearedTo;
    const lastPush = { at: now, outcome: r.outcome };
    if ((r.outcome === 'pushed' || r.outcome === 'current') && r.leaf) {
      this.store(cam.id, r.leaf as Leaf);
      Object.assign(e, { everSiteCa: true, pin: null, onPrevious: false, blocked: null });
      this.set(cam.id, { mode: 'site-ca', servername: name, fingerprint: r.leaf.fingerprint, notAfter: r.leaf.notAfter, lastPush, problem: null });
    } else if (r.outcome === 'refused' && (!e.everSiteCa || manual) && r.served && r.servedPem) {
      // The fallback (spec §10.1.4): the proxy pins what the camera serves, and cams pins the same.
      e.pin = { fingerprint: r.served, pem: r.servedPem };
      if (manual) e.blocked = null; // the pin is the admin's decision
      this.set(cam.id, { mode: 'pinned', servername: null, fingerprint: r.served, notAfter: null, lastPush, problem: null });
    } else {
      // A failure, or a refusal of a camera that served our leaf (automatic): the trust stays as it is.
      this.set(cam.id, { lastPush, problem: r.outcome === 'failed' ? `push failed: ${r.detail ?? 'unknown'}` : null });
    }
    this.settleCorrupt();
    this.save();
    this.d.onPush?.(cam.id, r.outcome);
    this.d.audit?.write({
      action: 'camera-cert-push',
      category: ['configuration'],
      type: ['change'],
      outcome: r.outcome === 'pushed' || r.outcome === 'current' ? 'success' : 'failure',
      user: manual ? (who?.user ?? 'admin') : 'system',
      ...(who?.ip ? { ip: who.ip } : {}),
      ...(who?.userAgent ? { userAgent: who.userAgent } : {}),
      camera: cam.id,
      message: `Camera certificate ${r.outcome} (${cam.id}, ${Math.round(r.tookMs / 1000)} s)${this.states.get(cam.id)?.mode === 'pinned' && r.outcome === 'refused' ? `: pinned to ${r.served}` : ''}`,
      details: { served: r.served, ...(r.leaf ? { leaf: r.leaf.fingerprint, notAfter: r.leaf.notAfter } : {}), ...(r.detail ? { detail: r.detail } : {}), ...(who?.requestedBy ? { requestedBy: who.requestedBy } : {}) },
    });
    return r;
  }

  start(everyMs = 600_000): void {
    this.stopped = false;
    const t = () => {
      void this.tick().finally(() => {
        if (this.stopped) return;
        this.timer = setTimeout(t, everyMs);
        this.timer.unref();
      });
    };
    this.timer = setTimeout(t, 30_000);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
