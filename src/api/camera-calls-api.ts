// The camera calls cams makes, served by the camera's proxy (spec
// 2026-10-30-camera-onboarding-design §4.8): status, snapshot, settings,
// light and reboot, in the proxy's own terms. Client access is applied by the
// caller; the camera-changing routes add admin access per route (a managed
// admin token passes through MANAGED_ALLOWED for exactly these). Nothing here
// names a Reolink command; a camera's own message never reaches a client.
import express, { type Request, type Response } from 'express';
import type { AuditLog } from '../audit/audit-log';
import { withCamera } from '../audit/audit-log';
import { isSection, readSection, writeSection, type SettingsSection } from '../camera/settings/io';
import { CameraError } from '../camera/client';
import type { CameraRegistry } from '../cameras/registry';
import type { CameraWorker } from '../cameras/worker';
import type { Credentials } from '../onboarding/credentials';
import type { CertState } from '../tls/camera-certs';
import { sleep, TIMED_OUT, within } from '../async';
import { errorMessage, logger } from '../log';
import { actorOf, clientIp, requireAccess, type AccessDeps, type AccessInfo } from './auth';
import { cameraParam, workerOf } from './camera-param';
import { bad } from './respond';
import { cameraTls } from './client-api';

export interface CameraCallsDeps {
  cameras: CameraRegistry;
  audit: Pick<AuditLog, 'write'>;
  tls: (id: string) => CertState | undefined;
  served: (id: string) => string | null;
  credentials: (id: string) => Credentials;
  access: AccessDeps;
}

// The light's re-read after a switch (cams server/routes/settings.ts, measured lag).
const LIGHT = { waitMs: 5_000, pollMs: 250 };

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

  // An on-demand snapshot (§4.8): main is the camera's own picture (full
  // size); sub a frame of the sub stream from the host's go2rtc (only for a
  // camera that has a go2rtc stream, i.e. stills on). Never cached.
  r.get('/cameras/:cam/snapshot.jpg', async (req, res) => {
    const stream = req.query.stream ?? 'main';
    if (stream !== 'main' && stream !== 'sub') return bad(res, 'stream is main or sub');
    const w = workerOf(res);
    const go2rtc = w.stills?.go2rtc;
    if (stream === 'sub' && !go2rtc) return void res.status(404).json({ error: 'stream_unavailable' });
    if (!w.status.state().online) return void res.status(503).json({ error: 'camera_offline' });
    let jpeg: Buffer;
    try {
      jpeg = stream === 'main' ? await w.client.snapshot() : await go2rtc!.frame(w.id, 'sub');
    } catch (err) {
      if (stream === 'sub') {
        logger.warn({ cameraId: w.id, err: errorMessage(err) }, 'snapshot_frame_failed');
        return void res.status(502).json({ error: 'camera_error' });
      }
      return cameraFailed(res, err, 'snapshot_failed');
    }
    res.type('image/jpeg').setHeader('Cache-Control', 'no-store');
    res.send(jpeg);
  });

  // --- settings (§4.8): cams's two sections ----------------------------------
  const command = (w: CameraWorker) => <T>(cmd: string, param?: object) => w.client.command<T>(cmd, param);
  // The section of the path, or undefined once answered (404).
  const sectionOf = (req: Request, res: Response): SettingsSection | undefined => {
    const s = req.params.section;
    if (isSection(s)) return s;
    res.status(404).json({ error: 'not_found' });
    return undefined;
  };
  const offline = (res: Response) => void res.status(503).json({ error: 'camera_offline' });

  r.get('/cameras/:cam/settings', async (_req, res) => {
    const w = workerOf(res);
    if (!w.status.state().online) return offline(res);
    try {
      const detection = (await readSection(command(w), 'detection')).settings;
      const image = (await readSection(command(w), 'image')).settings;
      res.json({ detection, image });
    } catch (err) {
      cameraFailed(res, err, 'settings_read_failed');
    }
  });

  r.get('/cameras/:cam/settings/:section', async (req, res) => {
    const section = sectionOf(req, res);
    if (!section) return;
    const w = workerOf(res);
    if (!w.status.state().online) return offline(res);
    try {
      res.json((await readSection(command(w), section)).settings);
    } catch (err) {
      cameraFailed(res, err, 'settings_read_failed');
    }
  });

  const requestedBy = (res: Response) => ((res.locals.access as AccessInfo | undefined)?.viaCookie ? 'session' : 'token');
  const who = (req: Request, res: Response) => ({ user: actorOf(res.locals.access as AccessInfo | undefined), ip: clientIp(req), userAgent: req.get('user-agent') });

  // Admin-kind (a managed admin token through MANAGED_ALLOWED). One write at a
  // time per camera; the camera session ends afterwards. Audited unless it
  // was refused before anything was written (400, offline).
  r.put('/cameras/:cam/settings/:section', requireAccess('admin', d.access), async (req, res) => {
    const section = sectionOf(req, res);
    if (!section) return;
    const w = workerOf(res);
    if (!w.status.state().online) return offline(res);
    const sent: string[] = [];
    try {
      const out = await w.writeLock.run(async () => {
        try {
          return await writeSection(command(w), section, req.body, { sent: (c) => sent.push(c) });
        } finally {
          await w.client.logout();
        }
      });
      if (out.status === 400) return void res.status(400).json({ error: 'invalid', details: out.details });
      if (out.unexpected.length) logger.warn({ cameraId: w.id, section, keys: out.unexpected.slice(0, 20) }, 'camera_setting_side_effect');
      const failed = Object.values(out.fields).find((f) => !f.ok)?.error;
      const fields = Object.fromEntries(Object.entries(out.fields).map(([k, f]) => [k, f.ok ? 'ok' : f.error]));
      withCamera(d.audit, w.id).write({
        action: 'camera-settings', category: ['configuration'], type: ['change'], outcome: failed ? 'failure' : 'success', ...who(req, res),
        message: `Camera settings (${section}) ${failed ? `partly not saved (${failed})` : 'saved'}: ${Object.keys(out.fields).join(', ') || 'nothing to change'}`,
        ...(failed ? { error: failed } : {}),
        details: { section, patch: out.patch, fields, unexpected: out.unexpected.slice(0, 20), requestedBy: requestedBy(res) },
      });
      res.status(out.status).json({ fields: out.fields, settings: out.settings });
    } catch (err) {
      // Offline or refused mid-write: a change may have reached the camera.
      if (sent.length) {
        const code = err instanceof CameraError ? err.code : 'camera_error';
        withCamera(d.audit, w.id).write({
          action: 'camera-settings', category: ['configuration'], type: ['change'], outcome: 'failure', ...who(req, res),
          message: `Camera settings (${section}) failed (${code})`, error: code,
          details: { section, patch: req.body as unknown, fields: {}, unexpected: [], requestedBy: requestedBy(res) },
        });
      }
      cameraFailed(res, err, 'settings_write_failed');
    }
  });

  // --- light (§4.8): the camera's manual light, WhiteLed.state 1 on, 0 off --
  // It stays on until switched off (measured on cam1 2026-09-29). The camera
  // reports the new state late, about 1 s after switching on and 3 s after
  // switching off (measured 2026-09-30), so the re-read is repeated for up to
  // 5 s before the switch counts as not applied.
  const readWhiteLed = async (w: CameraWorker): Promise<Record<string, unknown>> => (await w.client.command<{ WhiteLed?: Record<string, unknown> }>('GetWhiteLed', { channel: 0 })).WhiteLed ?? {};

  r.get('/cameras/:cam/light', async (_req, res) => {
    const w = workerOf(res);
    if (!w.status.state().online) return offline(res);
    try {
      res.json({ on: (await readWhiteLed(w)).state === 1 });
    } catch (err) {
      cameraFailed(res, err, 'light_read_failed');
    }
  });

  r.put('/cameras/:cam/light', requireAccess('admin', d.access), async (req, res) => {
    const body = req.body as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as { on?: unknown }).on !== 'boolean') return bad(res, 'the body is exactly {"on": true|false}');
    const want = (body as { on: boolean }).on;
    const w = workerOf(res);
    if (!w.status.state().online) return offline(res);
    try {
      const out = await w.writeLock.run(async () => {
        try {
          const before = await readWhiteLed(w);
          const was = before.state === 1;
          if (was === want) return { changed: false as const, on: want };
          await w.client.command('SetWhiteLed', { WhiteLed: { ...before, channel: 0, state: want ? 1 : 0 } });
          const until = Date.now() + LIGHT.waitMs;
          let on = (await readWhiteLed(w)).state === 1;
          while (on !== want && Date.now() < until) {
            await sleep(LIGHT.pollMs);
            on = (await readWhiteLed(w)).state === 1;
          }
          return { changed: true as const, was, on };
        } finally {
          await w.client.logout();
        }
      });
      if (!out.changed) return void res.json({ on: want });
      const ok = out.on === want;
      withCamera(d.audit, w.id).write({
        action: 'camera-light', category: ['configuration'], type: ['change'], outcome: ok ? 'success' : 'failure', ...who(req, res),
        message: `Camera light switched ${want ? 'on' : 'off'}${ok ? '' : ': not applied (the camera did not report it)'}`,
        ...(ok ? {} : { error: 'not_applied' }),
        details: { from: out.was, to: want, requestedBy: requestedBy(res) },
      });
      if (!ok) return void res.status(502).json({ error: 'not_applied', on: out.on });
      res.json({ on: want });
    } catch (err) {
      cameraFailed(res, err, 'light_write_failed');
    }
  });

  return r;
}
