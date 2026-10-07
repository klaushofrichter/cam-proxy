import type { AuditLog } from '../audit/audit-log';
import { CameraError } from '../camera/client';
import { CameraNameRefused } from '../camera/name';
import { cameraNameProblem } from '../camera/name-rules';
import { OWN_AUDIT, performAction, type ActionDeps, type ActionWho } from '../api/actions';
import type { CameraActionArgs, CameraNameArgs } from './command-args';
import type { CommandBody } from './command-check';
import type { Done, Handler } from './commands';
import { NEVER_REMOTE_ACTIONS, REMOTE_ACTIONS } from './policy';
import { SECRET_KEY_PATTERN } from './remote-settable';

// cams-admin's camera commands (migration spec M §8.3, §8.6; plan P3 Task 9):
// camera.action through the control API's own action code (performAction, no
// HTTP self-call), camera.name.set through the camera's name write, and
// proxy.restart after its result is sent. No new camera write: the camera
// writes are the proxy's whole-object Set + re-read functions; their result
// says whether the re-read matched. Answers are scrubbed and clamped (R3-8).
export interface CameraCommandDeps {
  actions: ActionDeps;
  cameraIds: () => string[];
  cameraName: { current: (cam: string) => string; write: (cam: string, name: string) => Promise<string> };
  audit: Pick<AuditLog, 'write'>;
  restartProcess: () => void;
  now?: () => number;
}

const SECRET_KEY = SECRET_KEY_PATTERN;
const MAX_ANSWER = 16_384;
// Every key that could hold key material or a credential, dropped at any depth.
export function scrub(x: unknown, depth = 0): unknown {
  if (depth > 16) return null;
  if (Array.isArray(x)) return x.map((v) => scrub(v, depth + 1));
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).filter(([k]) => !SECRET_KEY.test(k)).map(([k, v]) => [k, scrub(v, depth + 1)]));
  return typeof x === 'string' && x.length > 2000 ? x.slice(0, 2000) : x;
}

const UPLOAD_ON = ['MD', 'AI_PEOPLE', 'AI_VEHICLE', 'AI_DOG_CAT'];
type Verdict = { verified: boolean; mismatch: string[] };
// The FTP object the camera answered after the Set (re-read, redacted) against what was asked.
export function verifyFtp(action: 'camera-ftp-setup' | 'camera-ftp-off', answer: Record<string, unknown>, target?: { server: string; port: number; tls: boolean; stream: 'main' | 'sub' }): Verdict {
  const f = (answer?.ftp ?? {}) as Record<string, unknown>;
  const mismatch: string[] = [];
  if (action === 'camera-ftp-off') {
    if (f.enable !== 0) mismatch.push('enable');
  } else {
    if (f.enable !== 1) mismatch.push('enable');
    if (target) {
      if (f.server !== target.server) mismatch.push('server');
      if (f.port !== target.port) mismatch.push('port');
      if (f.onlyFtps !== (target.tls ? 1 : 0)) mismatch.push('onlyFtps');
      if (f.streamType !== (target.stream === 'sub' ? 1 : 0)) mismatch.push('streamType');
    }
    const on = Array.isArray(f.uploadOn) ? (f.uploadOn as string[]) : [];
    if (!UPLOAD_ON.every((k) => on.includes(k))) mismatch.push('uploadOn');
  }
  return { verified: mismatch.length === 0, mismatch };
}
// The NTP sync re-reads the camera's Ntp object: set or already = it holds ntp.server.
export function verifyNtp(answer: { outcome: string }): Verdict {
  if (answer?.outcome === 'set' || answer?.outcome === 'already') return { verified: true, mismatch: [] };
  return { verified: false, mismatch: answer?.outcome === 'failed' ? ['server'] : [] };
}
// The push verifies what the camera serves: the pushed leaf (or the current one).
export function verifyPush(answer: { outcome: string; served: string | null; leaf?: { fingerprint: string } }): Verdict {
  if (answer?.outcome === 'current') return { verified: true, mismatch: [] };
  if (answer?.outcome !== 'pushed') return { verified: false, mismatch: ['outcome'] };
  return answer.served && answer.served === answer.leaf?.fingerprint ? { verified: true, mismatch: [] } : { verified: false, mismatch: ['served'] };
}

const CAMERA_WRITES = new Set(['camera-ftp-setup', 'camera-ftp-off', 'camera-ntp-set', 'camera-cert-push']);
const isRemote = (a: string) => (REMOTE_ACTIONS as readonly string[]).includes(a) && !(NEVER_REMOTE_ACTIONS as readonly string[]).includes(a);

export function cameraHandlers(d: CameraCommandDeps): Record<'camera.action' | 'camera.name.set' | 'proxy.restart', Handler> {
  const who = (cmd: CommandBody): ActionWho => ({ user: 'cams-admin', requestedBy: 'cams-admin', cmdId: cmd.cmdId, actor: cmd.actor });
  const verifyOf = (action: string, cam: string, json: unknown): Verdict => {
    const a = (json ?? {}) as Record<string, unknown>;
    if (action === 'camera-ftp-setup') {
      const t = d.actions.cameraFtp.target(cam);
      return verifyFtp('camera-ftp-setup', a, { server: t.server, port: t.port, tls: t.tls, stream: t.stream });
    }
    if (action === 'camera-ftp-off') return verifyFtp('camera-ftp-off', a);
    if (action === 'camera-ntp-set') return verifyNtp(a as { outcome: string });
    return verifyPush(a as { outcome: string; served: string | null });
  };
  return {
    'camera.action': async (args, cmd) => {
      const a = args as CameraActionArgs;
      const fail = (code: string): Done => ({ status: 'failed', code, action: a.action });
      // Defense behind the check's step 11: never a never-remote action, never the host-wide restart.
      if (!isRemote(a.action)) return fail('not_allowed');
      if (a.camera === null && a.action !== 'retention-run') return fail('invalid');
      if (a.camera !== null && !d.cameraIds().includes(a.camera)) return fail('unknown_camera');
      if (a.camera !== null && d.actions.cameras.get(a.camera)?.phase() === 'restarting') return fail('camera_restarting');
      // retention-run is always a dry run here, whatever was asked.
      const input = a.action === 'retention-run' ? { dryRun: true } : a.action === 'inventory' ? { ...(a.input ?? {}) } : {};
      const o = await performAction(d.actions, a.action, a.camera, input, who(cmd));
      const ok = o.status < 400;
      const raw = 'error' in o ? { error: o.error, ...(o.detail ? { detail: o.detail } : {}), ...(o.extra ?? {}) } : (o.json ?? null);
      const text = JSON.stringify(scrub(raw) ?? null);
      const clamped = Buffer.byteLength(text) > MAX_ANSWER;
      const answer = clamped ? null : (JSON.parse(text) as Record<string, unknown> | null);
      const check = ok && a.camera !== null && CAMERA_WRITES.has(a.action) ? verifyOf(a.action, a.camera, o && 'json' in o ? o.json : null) : null;
      // The control-action record the route writes for an action without its own (a dry run changes nothing).
      if (!OWN_AUDIT.has(a.action) && a.action !== 'retention-run') {
        const result = ok ? 'ok' : 'error' in o ? o.error : String(o.status);
        d.audit.write({ action: 'control-action', category: ['configuration'], type: ['change'], outcome: ok ? 'success' : 'failure', user: 'cams-admin', message: `Control action ${a.action} by cams-admin (on behalf of ${cmd.actor}): ${result}`, details: { action: a.action, result, requestedBy: 'cams-admin', cmdId: cmd.cmdId, actor: cmd.actor }, ...(a.camera ? { camera: a.camera } : {}) });
      }
      return {
        status: ok ? 'ok' : 'failed',
        ...(ok ? {} : { code: 'error' in o ? o.error : 'internal' }),
        action: a.action,
        result: { action: a.action, camera: a.camera, httpStatus: o.status, answer, ...(clamped ? { clamped: true } : {}), ...(check ?? {}) },
        changed: ok && CAMERA_WRITES.has(a.action) ? [`camera:${a.camera}:${a.action}`] : [],
      };
    },
    'camera.name.set': async (args, cmd) => {
      const a = args as CameraNameArgs;
      if (!d.cameraIds().includes(a.camera)) return { status: 'failed', code: 'unknown_camera' };
      if (cameraNameProblem(a.name)) return { status: 'failed', code: 'invalid_name' };
      const from = d.cameraName.current(a.camera);
      const base = { action: 'camera-name', category: ['configuration'], type: ['change'], user: 'cams-admin', camera: a.camera };
      const by = { requestedBy: 'cams-admin', cmdId: cmd.cmdId, actor: cmd.actor };
      try {
        const name = await d.cameraName.write(a.camera, a.name);
        d.audit.write({ ...base, outcome: 'success', message: name === from ? `Camera name set by cams-admin: "${name}" (unchanged)` : `Camera name changed by cams-admin: "${from}" → "${name}"`, details: { from, to: name, ...(name !== a.name ? { requested: a.name } : {}), ...by } });
        return { status: 'ok', result: { camera: a.camera, requested: a.name, name, verified: name === a.name }, changed: [`camera:${a.camera}:name`] };
      } catch (err) {
        const code = err instanceof CameraNameRefused ? 'invalid_name' : err instanceof CameraError && err.code === 'camera_offline' ? 'camera_offline' : 'camera_error';
        d.audit.write({ ...base, outcome: 'failure', error: code, message: `Camera name change by cams-admin "${from}" → "${a.name}" failed: ${code}`, details: { from, requested: a.name, ...by } });
        return { status: 'failed', code };
      }
    },
    // R3-10: the result first (journaled, sent), then the existing stop-and-exit path.
    'proxy.restart': () => {
      const restartAt = (d.now ?? Date.now)() + 1000;
      return { status: 'ok', result: { restartAt }, after: () => d.restartProcess() };
    },
  };
}
