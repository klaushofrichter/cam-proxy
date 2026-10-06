import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
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
export interface CertCamera { id: string; address: string; protocol: 'https' | 'http'; tlsName?: string }
export interface CameraCertsDeps {
  dir: string; // <dataDir>/tls
  ca: () => SiteCa | null;
  site: () => string | undefined;
  enabled: () => boolean; // tls.cameraCerts
  cameras: () => CertCamera[];
  served: (id: string) => Promise<Served | null>; // the certificate the camera presents now (null: no answer)
  // One push (src/tls/push.ts); `issue` makes a fresh leaf for each attempt.
  push: (id: string, issue: () => Promise<Leaf>) => Promise<PushResult>;
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
const FAILED_RETRY_MS = HOUR; // a failed push (not a refusal) is tried again after an hour
const OUTCOMES = ['pushed', 'current', 'refused', 'failed'];
const MODES = ['site-ca', 'pinned', 'public', 'none'];

// What is kept per camera besides the public state (state.json).
interface Extra {
  everSiteCa: boolean; // the camera once served our leaf: a mismatch is never pushed to automatically
  pin: Served | null; // what the proxy itself pins (mode pinned)
  pendingRenewal: boolean; // a renewal the 04:00 window couldn't push (an open event): pushed when it ends
}
interface Stored extends CertState { everSiteCa?: boolean; pin?: Served | null }

// Each camera's certificate from the site CA (spec 2026-10-05-multi-camera-host-design
// §10.1.3, §10.4): issued, pushed and renewed one camera at a time. Leaf keys
// live in <dir>/cameras/<id>.key (600), only for a leaf the camera took, and
// never leave the proxy except in the push to their own camera.
//
// Trust (security review of #178): a camera that once served our leaf is
// never pushed to automatically when it serves something else (an impostor on
// the camera network would get the login and a key): it keeps the CA as its
// only trust, the health item says so, and an admin's "Push now" decides. A
// camera is `pinned` only to a certificate the proxy pins itself, and a
// site-CA camera becomes `pinned` only by an admin's push. Modes and pins
// survive a restart, so no worker logs in unverified when its trust was known.
export class CameraCerts {
  private readonly states = new Map<string, CertState>();
  private readonly extras = new Map<string, Extra>();
  private readonly leaves = new Map<string, Leaf>();
  private previousCa: string | null = null; // after tls-ca-rotate, until every camera serves a new leaf
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly d: CameraCertsDeps) {
    this.restore();
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }
  private blank(): CertState {
    return { mode: 'none', servername: null, fingerprint: null, notAfter: null, lastPush: null, problem: null };
  }
  private extra(id: string): Extra {
    let e = this.extras.get(id);
    if (!e) this.extras.set(id, (e = { everSiteCa: false, pin: null, pendingRenewal: false }));
    return e;
  }
  private camDir(): string {
    const dir = join(this.d.dir, 'cameras');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  // The CAs a camera's leaf may come from: the current one, and the previous one after a rotation.
  trustedCas(): string[] {
    const ca = this.d.ca();
    return [...(ca ? [ca.certPem] : []), ...(this.previousCa ? [this.previousCa] : [])];
  }
  // What a pinned camera's client pins (null otherwise).
  pin(id: string): Served | null {
    const e = this.extras.get(id);
    return this.states.get(id)?.mode === 'pinned' && e?.pin ? { ...e.pin } : null;
  }

  private restore(): void {
    let raw: { cameras?: Record<string, Stored>; previousCa?: unknown } = {};
    try {
      raw = JSON.parse(readFileSync(join(this.d.dir, 'cameras', 'state.json'), 'utf8'));
    } catch {
      return;
    }
    if (typeof raw.previousCa === 'string' && raw.previousCa.includes('BEGIN CERTIFICATE')) this.previousCa = raw.previousCa;
    const ca = this.d.ca();
    for (const [id, r] of Object.entries(raw.cameras ?? {})) {
      if (!r || typeof r !== 'object' || !MODES.includes(r.mode)) continue;
      const lastPush = r.lastPush && typeof r.lastPush.at === 'number' && OUTCOMES.includes(r.lastPush.outcome) ? { at: r.lastPush.at, outcome: r.lastPush.outcome } : null;
      const st: CertState = { ...this.blank(), lastPush, problem: typeof r.problem === 'string' ? r.problem : null };
      const leaf = this.load(id);
      const pin = r.pin && typeof r.pin.fingerprint === 'string' && typeof r.pin.pem === 'string' ? { fingerprint: r.pin.fingerprint, pem: r.pin.pem } : null;
      // site-ca only with a stored leaf of a trusted CA; pinned only with its pin.
      if (r.mode === 'site-ca' && ca && leaf && this.trustedCas().some((c) => issuedBy(leaf, { certPem: c }))) {
        Object.assign(st, { mode: 'site-ca', servername: typeof r.servername === 'string' ? r.servername : null, fingerprint: typeof r.fingerprint === 'string' ? r.fingerprint : leaf.fingerprint, notAfter: typeof r.notAfter === 'number' ? r.notAfter : leaf.notAfter });
      } else if (r.mode === 'pinned' && pin) {
        Object.assign(st, { mode: 'pinned', fingerprint: pin.fingerprint });
      }
      this.states.set(id, st);
      this.extras.set(id, { everSiteCa: r.everSiteCa === true, pin, pendingRenewal: false });
    }
  }
  private save(): void {
    const cameras = Object.fromEntries([...this.states].map(([id, s]) => [id, { ...s, everSiteCa: this.extras.get(id)?.everSiteCa ?? false, pin: this.extras.get(id)?.pin ?? null }]));
    const file = join(this.camDir(), 'state.json');
    writeFileSync(`${file}.tmp`, JSON.stringify({ cameras, previousCa: this.previousCa }), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  state(id: string): CertState {
    return { ...(this.states.get(id) ?? this.blank()) };
  }
  leaf(id: string): Leaf | null {
    return this.leaves.get(id) ?? this.load(id);
  }

  // A new CA (tls-ca-rotate): every leaf moved aside (<id>.crt|key.old-<stamp>)
  // and forgotten; the previous CA stays trusted until every camera serves a
  // leaf of the new one (they are pushed automatically: their sessions start
  // verified against it).
  reset(stamp: string, previousCa: string | null): void {
    const dir = join(this.d.dir, 'cameras');
    if (existsSync(dir)) for (const f of readdirSync(dir)) if (/^[a-z0-9-]+\.(crt|key)$/.test(f)) renameSync(join(dir, f), join(dir, `${f}.old-${stamp}`));
    this.leaves.clear();
    this.previousCa = previousCa;
    this.save();
    for (const id of this.states.keys()) this.d.onTrust?.(id);
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
      return null; // unreadable: a new one is issued
    }
  }

  // Only a leaf the camera took is stored (a key of a failed import is dropped).
  private store(id: string, l: Leaf): void {
    const dir = this.camDir();
    writeSecret(join(dir, `${id}.key`), l.keyPem);
    writeFileSync(join(dir, `${id}.crt`), l.certPem, { mode: 0o644 });
    this.leaves.set(id, l);
  }

  // A served certificate from a trusted CA that hasn't expired.
  private ours(s: Served, now: number): { notAfter: number } | null {
    try {
      const x = new X509Certificate(s.pem);
      const notAfter = Date.parse(x.validTo);
      if (notAfter <= now) return null;
      return this.trustedCas().some((c) => issuedBy({ certPem: s.pem }, { certPem: c })) ? { notAfter } : null;
    } catch {
      return null;
    }
  }

  private set(id: string, s: Partial<CertState>): CertState {
    const prev = this.states.get(id);
    const next = { ...(prev ?? this.blank()), ...s };
    this.states.set(id, next);
    if ((prev?.mode ?? 'none') !== next.mode || (s.fingerprint !== undefined && next.mode === 'pinned' && prev?.fingerprint !== next.fingerprint)) this.d.onTrust?.(id);
    return next;
  }

  // One thing at a time: a tick and a "Push now" never push to cameras together.
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.lock.then(fn, fn);
    this.lock = p.catch(() => undefined);
    return p;
  }

  // One pass over the cameras, one at a time (a second call joins the first).
  tick(): Promise<void> {
    this.running ??= this.exclusive(() => this.pass()).finally(() => (this.running = null));
    return this.running;
  }

  private async pass(): Promise<void> {
    let allOnCurrent = true;
    for (const cam of this.d.cameras()) {
      if (this.stopped) return;
      try {
        await this.one(cam, false);
      } catch (err) {
        logger.warn({ cameraId: cam.id, err: (err as Error).message }, 'camera_cert_check_failed');
      }
      const st = this.states.get(cam.id);
      if (st?.mode === 'site-ca' && st.fingerprint !== this.leaf(cam.id)?.fingerprint) allOnCurrent = false;
    }
    // Every site-CA camera serves a leaf of the current CA: the previous one is no longer trusted.
    if (this.previousCa && allOnCurrent) {
      this.previousCa = null;
      this.save();
      for (const id of this.states.keys()) this.d.onTrust?.(id);
    }
  }

  // The "Push now" action: no window, no back-off, still never during an open event.
  pushNow(id: string): Promise<PushResult> {
    return this.exclusive(async () => {
      const cam = this.d.cameras().find((c) => c.id === id);
      if (!cam) return { outcome: 'failed' as const, served: null, detail: 'no such camera', tookMs: 0 };
      return (await this.one(cam, true)) ?? { outcome: 'current' as const, served: this.state(id).fingerprint, tookMs: 0 };
    });
  }

  private async one(cam: CertCamera, manual: boolean): Promise<PushResult | null> {
    // Why nothing was pushed, for "Push now" (an automatic tick just moves on).
    const skip = (detail: string, served: string | null = null): PushResult | null => (manual ? { outcome: 'failed', served, detail, tookMs: 0 } : null);
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
    if (!ca || !site || !this.d.enabled()) {
      this.set(cam.id, { mode: 'none', servername: null, fingerprint: null, notAfter: null, problem: null });
      return skip(`${cam.id} has no site-CA certificate (camera certificates are off)`);
    }
    const name = `${cam.id}.${site}.internal`;
    if (!ca.covers(cam.address) || !ca.coversName(name)) {
      // Ruling P5-3: never a leaf the CA can't vouch for.
      const problem = `${ca.covers(cam.address) ? name : cam.address} is outside the site CA: rotate the CA (tls-ca-rotate)`;
      this.set(cam.id, { mode: 'none', servername: null, fingerprint: null, notAfter: null, problem });
      return skip(problem);
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
      const due = renewalDue(stored, now);
      if (!due || !(inWindow || manual || e.pendingRenewal)) {
        // Serving the leaf clears an earlier failed or refused push (the health item, Ruling P5-9), unless a renewal is still due.
        const stale = !due && last && last.outcome !== 'pushed' && last.outcome !== 'current';
        e.everSiteCa = true;
        this.set(cam.id, { mode: 'site-ca', servername: name, fingerprint: stored.fingerprint, notAfter: stored.notAfter, problem: null, ...(stale ? { lastPush: { at: now, outcome: 'current' as const } } : {}) });
        this.save();
        return manual ? { outcome: 'current', served: served.fingerprint, tookMs: 0 } : null;
      }
      renewal = true;
    } else {
      const ours = this.ours(served, now);
      if (ours) {
        // Our leaf, not the stored one (a new address, the previous CA, lost files):
        // trusted as it is; the push starts on a session verified against the CA.
        e.everSiteCa = true;
        this.set(cam.id, { mode: 'site-ca', servername: name, fingerprint: served.fingerprint, notAfter: ours.notAfter, problem: null });
      } else if (e.everSiteCa && !manual) {
        // Never an automatic push to a camera that served our leaf and now serves something else.
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
    if (this.d.openEvent(cam.id)) {
      if (renewal && inWindow) e.pendingRenewal = true; // never during an event: when it ends (Review Focus 1)
      return skip('an event is open: try again when it has ended', served.fingerprint);
    }
    const r = await this.d.push(cam.id, () => issueLeaf(ca, { cn: name, dns: [name], ips: [cam.address] }));
    e.pendingRenewal = false;
    const lastPush = { at: now, outcome: r.outcome };
    if ((r.outcome === 'pushed' || r.outcome === 'current') && r.leaf) {
      this.store(cam.id, r.leaf as Leaf);
      e.everSiteCa = true;
      e.pin = null;
      this.set(cam.id, { mode: 'site-ca', servername: name, fingerprint: r.leaf.fingerprint, notAfter: r.leaf.notAfter, lastPush, problem: null });
    } else if (r.outcome === 'refused' && (!e.everSiteCa || manual) && r.served && r.servedPem) {
      // The fallback (spec §10.1.4): the proxy pins what the camera serves, and cams pins the same.
      e.pin = { fingerprint: r.served, pem: r.servedPem };
      this.set(cam.id, { mode: 'pinned', servername: null, fingerprint: r.served, notAfter: null, lastPush, problem: null });
    } else {
      // A failure, or a refusal of a camera that served our leaf (automatic): the trust stays as it is.
      this.set(cam.id, { lastPush, problem: r.outcome === 'failed' ? `push failed: ${r.detail ?? 'unknown'}` : null });
    }
    this.save();
    this.d.onPush?.(cam.id, r.outcome);
    this.d.audit?.write({
      action: 'camera-cert-push',
      category: ['configuration'],
      type: ['change'],
      outcome: r.outcome === 'pushed' || r.outcome === 'current' ? 'success' : 'failure',
      user: manual ? 'admin' : 'system',
      camera: cam.id,
      message: `Camera certificate ${r.outcome} (${cam.id}, ${Math.round(r.tookMs / 1000)} s)${this.states.get(cam.id)?.mode === 'pinned' && r.outcome === 'refused' ? `: pinned to ${r.served}` : ''}`,
      details: { served: r.served, ...(r.leaf ? { leaf: r.leaf.fingerprint, notAfter: r.leaf.notAfter } : {}), ...(r.detail ? { detail: r.detail } : {}) },
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
