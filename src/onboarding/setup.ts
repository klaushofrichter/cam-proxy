import { performAction, type ActionDeps, type ActionWho } from '../api/actions';
import { verifyFtp, verifyPush } from '../fleet/camera-commands';
import type { PushAnswer } from '../tls/push';

// The setup an Add camera runs after the camera started (finding 15 of the
// account-move test, 2026-11-08): camera-ftp-setup when the camera uploads
// clips here, camera-cert-push when the site CA covers the camera's TLS name.
// The actions' own code (performAction): one attempt each, never retried (a
// camera that refuses the login is not asked again); the camera writes are
// the actions' whole-object Set + re-read. A failure is a step's answer,
// never an exception: the add stands.
export type SetupAction = 'camera-ftp-setup' | 'camera-cert-push';
export interface SetupStep { action: SetupAction; ok: boolean; detail: string }

const MAX_DETAIL = 200;
const step = (action: SetupAction, ok: boolean, detail: string): SetupStep => ({ action, ok, detail: detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL - 1)}…` : detail });

export async function runSetupAction(d: ActionDeps, action: SetupAction, cam: string, who: ActionWho): Promise<SetupStep> {
  try {
    const r = await performAction(d, action, cam, {}, who);
    if ('error' in r) return step(action, false, r.detail ?? r.error);
    if (action === 'camera-ftp-setup') {
      const t = d.cameraFtp.target(cam);
      const v = verifyFtp('camera-ftp-setup', (r.json ?? {}) as Record<string, unknown>, { server: t.server, port: t.port, tls: t.tls, stream: t.stream });
      return v.verified ? step(action, true, `uploads to ${t.server}:${t.port}`) : step(action, false, `the camera read back other FTP settings: ${v.mismatch.join(', ')}`);
    }
    const a = r.json as PushAnswer;
    if (verifyPush(a).verified) return step(action, true, a.outcome === 'current' ? 'serves its site-CA certificate' : 'site-CA certificate pushed');
    return step(action, false, `${a.outcome}${a.detail ? `: ${a.detail}` : ''}`);
  } catch (err) {
    return step(action, false, (err as Error).message);
  }
}
