// The camera calls cams makes, served by the camera's proxy (spec
// 2026-10-30-camera-onboarding-design §4.8): status, snapshot, settings,
// light and reboot, in the proxy's own terms. Client access is applied by the
// caller; the camera-changing routes add admin access per route (a managed
// admin token passes through MANAGED_ALLOWED for exactly these). Nothing here
// names a Reolink command; a camera's own message never reaches a client.
import express, { type Response } from 'express';
import type { AuditLog } from '../audit/audit-log';
import { CameraError } from '../camera/client';
import type { CameraRegistry } from '../cameras/registry';
import type { CameraWorker } from '../cameras/worker';
import type { Credentials } from '../onboarding/credentials';
import type { CertState } from '../tls/camera-certs';
import { TIMED_OUT, within } from '../async';
import { errorMessage, logger } from '../log';
import type { AccessDeps } from './auth';
import { cameraParam, workerOf } from './camera-param';
import { cameraTls } from './client-api';

export interface CameraCallsDeps {
  cameras: CameraRegistry;
  audit: Pick<AuditLog, 'write'>;
  tls: (id: string) => CertState | undefined;
  served: (id: string) => string | null;
  credentials: (id: string) => Credentials;
  access: AccessDeps;
}

// What a status read waits for the camera at most (GetEnc, the certificate, the time).
const READ_MS = 5_000;

// The value, or null when it took longer than READ_MS or failed.
async function bounded<T>(p: Promise<T>): Promise<T | null> {
  try {
    const v = await within(p, READ_MS, { unref: true });
    return v === TIMED_OUT ? null : v;
  } catch {
    return null;
  }
}

// Refusals in our terms (as ptz-api.ts): offline 503, any other camera failure 502.
export function cameraFailed(res: Response, err: unknown, what: string): void {
  if (err instanceof CameraError) return void res.status(err.code === 'camera_offline' ? 503 : 502).json({ error: err.code === 'camera_offline' ? 'camera_offline' : 'camera_error' });
  logger.error({ cameraId: workerOf(res).id, err: errorMessage(err) }, what);
  res.status(500).json({ error: 'internal' });
}

export function cameraCallsApi(d: CameraCallsDeps): express.Router {
  const r = express.Router();
  r.param('cam', cameraParam(d.cameras));

  // The camera's status (§4.8): online, device, streams, SD card, time,
  // certificate, credentials and TLS. Reads the poller and the caches; the
  // camera is asked (bounded) only while the poller says it is online.
  r.get('/cameras/:cam/status', async (_req, res) => {
    const w: CameraWorker = workerOf(res);
    const st = w.status.state();
    const online = st.online;
    const [streams, certificate, timeInfo] = online
      ? await Promise.all([bounded(w.streams.read()), bounded(w.certificate()), bounded(w.client.timeInfo())])
      : [null, null, w.timeInfo() ?? null];
    const sd = w.sdWatch.view();
    res.json({
      id: w.id,
      online,
      since: st.since,
      checkedAt: st.checkedAt ?? null,
      error: w.error(),
      model: st.model ?? null,
      firmware: st.firmware ?? null,
      hardware: st.hardware ?? null,
      name: w.name(),
      simulator: st.simulator ?? null,
      streams: streams ?? { main: null, sub: null },
      sd: sd ? { present: sd.present, mounted: sd.mounted, capacityMB: sd.capacityMB, freeMB: sd.freeMB, checkedAt: sd.checkedAt } : null,
      time: timeInfo ? { clockOffsetMs: st.clockOffsetMs ?? null, stdOffsetMinutes: timeInfo.stdOffsetMinutes, dstOffsetMinutes: timeInfo.dstOffsetMinutes, dstRule: timeInfo.dstRule ?? null } : null,
      certificate,
      credentials: d.credentials(w.id),
      tls: cameraTls(w, d.tls(w.id), d.served(w.id)),
    });
  });

  return r;
}
