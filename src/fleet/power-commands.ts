import { readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AuditLog } from '../audit/audit-log';
import type { CameraReboot, TooSoon } from '../camera/reboot';
import { logger } from '../log';
import type { CameraPowerCycledArgs, CameraPowerCycleResultArgs, CameraPowerCyclingArgs, CameraPowerSetArgs } from './command-args';
import type { Done, Handler } from './commands';
import type { PowerCycleRequestEvent } from './outbox';
import { ulid } from './protocol';

// The camera's power as cams-admin knows it (spec 2026-11-07-poe-switches-design,
// "Camera power", "Who does what", "Asking from a proxy"). cams-admin holds the
// record (the one place) and sends this proxy a copy for display
// (camera.power.set); it runs every power-cycle through the switch's operating
// proxy and tells the camera's own proxy when the PoE went off and came on
// again (camera.power.cycling / cycled), so this proxy keeps the reboot
// state, its cooldown and its watch. The Maintenance page asks for a cycle
// with the event camera.power.cycle.request; the answer is
// camera.power.cycle.result. Starting a power-cycle needs cams-admin.

export type PowerKind = 'poe' | 'data-only' | 'adapter' | 'unknown';
export interface CameraPower { kind: PowerKind; switchName?: string; port?: number; watts?: number; verifiedAt?: number; notSeen?: boolean }
export interface PowerCycleOutcome { requestId: string; ok: boolean; reason?: string; at: number }
export interface PowerView { power: CameraPower | null; setAt: number | null; asked: { requestId: string; at: number } | null; result: PowerCycleOutcome | null }

// <dataDir>/camera-power.json: the display records (no secrets).
export const POWER_FILE = 'camera-power.json';
// An open request without cams-admin's answer ends after this long: a search
// over several switches, the off time and the PoE-on retries fit in it.
export const ASK_TIMEOUT_MS = 5 * 60_000;
export const ASK_TIMEOUT_REASON = 'no answer from cams-admin within 5 minutes';

export class CameraPowerStore {
  private readonly records = new Map<string, { power: CameraPower; setAt: number }>();
  private readonly asked = new Map<string, { requestId: string; at: number }>();
  private readonly results = new Map<string, PowerCycleOutcome>();
  private readonly file: string;

  constructor(dataDir: string, private readonly now: () => number = Date.now) {
    this.file = join(dataDir, POWER_FILE);
    this.load();
  }

  set(camera: string, power: CameraPower): void {
    this.records.set(camera, { power: { ...power }, setAt: this.now() });
    this.save();
  }

  has(camera: string): boolean {
    return this.records.has(camera);
  }

  ask(camera: string, requestId: string): void {
    this.asked.set(camera, { requestId, at: this.now() });
  }

  // cams-admin's answer; the open request it answers is no longer open.
  result(camera: string, r: { requestId: string; ok: boolean; reason?: string }): void {
    this.results.set(camera, { requestId: r.requestId, ok: r.ok, ...(r.reason !== undefined ? { reason: r.reason } : {}), at: this.now() });
    if (this.asked.get(camera)?.requestId === r.requestId) this.asked.delete(camera);
  }

  // Open requests end (no answer will come any more): unenrolled, or cams-admin switched off.
  clearAsked(): void {
    this.asked.clear();
  }

  view(camera: string): PowerView {
    // Unanswered for ASK_TIMEOUT_MS: the result says so (a late answer still replaces it).
    const open = this.asked.get(camera);
    if (open && this.now() - open.at >= ASK_TIMEOUT_MS) {
      this.asked.delete(camera);
      this.results.set(camera, { requestId: open.requestId, ok: false, reason: ASK_TIMEOUT_REASON, at: open.at + ASK_TIMEOUT_MS });
      logger.warn({ camera, requestId: open.requestId }, 'camera_powercycle_no_answer');
    }
    const r = this.records.get(camera);
    return { power: r ? { ...r.power } : null, setAt: r?.setAt ?? null, asked: this.asked.get(camera) ?? null, result: this.results.get(camera) ?? null };
  }

  private load(): void {
    try {
      const f = JSON.parse(readFileSync(this.file, 'utf8')) as { v?: number; cameras?: Record<string, { power?: CameraPower; setAt?: number }> };
      if (f.v !== 1 || typeof f.cameras !== 'object' || f.cameras === null) throw new Error('not a camera power file');
      for (const [id, r] of Object.entries(f.cameras)) {
        if (r && typeof r.power?.kind === 'string' && typeof r.setAt === 'number') this.records.set(id, { power: r.power, setAt: r.setAt });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.error({ err: (err as Error).message }, 'camera_power_file_unreadable');
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, cameras: Object.fromEntries(this.records) }, null, 2));
    renameSync(tmp, this.file);
  }
}

type ExternalCycle = Pick<CameraReboot, 'externalPowerCycle' | 'externalPowerCycleDone'>;
export interface PowerCommandDeps {
  store: CameraPowerStore;
  cameraIds: () => string[];
  reboot: (camera: string) => ExternalCycle;
  audit: Pick<AuditLog, 'write'>;
}

export function powerHandlers(d: PowerCommandDeps): Record<string, Handler> {
  const known = (camera: string): Done | null => (d.cameraIds().includes(camera) ? null : { status: 'failed', code: 'unknown_camera' });
  const ok: Done = { status: 'ok', result: {} };
  return {
    'camera.power.set': (a) => {
      const x = a as CameraPowerSetArgs;
      const no = known(x.camera);
      if (no) return no;
      d.store.set(x.camera, x.power);
      return ok;
    },
    'camera.power.cycling': (a) => {
      const x = a as CameraPowerCyclingArgs;
      const no = known(x.camera);
      if (no) return no;
      d.reboot(x.camera).externalPowerCycle(x.at);
      return ok;
    },
    'camera.power.cycled': (a) => {
      const x = a as CameraPowerCycledArgs;
      const no = known(x.camera);
      if (no) return no;
      d.reboot(x.camera).externalPowerCycleDone(x.ok, x.message);
      return ok;
    },
    'camera.power.cycle.result': (a) => {
      const x = a as CameraPowerCycleResultArgs;
      const no = known(x.camera);
      if (no) return no;
      d.store.result(x.camera, x);
      d.audit.write({
        action: 'camera-powercycle', category: ['host'], type: ['change'], outcome: x.ok ? 'success' : 'failure', user: 'cams-admin', camera: x.camera,
        message: x.ok ? 'Camera power-cycle asked from this proxy: done by cams-admin' : `Camera power-cycle asked from this proxy: refused by cams-admin${x.reason ? `: ${x.reason}` : ''}`,
        details: { phase: 'result', requestId: x.requestId, via: 'cams-admin', ...(x.reason !== undefined ? { reason: x.reason } : {}) },
      });
      return ok;
    },
  };
}

// Who pressed the button (the Maintenance page, the control API).
export interface PowerRequester { user: string; requestedBy: 'session' | 'token' | 'cams-admin'; ip?: string; userAgent?: string }
export type PowerRequestAnswer =
  | { status: 202; requestId: string }
  | TooSoon
  | { status: 409; error: 'power_cycle_needs_cams_admin'; detail: string };
export interface PowerRequestDeps {
  store: CameraPowerStore;
  connected: () => boolean; // cams-admin enabled and connected now
  emit: (e: PowerCycleRequestEvent) => void;
  reboot: (camera: string) => Pick<CameraReboot, 'cooldown'>;
  audit: Pick<AuditLog, 'write'>;
  now?: () => number;
}

// GET /control/cameras/:cam/power: the view, and whether a power-cycle can be
// asked for now. Without cams-admin (unenrolled, switched off) no answer can
// come: open requests end.
export function powerView(d: Pick<PowerRequestDeps, 'store' | 'connected'> & { configured: () => boolean }, camera: string): PowerView & { canRequest: boolean; why: string | null } {
  if (!d.configured()) d.store.clearAsked();
  const why = powerRequestRefusal(d, camera);
  return { ...d.store.view(camera), canRequest: why === null, why };
}

// Why this proxy can't ask cams-admin for a power-cycle now, or null.
export function powerRequestRefusal(d: Pick<PowerRequestDeps, 'store' | 'connected'>, camera: string): string | null {
  if (!d.connected()) return 'a power-cycle needs cams-admin: this proxy is not connected to cams-admin';
  if (!d.store.has(camera)) return "a power-cycle needs cams-admin: cams-admin has not sent this camera's power yet";
  return null;
}

// The Maintenance page's power-cycle: asks cams-admin (one event) and
// answers at once; the result comes later as camera.power.cycle.result.
export function requestPowerCycle(d: PowerRequestDeps, camera: string, who: PowerRequester): PowerRequestAnswer {
  const why = powerRequestRefusal(d, camera);
  if (why) return { status: 409, error: 'power_cycle_needs_cams_admin', detail: why };
  const soon = d.reboot(camera).cooldown();
  if (soon) return soon;
  const requestId = `pc_${ulid((d.now ?? Date.now)())}`;
  d.store.ask(camera, requestId);
  d.emit({ kind: 'camera.power.cycle.request', camera, requestId });
  d.audit.write({
    action: 'camera-powercycle', category: ['host'], type: ['change'], outcome: 'success', user: who.user, camera,
    ...(who.ip ? { ip: who.ip } : {}), ...(who.userAgent ? { userAgent: who.userAgent } : {}),
    message: 'Camera power-cycle asked of cams-admin',
    details: { phase: 'asked', requestId, requestedBy: who.requestedBy, via: 'cams-admin' },
  });
  logger.info({ camera, requestId }, 'camera_powercycle_asked');
  return { status: 202, requestId };
}
