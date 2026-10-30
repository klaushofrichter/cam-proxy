// One login with a given password, on its own session (spec
// 2026-10-30-camera-onboarding-design §4.1, §4.2): never the worker's client,
// so its login backoff and session are untouched. Read-only on the camera
// (GetDevInfo, GetAbility), logged out afterwards. The password is never
// logged: CameraError messages carry no credentials.
import { CameraError, ReolinkClient, type CameraTrust } from '../camera/client';

export type LoginOutcome = 'ok' | 'refused' | 'offline' | 'error';
// `tlsName`: a camera with a public certificate name (verified against the public CAs).
export interface LoginTarget { id: string; host: string; protocol: 'https' | 'http'; user: string; password: string; trust?: CameraTrust; tlsName?: string }
export interface LoginResult { outcome: LoginOutcome; device?: { model: string; firmware: string; name: string | null }; ability?: unknown }

export async function checkLogin(t: LoginTarget, o: { timeoutMs?: number } = {}): Promise<LoginResult> {
  const client = new ReolinkClient({ id: t.id, host: t.host, protocol: t.protocol, user: t.user, password: t.password, ...(t.tlsName ? { tlsServername: t.tlsName } : {}) }, { timeoutMs: o.timeoutMs ?? 10_000, quiet: true });
  if (t.trust) client.setTrust(t.trust);
  try {
    const st = await client.status();
    const ability = await client.command<unknown>('GetAbility', { User: { userName: t.user } });
    return { outcome: 'ok', device: { model: st.model, firmware: st.firmware, name: st.name ?? null }, ability };
  } catch (err) {
    if (err instanceof CameraError && err.code === 'camera_auth_failed') return { outcome: 'refused' };
    if (err instanceof CameraError && err.code === 'camera_offline') return { outcome: 'offline' };
    return { outcome: 'error' };
  } finally {
    await client.logout();
  }
}
