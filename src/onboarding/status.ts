// One onboarding status per camera (spec 2026-10-30-camera-onboarding-design
// §4.5): each step ok, not ok, or not known yet (null), why, and the action
// that fixes it. Pure: the service gathers the input. Never a secret.
import type { Capabilities } from '../camera/capabilities';
import type { CameraState } from '../camera/status';
import type { TimeInfo } from '../camera/time';
import type { CameraFtpView } from '../clips/ftp-health';
import type { ProfileWarning } from '../config/profile';
import type { IntakeState } from '../events/intake';
import type { CertMode, CertState } from '../tls/camera-certs';
import type { Credentials } from './credentials';
import { zoneRule } from './zone';

export type StepName = 'reachable' | 'login' | 'trust' | 'capabilities' | 'stream' | 'events' | 'ftp' | 'time' | 'name' | 'poe' | 'profile';
export const STEPS: readonly StepName[] = ['reachable', 'login', 'trust', 'capabilities', 'stream', 'events', 'ftp', 'time', 'name', 'poe', 'profile'];
export const REQUIRED: readonly StepName[] = ['reachable', 'login', 'trust', 'capabilities', 'stream', 'events'];
export interface Step { ok: boolean | null; detail: string; action?: string }
export interface OnboardingStatus {
  camera: string;
  ready: boolean;
  checkedAt: number;
  steps: Record<StepName, Step>;
  trust: { mode: CertMode; fingerprint: string | null; served: string | null };
  time: { clockOffsetMs: number | null; zone: string | null; cameraStdOffsetMinutes: number | null; cameraDst: boolean | null };
}
export interface OnboardingInput {
  camera: string;
  now: number;
  protocol: 'https' | 'http';
  state: CameraState;
  credentials: Credentials;
  cert: CertState | null;
  served: string | null; // the fingerprint the camera serves now (https), null when not measured
  capabilities: Capabilities | null;
  stills: { enabled: boolean; up: boolean };
  intake: IntakeState;
  ftp: { enabled: boolean; view: CameraFtpView | null; lastUpload: number | null };
  timeInfo: TimeInfo | undefined;
  zone: string | null;
  name: { name: string; nameSource: 'camera' | 'config' };
  poePort: number | null;
  profile: ProfileWarning[];
}

// The camera's clock may be off by this much before the time step fails.
export const CLOCK_TOLERANCE_MS = 60_000;
const MAX_DETAIL = 200;
const step = (ok: boolean | null, detail: string, action?: string): Step => ({ ok, detail: detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL - 1)}…` : detail, ...(action ? { action } : {}) });
const ago = (now: number, t: number) => `${Math.max(0, Math.round((now - t) / 60_000))} min ago`;

function trustStep(i: OnboardingInput, mode: CertMode): Step {
  if (i.protocol === 'http') return step(false, 'plain http: no certificate');
  if (mode === 'site-ca') return step(true, `site CA (${i.cert?.servername ?? 'its .internal name'})`);
  if (mode === 'public') return step(true, 'public certificate name');
  if (mode === 'pinned') {
    if (i.served !== null && i.served !== i.cert?.fingerprint) return step(false, 'serves another certificate: pin again', 'camera-trust-pin');
    return step(true, `pinned ${i.cert?.fingerprint ?? ''}`.trim());
  }
  return step(false, 'certificate not trusted: use "Trust this camera\'s certificate"', 'camera-trust-pin');
}

function timeStep(i: OnboardingInput): Step {
  const t = i.timeInfo;
  if (!t) return step(null, 'the camera time is not read yet');
  if (i.zone === null) return step(null, 'zone unknown: set time.zone');
  const off = i.state.clockOffsetMs;
  if (off !== undefined && Math.abs(off) > CLOCK_TOLERANCE_MS) return step(false, `the camera clock is ${Math.round(off / 1000)} s off`, 'camera-ntp-set');
  const rule = zoneRule(i.zone, new Date(i.now).getUTCFullYear());
  if (rule === 'unsupported') return step(null, `${i.zone}: the camera can't express this zone's rules`);
  const want = rule.dst;
  const r = t.dstRule;
  const same = t.stdOffsetMinutes === rule.stdOffsetMinutes &&
    (want === null ? t.dstOffsetMinutes === 0 : !!r && t.dstOffsetMinutes === want.offsetHours * 60 && (Object.keys(r) as (keyof typeof r)[]).every((k) => r[k] === want[k]));
  return same ? step(true, i.zone) : step(false, `the camera's zone or DST rule is not ${i.zone}`, 'camera-time-set');
}

function ftpStep(i: OnboardingInput): Step {
  if (!i.ftp.enabled) return step(true, 'off');
  const v = i.ftp.view;
  if (!v || v.state === 'unknown') return step(null, 'the camera FTP upload is not read yet');
  const last = i.ftp.lastUpload !== null ? `; last upload ${ago(i.now, i.ftp.lastUpload)}` : '';
  if (v.state === 'on' && v.mismatch.length === 0) return step(true, `uploads here${last}`);
  return step(false, `camera FTP upload: ${v.state.replace(/_/g, ' ')}${v.mismatch.length ? ` (${v.mismatch.join(', ')} differ)` : ''}`, 'camera-ftp-setup');
}

export function onboardingStatus(i: OnboardingInput): OnboardingStatus {
  const st = i.state;
  const mode: CertMode = i.cert?.mode ?? 'none';
  const answered = st.error === 'camera_auth_failed' || st.error === 'camera_error';
  const steps: Record<StepName, Step> = {
    reachable: st.online ? step(true, 'answers') : answered ? step(true, `answers, but: ${st.error}`) : st.error === 'camera_offline' ? step(false, 'does not answer') : st.checkedAt === undefined ? step(null, 'not checked yet') : step(false, st.error ?? 'offline'),
    login: i.credentials.source === 'none' ? step(false, 'no password', 'password') : i.credentials.authOk === true ? step(true, `password from ${i.credentials.envName ?? i.credentials.source}`) : i.credentials.authOk === false ? step(false, 'the camera refused the password', 'password') : step(null, 'not known yet'),
    trust: trustStep(i, mode),
    capabilities: i.capabilities ? step(true, i.capabilities.ptz ? 'PTZ' : 'fixed') : step(null, 'not read yet'),
    stream: !i.stills.enabled ? step(true, 'off') : i.stills.up ? step(true, 'frames arrive') : step(false, 'no frames'),
    events: i.intake.onvif === 'subscribed' ? step(true, 'ONVIF subscribed') : i.intake.onvif === 'connecting' ? step(null, 'ONVIF connecting') : step(false, `ONVIF down${i.intake.source === 'poll' ? ' (polling)' : ''}`),
    ftp: ftpStep(i),
    time: timeStep(i),
    name: i.name.nameSource === 'camera' ? step(true, i.name.name) : step(null, 'not read from the camera yet'),
    poe: i.poePort !== null ? step(true, `port ${i.poePort}`) : step(true, 'none'),
    profile: i.profile.includes('profile_cameras_exceeded') ? step(false, 'more cameras than profile.cameras') : step(true, 'within the profile'),
  };
  return {
    camera: i.camera,
    ready: REQUIRED.every((n) => steps[n].ok === true),
    checkedAt: i.now,
    steps,
    trust: { mode, fingerprint: i.cert?.fingerprint ?? null, served: i.served },
    time: { clockOffsetMs: st.clockOffsetMs ?? null, zone: i.zone, cameraStdOffsetMinutes: i.timeInfo?.stdOffsetMinutes ?? null, cameraDst: i.timeInfo ? i.timeInfo.dstOffsetMinutes > 0 : null },
  };
}

// The heartbeat's compact form: the steps not ok, and the required ones not known yet.
export function compactOf(s: OnboardingStatus): { ready: boolean; missing: StepName[] } {
  return { ready: s.ready, missing: STEPS.filter((n) => s.steps[n].ok === false || (s.steps[n].ok === null && REQUIRED.includes(n))) };
}
