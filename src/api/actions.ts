import type { TooSoon } from '../camera/reboot';
import { PoeSwitchError } from '../camera/poe-switch';
import { splitHost } from '../camera/http';
import { cameraConfig, cameraIds } from '../config/cameras';
import { CAMERA_HOST_NAMES, validCameraHost } from '../config/env';
import { checkEnvPath, EnvFileError, writeEnvKey } from '../config/env-file';
import { FtpNotConfiguredError } from '../clips/camera-ftp';
import { InventoryBusyError, InventoryStoppingError, RepairRefusedError, RUN_ID } from '../inventory/runner';
import { logger } from '../log';
import { RotateBusyError } from '../tls/camera-certs';
import { projectPush } from '../tls/push';
import type { ControlDeps } from './control-api';

// The control actions without Express (plan P3 R3-7): POST
// /control/(cameras/:cam/)actions/:name maps an outcome to its answer, and
// cams-admin's camera.action calls the same core with a cams-admin
// requester. The route keeps what is HTTP only: the camera from the path,
// the control-action record, the host-wide restart and the process restart.
export interface ActionWho { user: string; requestedBy: 'session' | 'token' | 'cams-admin'; ip?: string; userAgent?: string; cmdId?: string; actor?: string }
export type ActionOutcome =
  | { status: number; json?: unknown; retryAfterS?: number }
  | { status: number; error: string; detail?: string; extra?: Record<string, unknown>; retryAfterS?: number };
export type ActionDeps = Pick<ControlDeps, 'cameras' | 'cameraCount' | 'cameraId' | 'running' | 'resubscribe' | 'checkCamera' | 'storage' | 'cameraFtp' | 'restart' | 'restartCamera' | 'cameraReboot' | 'cameraPowerCycle' | 'poeSwitch' | 'findCamera' | 'envFile' | 'restartProcess' | 'inventory' | 'archive' | 'tls' | 'cameraNtp' | 'audit'>;

// Actions with their own audit records (the route writes no control-action record for them).
export const OWN_AUDIT: ReadonlySet<string> = new Set(['camera-reboot', 'camera-powercycle', 'camera-poe-on', 'restart-proxy', 'inventory', 'inventory-repair', 'camera-address', 'archive-clear', 'tls-ca-rotate', 'camera-trust-clear', 'tls-ca-drop-previous']);

const fail = (status: number, error: string, detail?: string, extra?: Record<string, unknown>): ActionOutcome => ({ status, error, ...(detail ? { detail } : {}), ...(extra && Object.keys(extra).length ? { extra } : {}) });
// A command's cmdId and actor in a record's details.
const cmdOf = (who: ActionWho) => ({ ...(who.cmdId ? { cmdId: who.cmdId } : {}), ...(who.actor ? { actor: who.actor } : {}) });
const whoRecord = (who: ActionWho) => ({ user: who.user, ...(who.ip ? { ip: who.ip } : {}), ...(who.userAgent ? { userAgent: who.userAgent } : {}) });

// A camera call from an action: its answer, or 502 with the camera's error.
async function cameraCall(f: () => Promise<unknown>): Promise<ActionOutcome> {
  try {
    return { status: 200, json: await f() };
  } catch (err) {
    if (err instanceof FtpNotConfiguredError) return fail(409, 'not_configured', err.message);
    logger.warn({ err: (err as Error).message }, 'camera_action_failed');
    return fail(502, 'camera_error', (err as Error).message);
  }
}

function envFileState(path: string | undefined): { writable: boolean; reason?: string; path?: string } {
  try {
    return { writable: true, path: checkEnvPath(path) };
  } catch (err) {
    if (err instanceof EnvFileError) return { writable: false, reason: err.message };
    throw err;
  }
}

// `cam`: the camera (null only for host actions). `body`: the request body.
export async function performAction(d: ActionDeps, name: string, cam: string | null, body: Record<string, unknown>, who: ActionWho): Promise<ActionOutcome> {
  const requester = { user: who.user, requestedBy: who.requestedBy, ...(who.ip ? { ip: who.ip } : {}), ...(who.userAgent ? { userAgent: who.userAgent } : {}), ...cmdOf(who) };
  const camera = (): string => {
    if (cam === null) throw new Error(`${name}: no camera`);
    return cam;
  };
  // The reboot and the power-cycle share a cooldown (#83, #85).
  const tooSoon = (a: TooSoon): ActionOutcome => ({
    ...fail(429, 'too_soon', a.inFlight
      ? `a camera reboot or power-cycle is in progress; try again in ${a.retryAfterS} s`
      : `the camera was rebooted or power-cycled less than 2 minutes ago; try again in ${a.retryAfterS} s`),
    retryAfterS: a.retryAfterS,
  });
  // The power-cycle, PoE-on and switch read need a configured switch: 409 otherwise.
  const noSwitch = (): ActionOutcome | null => {
    const why = d.poeSwitch.notConfigured(camera());
    return why ? fail(409, 'not_configured', why) : null;
  };
  const inventoryRefused = (err: unknown): ActionOutcome | null => {
    if (err instanceof InventoryStoppingError) return fail(503, 'stopping', err.message);
    if (err instanceof InventoryBusyError) return fail(409, 'inventory_busy', err.message, { runId: err.runId });
    return null;
  };
  const switchFail = (err: unknown): ActionOutcome => {
    if (!(err instanceof PoeSwitchError)) throw err;
    return fail(err.code === 'switch_busy' || err.code === 'no_power' ? 409 : 502, err.code, err.message, err.poeOff ? { poeOff: true, turnedOn: err.turnedOn === true } : {});
  };
  switch (name) {
    case 'onvif-resubscribe':
      d.resubscribe(camera());
      return { status: 202 };
    case 'camera-test':
      return { status: 200, json: await d.checkCamera(camera()) };
    case 'retention-run':
      return { status: 200, json: d.storage.run({ dryRun: body.dryRun === true }) };
    case 'camera-ftp-setup':
    case 'camera-ftp-test': {
      const c = camera();
      const t = d.cameraFtp.target(c);
      if (!t.server) return fail(409, 'not_configured', 'ftp.publicHost is not set');
      if (!t.password) return fail(409, 'not_configured', 'CAMPROXY_FTP_PASSWORD is not set');
      return cameraCall(async () => (name === 'camera-ftp-setup' ? { ftp: await d.cameraFtp.setup(c, t) } : d.cameraFtp.test(c, t)));
    }
    case 'camera-ftp-off': {
      const c = camera();
      return cameraCall(async () => ({ ftp: await d.cameraFtp.off(c) }));
    }
    // One camera's side: reconnect and apply its restart settings (the
    // host-wide restart is the route's, never a command's).
    case 'restart':
      d.restartCamera(camera()).catch((err: Error) => logger.error({ err: err.message }, 'restart_failed'));
      return { status: 202 };
    // Reboot the camera (#83): 202 {confirmed}, 429 within the cooldown,
    // 502 when the request never reached the camera.
    case 'camera-reboot': {
      const a = await d.cameraReboot(requester, camera());
      if (a.status === 202) return { status: 202, json: { confirmed: a.confirmed } };
      if (a.status === 429) return tooSoon(a);
      return fail(502, a.error, a.detail);
    }
    // Power-cycle the camera through its PoE switch (#85): 202 {offAt, onAt,
    // watts} once PoE is back on; 409 not_configured, switch_busy, no_power;
    // 502 switch_auth, switch_unreachable, switch_error; 429 as the reboot.
    case 'camera-powercycle': {
      const no = noSwitch();
      if (no) return no;
      const a = await d.cameraPowerCycle(requester, camera());
      if (a.status === 202) return { status: 202, json: { offAt: a.offAt, onAt: a.onAt, watts: a.watts } };
      if (a.status === 429) return tooSoon(a);
      return fail(a.status, a.error, a.detail, a.poeOff ? { poeOff: true, turnedOn: a.turnedOn } : {});
    }
    // Recovery (#85): PoE on for the camera's port if it is off; no power
    // check and no cooldown. The same switch session lock as the rest.
    case 'camera-poe-on': {
      const no = noSwitch();
      if (no) return no;
      const c = camera();
      const sw = d.poeSwitch.info(c);
      const where = `${sw.host} port ${sw.port}`;
      const base = { action: 'camera-poe-on', category: ['host'], type: ['change'], ...whoRecord(who), camera: c };
      try {
        const r = await d.poeSwitch.poeOn(c);
        d.audit.write({ ...base, outcome: 'success', message: r.wasOn ? `Camera PoE on (${where}): it was on already` : `Camera PoE turned on (${where})`, details: { switch: sw, wasOn: r.wasOn, requestedBy: who.requestedBy, ...cmdOf(who) } });
        return { status: 200, json: r };
      } catch (err) {
        if (err instanceof PoeSwitchError) d.audit.write({ ...base, outcome: 'failure', error: err.code, message: `Camera PoE on (${where}) failed: ${err.message}`, details: { switch: sw, requestedBy: who.requestedBy, ...cmdOf(who), ...(err.poeOff ? { poeStillOff: true } : {}) } });
        return switchFail(err);
      }
    }
    // The camera's port on the switch now (log in, read, log out); never polled.
    case 'poe-switch-read': {
      const no = noSwitch();
      if (no) return no;
      try {
        return { status: 200, json: await d.poeSwitch.read(camera()) };
      } catch (err) {
        return switchFail(err);
      }
    }
    // Find camera (pi-config spec §3): the devices that answer an ONVIF
    // probe, the current camera marked, and whether the .env file can be written.
    case 'find-camera': {
      const r = await d.findCamera();
      const hosts = cameraIds(d.running()).map((id) => splitHost(cameraConfig(d.running(), id)!.host).hostname.toLowerCase());
      return { status: 200, json: { devices: r.devices.map((x) => ({ ...x, current: hosts.includes(x.address.toLowerCase()) })), tookMs: r.tookMs, envFile: envFileState(d.envFile()) } };
    }
    // Use this address (pi-config spec §4): CAMERA_HOST into the .env file
    // (backup, atomic), audited; the UI restarts the proxy next.
    case 'camera-address': {
      const host: unknown = body.host;
      if (!validCameraHost(host)) return fail(400, 'invalid', 'host: an address or name, optional :port');
      // CAMERA_HOST is the one camera's address (spec §4.2).
      if (cameraIds(d.running()).length > 1) return fail(409, 'not_available', 'several cameras: set cameras[].host in config.json');
      const line = `CAMERA_HOST=${host}`;
      const base = { action: 'camera-address', category: ['configuration'], type: ['change'], ...whoRecord(who) };
      try {
        const w = writeEnvKey(checkEnvPath(d.envFile()), CAMERA_HOST_NAMES as unknown as string[], host);
        d.audit.write({ ...base, outcome: 'success', message: `Camera address set in .env: "${w.previous ?? ''}" → "${host}" (applies after a restart)`, details: { from: w.previous, to: host, key: w.key, backup: w.backup, requestedBy: who.requestedBy } });
        logger.info({ key: w.key, from: w.previous, to: host, backup: w.backup }, 'camera_address_written');
        return { status: 200, json: { host, previous: w.previous, key: w.key, backup: w.backup, restart: true } };
      } catch (err) {
        if (!(err instanceof EnvFileError)) throw err;
        d.audit.write({ ...base, outcome: 'failure', error: err.code, message: `Camera address "${host}" not written to .env: ${err.message}`, details: { to: host, requestedBy: who.requestedBy } });
        return fail(409, 'not_available', err.message, { line });
      }
    }
    // Inventories (spec 2026-10-02-inventory-design): 202 {runId}; the run
    // goes on in the background and writes its own `inventory` record.
    case 'inventory': {
      const kind: unknown = body.kind;
      const withCamera: unknown = body.camera;
      const kinds = d.inventory.kinds();
      if (typeof kind !== 'string' || !kinds.includes(kind)) return fail(400, 'invalid', `kind is one of: ${kinds.join(', ')}`);
      if (withCamera !== undefined && typeof withCamera !== 'boolean') return fail(400, 'invalid', 'camera is true or false');
      if (withCamera && !d.inventory.checks[kind]?.camera) return fail(400, 'invalid', `the ${kind} inventory has no camera compare`);
      try {
        const { runId } = d.inventory.start(kind, requester, { camera: withCamera === true, cam: camera() });
        return { status: 202, json: { runId } };
      } catch (err) {
        const refused = inventoryRefused(err);
        if (!refused) throw err;
        return refused;
      }
    }
    // A repair from a check report (#74): 202 {runId}; it writes its own
    // `inventory-repair` record when it ends. A refused start writes nothing.
    case 'inventory-repair': {
      const kind: unknown = body.kind;
      const source: unknown = body.runId;
      const kinds = d.inventory.repairKinds();
      if (typeof kind !== 'string' || !kinds.includes(kind)) return fail(400, 'invalid', `kind is one of: ${kinds.join(', ')}`);
      if (typeof source !== 'string' || !RUN_ID.test(source)) return fail(400, 'invalid', 'runId is the id of a check run');
      // A repair works on its report's camera: only under that camera.
      const report = await d.inventory.get(source);
      if (report && report.camera !== camera()) return fail(409, 'camera_mismatch', `that inventory ran on camera ${report.camera}`);
      try {
        const { runId } = await d.inventory.repair(kind, requester, source);
        return { status: 202, json: { runId } };
      } catch (err) {
        const refused = inventoryRefused(err);
        if (refused) return refused;
        if (!(err instanceof RepairRefusedError)) throw err;
        return err.code === 'not_found' ? fail(404, 'not_found', err.message) : fail(409, err.code, err.message);
      }
    }
    // Clear the Archive (spec 2026-10-05-archive-design §3, ruling 14):
    // only with the current number of clips; one `archive-clear` record.
    case 'archive-clear': {
      const count: unknown = body.count;
      if (!Number.isSafeInteger(count) || (count as number) < 0) return fail(400, 'invalid', 'count is the number of clips in the Archive');
      const r = d.archive.clear(count as number, { ...whoRecord(who), requestedBy: who.requestedBy });
      if ('mismatch' in r) return fail(409, 'count_mismatch', `the Archive has ${r.mismatch} clips`, { count: r.mismatch });
      return { status: 200, json: r };
    }
    // A control-action record; the run ends with its partial counts.
    case 'inventory-cancel': {
      // Only this camera's run (one runs at a time, host-wide).
      const run = d.inventory.running();
      if (run && run.camera !== camera()) return fail(409, 'camera_mismatch', `the running inventory is camera ${run.camera}'s`);
      const runId = d.inventory.cancel('request');
      return { status: 200, json: { cancelled: runId !== null, runId } };
    }
    // "Push now" (spec §10.4): the push's own camera-cert-push record when one ran.
    // The answer is projected: never the leaf's private key or a PEM (R3-8).
    case 'camera-cert-push':
      return { status: 200, json: projectPush(await d.tls.pushNow(camera(), requester)) };
    // The admin's decision to drop a camera's site-CA trust or pin (back to first use); audited.
    case 'camera-trust-clear': {
      if (body.confirm !== 'clear') return fail(400, 'invalid', "the camera loses its site-CA trust or pin and needs a Push now: send {confirm: 'clear'}");
      const st = d.tls.clearTrust(camera(), requester);
      if (!st) return fail(409, 'not_available', 'no camera certificate trust is kept on this proxy');
      return { status: 200, json: st };
    }
    // After tls-ca-rotate: stop trusting the previous CA now (else 30 days); audited.
    case 'tls-ca-drop-previous':
      if (body.confirm !== 'drop') return fail(400, 'invalid', "cameras still on the previous CA are refused from now on: send {confirm: 'drop'}");
      if (!d.tls.dropPrevious(requester)) return fail(409, 'not_available', 'no previous CA is trusted');
      return { status: 200, json: { dropped: true } };
    case 'camera-ntp-set': {
      const outcome = await d.cameraNtp(camera());
      if (outcome === null) return fail(409, 'not_configured', 'ntp.server is not set');
      return { status: 200, json: { outcome } };
    }
    // A new site CA (Ruling P5-3): every cams pin of this proxy breaks, so
    // only with {confirm: 'rotate'}; one config-change record.
    case 'tls-ca-rotate': {
      if (body.confirm !== 'rotate') return fail(400, 'invalid', "a new CA breaks every cams pin of this proxy: send {confirm: 'rotate'}");
      const base = { action: 'config-change', category: ['configuration'], type: ['change'], ...whoRecord(who) };
      const rotating = d.tls.rotate();
      if (!rotating) return fail(409, 'not_available', 'no site CA: tls.site is not set');
      try {
        const r = await rotating;
        d.audit.write({ ...base, outcome: 'success', message: `Site CA rotated: ${r.from ?? 'none'} → ${r.to}`, details: { setting: 'tls-ca', from: r.from, to: r.to, requestedBy: who.requestedBy } });
        return { status: 200, json: { caFingerprint: r.to } };
      } catch (err) {
        if (err instanceof RotateBusyError) return fail(409, 'busy', err.message);
        d.audit.write({ ...base, outcome: 'failure', error: (err as Error).message, message: `Site CA rotation failed: ${(err as Error).message}`, details: { setting: 'tls-ca', requestedBy: who.requestedBy } });
        return fail(500, 'rotate_failed', (err as Error).message);
      }
    }
    // restart-proxy is the route's (it restarts after the answer); never here.
    default:
      return fail(404, 'not_found');
  }
}
