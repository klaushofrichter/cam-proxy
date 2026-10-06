import { X509Certificate } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AuditLog } from '../audit/audit-log';
import { logger } from '../log';
import { writeSecret, type SiteCa } from './ca';
import { issueLeaf, leafOf, renewalDue, type Leaf } from './leaf';
import type { PushOutcome, PushResult } from './push';

export type CertMode = 'site-ca' | 'pinned' | 'public' | 'none';
export interface CertState {
  mode: CertMode;
  servername: string | null;
  fingerprint: string | null;
  notAfter: number | null;
  lastPush: { at: number; outcome: PushOutcome } | null;
  problem: string | null;
}
export interface CertCamera { id: string; address: string; protocol: 'https' | 'http'; tlsName?: string }
export interface CameraCertsDeps {
  dir: string; // <dataDir>/tls
  ca: () => SiteCa | null;
  site: () => string | undefined;
  enabled: () => boolean; // tls.cameraCerts
  cameras: () => CertCamera[];
  served: (id: string) => Promise<string | null>; // the leaf the camera presents now (null: no answer)
  push: (id: string, leaf: Leaf) => Promise<PushResult>;
  openEvent: (id: string) => boolean;
  localHour: (now: number) => number; // camera time
  onSiteCa?: (id: string) => void; // the camera serves its leaf now: its client switches to the CA
  audit?: Pick<AuditLog, 'write'>;
  onPush?: (id: string, outcome: PushOutcome) => void; // metrics
  now?: () => number;
}

const WINDOW_HOUR = 4; // renewals and retries after a refusal: 04:00 camera time
const HOUR = 3600_000;
const FAILED_RETRY_MS = HOUR; // a failed push (not a refusal) is tried again after an hour

// Each camera's certificate from the site CA (spec 2026-10-05-multi-camera-host-design
// §10.1.3, §10.4): issued, pushed and renewed one camera at a time. Leaf keys
// live in <dir>/cameras/<id>.key (600) and never leave the proxy except in the
// push to their own camera.
export class CameraCerts {
  private readonly states = new Map<string, CertState>();
  private readonly leaves = new Map<string, Leaf>();
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly d: CameraCertsDeps) {
    for (const [id, lastPush] of Object.entries(this.readState())) this.states.set(id, { ...this.blank(), lastPush });
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
  private readState(): Record<string, CertState['lastPush']> {
    try {
      const raw = JSON.parse(readFileSync(join(this.d.dir, 'cameras', 'state.json'), 'utf8')) as Record<string, unknown>;
      const ok = (v: unknown): v is CertState['lastPush'] =>
        v === null || (typeof v === 'object' && typeof (v as { at?: unknown }).at === 'number' && ['pushed', 'current', 'refused', 'failed'].includes(String((v as { outcome?: unknown }).outcome)));
      return Object.fromEntries(Object.entries(raw).filter(([, v]) => ok(v))) as Record<string, CertState['lastPush']>;
    } catch {
      return {};
    }
  }
  private saveState(): void {
    const out = Object.fromEntries([...this.states].map(([id, s]) => [id, s.lastPush]));
    const file = join(this.camDir(), 'state.json');
    writeFileSync(`${file}.tmp`, JSON.stringify(out));
    renameSync(`${file}.tmp`, file);
  }

  state(id: string): CertState {
    return { ...(this.states.get(id) ?? this.blank()) };
  }
  leaf(id: string): Leaf | null {
    return this.leaves.get(id) ?? this.load(id);
  }

  // Forget every leaf (a new CA: tls-ca-rotate moved the files away).
  reset(): void {
    this.leaves.clear();
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

  private async issue(cam: CertCamera, ca: SiteCa, name: string): Promise<Leaf> {
    const l = await issueLeaf(ca, { cn: name, dns: [name], ips: [cam.address] });
    const dir = this.camDir();
    writeSecret(join(dir, `${cam.id}.key`), l.keyPem);
    writeFileSync(join(dir, `${cam.id}.crt`), l.certPem, { mode: 0o644 });
    this.leaves.set(cam.id, l);
    return l;
  }

  private set(id: string, s: Partial<CertState>): CertState {
    const next = { ...(this.states.get(id) ?? this.blank()), ...s };
    this.states.set(id, next);
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
    for (const cam of this.d.cameras()) {
      if (this.stopped) return;
      try {
        await this.one(cam, false);
      } catch (err) {
        logger.warn({ cameraId: cam.id, err: (err as Error).message }, 'camera_cert_check_failed');
      }
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
      this.set(cam.id, { mode: 'public', servername: cam.tlsName, fingerprint: await this.d.served(cam.id), notAfter: null, problem: null });
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
    const inWindow = this.d.localHour(now) === WINDOW_HOUR;
    let leaf = this.leaf(cam.id);
    if (!leaf || !leaf.ips.includes(cam.address) || !leaf.names.includes(name) || !issuedBy(leaf, ca)) leaf = await this.issue(cam, ca, name);
    const served = await this.d.served(cam.id);
    if (served === null) return skip('the camera does not answer on HTTPS'); // unreachable: nothing to push to
    const renewing = renewalDue(leaf, now);
    // A due renewal waits for 04:00 while the camera serves the old leaf; a camera
    // that serves something else (reset, replaced) gets a fresh leaf at once.
    if (renewing && (inWindow || manual || served !== leaf.fingerprint)) leaf = await this.issue(cam, ca, name);
    const s = this.states.get(cam.id);
    if (served === leaf.fingerprint) {
      // Serving the leaf clears an earlier failed or refused push (the health item, Ruling P5-9).
      const stale = s?.lastPush && s.lastPush.outcome !== 'pushed' && s.lastPush.outcome !== 'current';
      this.set(cam.id, { mode: 'site-ca', servername: name, fingerprint: leaf.fingerprint, notAfter: leaf.notAfter, problem: null, ...(stale ? { lastPush: { at: now, outcome: 'current' as const } } : {}) });
      if (stale) this.saveState();
      if (s?.mode !== 'site-ca') this.d.onSiteCa?.(cam.id);
      return null;
    }
    const last = s?.lastPush;
    if (!manual) {
      // Ruling P5-6: after a refusal, the next try is the next 04:00 window (once in it).
      if (last?.outcome === 'refused') {
        this.set(cam.id, { mode: 'pinned', servername: null, fingerprint: served, notAfter: null });
        if (!inWindow || now - last.at < HOUR) return null;
      }
      if (last?.outcome === 'failed' && now - last.at < FAILED_RETRY_MS) return null;
    }
    if (this.d.openEvent(cam.id)) return skip('an event is open: try again when it has ended', served); // never during an event: the next tick
    const r = await this.d.push(cam.id, leaf);
    const lastPush = { at: now, outcome: r.outcome };
    if (r.outcome === 'pushed' || r.outcome === 'current') {
      this.set(cam.id, { mode: 'site-ca', servername: name, fingerprint: leaf.fingerprint, notAfter: leaf.notAfter, lastPush, problem: null });
      this.d.onSiteCa?.(cam.id);
    } else {
      // The fallback (spec §10.1.4): cams pins what the camera serves.
      this.set(cam.id, { mode: 'pinned', servername: null, fingerprint: r.served, notAfter: null, lastPush, problem: r.outcome === 'failed' ? `push failed: ${r.detail ?? 'unknown'}` : null });
    }
    this.saveState();
    this.d.onPush?.(cam.id, r.outcome);
    this.d.audit?.write({
      action: 'camera-cert-push',
      category: ['configuration'],
      type: ['change'],
      outcome: r.outcome === 'pushed' || r.outcome === 'current' ? 'success' : 'failure',
      user: manual ? 'admin' : 'system',
      camera: cam.id,
      message: `Camera certificate ${r.outcome} (${cam.id}, ${Math.round(r.tookMs / 1000)} s)`,
      details: { served: r.served, leaf: leaf.fingerprint, notAfter: leaf.notAfter, ...(r.detail ? { detail: r.detail } : {}) },
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

// A stored leaf from another CA (restored files, a rotation) is issued anew.
function issuedBy(leaf: Leaf, ca: SiteCa): boolean {
  try {
    return new X509Certificate(leaf.certPem).verify(new X509Certificate(ca.certPem).publicKey);
  } catch {
    return false;
  }
}
