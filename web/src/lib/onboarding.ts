// Camera onboarding in the admin UI (spec 2026-10-30-camera-onboarding-design
// §4.1, §4.4, §4.5): the dialogs' confirm lines, errors in plain words, the
// onboarding card's lines. A password never goes into a store or the URL.
export type StepName = 'reachable' | 'login' | 'trust' | 'capabilities' | 'stream' | 'events' | 'ftp' | 'time' | 'name' | 'poe' | 'profile';
export interface Step { ok: boolean | null; detail: string; action?: string }
export interface OnboardingStatus {
  camera: string;
  ready: boolean;
  checkedAt: number;
  steps: Record<StepName, Step>;
  trust: { mode: string; fingerprint: string | null; served: string | null };
  time: { clockOffsetMs: number | null; zone: string | null; cameraStdOffsetMinutes: number | null; cameraDst: boolean | null };
}

export const STEP_LABELS: Record<StepName, string> = {
  reachable: 'Reachable',
  login: 'Login',
  trust: 'Certificate',
  capabilities: 'Capabilities',
  stream: 'Stream',
  events: 'Events',
  ftp: 'FTP uploads',
  time: 'Time',
  name: 'Name',
  poe: 'PoE port',
  profile: 'Profile',
};

export const passwordConfirmText = (name: string, host: string): string => `Save the login for ${name} (${host}) on this proxy?`;
export const trustConfirmText = (name: string, fingerprint: string): string => `Trust the certificate ${fingerprint} of ${name}? Only if it matches what the camera shows.`;

// The seconds in a too_many_attempts detail ("… try again in 412 s").
export function retryMinutes(detail: unknown): number | undefined {
  const m = typeof detail === 'string' ? /try again in (\d+) s/.exec(detail) : null;
  return m ? Number(m[1]) : undefined;
}

export function passwordError(code: string, o: { retryAfterS?: number; envName?: string } = {}): string {
  switch (code) {
    case 'camera_refused': return 'The camera refused this password.';
    case 'camera_offline': return 'The camera did not answer: is it on and reachable?';
    case 'too_many_attempts': {
      const n = Math.max(1, Math.ceil((o.retryAfterS ?? 600) / 60));
      return `Too many tries: wait ${n} minute${n === 1 ? '' : 's'}.`;
    }
    case 'env_password': return `The password is set in the environment (${o.envName ?? 'its own variable'}): remove it there first.`;
    case 'not_trusted': return "Trust the camera's certificate first.";
    case 'fingerprint_mismatch': return 'The camera serves another certificate than the one shown: check it again.';
    case 'invalid': return '1 to 64 characters, no control characters.';
    default: return `Not saved: ${code}`;
  }
}

// The variable a 409 env_password names in its detail.
export const envNameOf = (detail: unknown): string | undefined => (typeof detail === 'string' ? /^(CAMPROXY_CAMERA_PASSWORD\S*)/.exec(detail)?.[1] : undefined);

export function stepLine(name: StepName, s: Step): string {
  return `${STEP_LABELS[name]}: ${s.detail || (s.ok === null ? 'not known yet' : s.ok ? 'ok' : 'not ok')}`;
}

// The certificate to offer for a pin: the one the proxy measured, when the trust step asks for a pin.
export function trustNeeded(s: { trust: { served: string | null }; steps: { trust: Step } }): string | null {
  return s.steps.trust.action === 'camera-trust-pin' && s.trust.served ? s.trust.served : null;
}

// POST /control/cameras' body from the add form.
export interface AddForm { id: string; name: string; host: string; protocol: 'https' | 'http'; user: string; password: string; fingerprint: string | null; ftp?: boolean }
export function addCameraBody(f: AddForm): Record<string, unknown> {
  return {
    ...(f.id.trim() ? { id: f.id.trim() } : {}),
    ...(f.name.trim() ? { name: f.name.trim() } : {}),
    host: f.host.trim(),
    protocol: f.protocol,
    user: f.user.trim() || 'admin',
    password: f.password,
    ...(f.protocol === 'https' && f.fingerprint ? { trust: { fingerprint: f.fingerprint } } : {}),
    ...(f.ftp ? { ftp: true } : {}),
  };
}

// camera-time-set's answer (spec §4.7) in words.
export function timeSetText(a: { outcome: string; zone: string; ntp: string | null; detail?: string }): string {
  if (a.outcome === 'set') return `Camera time zone set to ${a.zone}.`;
  if (a.outcome === 'already') return `The camera already runs in ${a.zone}.`;
  if (a.outcome === 'unsupported') return "This camera can't set its time zone.";
  return `Not set (${a.zone}): ${a.detail ?? a.outcome}`;
}
