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
import { tooSoonDetail } from './actions';
import { whoOf } from './onboarding-api';
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
// How old a settings or light read may be when answered again.
const READ_CACHE_MS = 5_000;

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
  const snaps = new Map<string, Promise<Buffer>>();
  const sharedSnap = (w: CameraWorker): Promise<Buffer> => {
    const running = snaps.get(w.id);
    if (running) return running;
    const p = w.client.snapshot().finally(() => {
      if (snaps.get(w.id) === p) snaps.delete(w.id);
    });
    snaps.set(w.id, p);
    return p;
  };
  r.get('/cameras/:cam/snapshot.jpg', async (req, res) => {
    const stream = req.query.stream ?? 'main';
    if (stream !== 'main' && stream !== 'sub') return bad(res, 'stream is main or sub');
    const w = workerOf(res);
    const go2rtc = w.stills?.go2rtc;
    if (stream === 'sub' && !go2rtc) return void res.status(404).json({ error: 'stream_unavailable' });
    if (!w.status.state().online) return void res.status(503).json({ error: 'camera_offline' });
    let jpeg: Buffer;
    try {
      // One main snapshot in flight per camera: further callers share it.
      jpeg = stream === 'main' ? await sharedSnap(w) : await go2rtc!.frame(w.id, 'sub');
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

  // --- shared reads: a looping client can't starve the status poller --------
  // The camera client has two request slots, shared with the status poller.
  // Reads of one camera share one request in flight, and settings and light
  // answer from a result up to READ_CACHE_MS old; a camera-changing call drops
  // the camera's cached reads.
  const inflight = new Map<string, Promise<unknown>>();
  const cached = new Map<string, { at: number; value: unknown }>();
  const shared = <T>(w: CameraWorker, key: string, read: () => Promise<T>, cacheMs = 0): Promise<T> => {
    const k = `${w.id}\u0000${key}`;
    const hit = cached.get(k);
    if (cacheMs && hit && Date.now() - hit.at < cacheMs) return Promise.resolve(hit.value as T);
    const running = inflight.get(k) as Promise<T> | undefined;
    if (running) return running;
    const p = read().then((value) => {
      if (cacheMs && inflight.get(k) === p) cached.set(k, { at: Date.now(), value });
      return value;
    }).finally(() => {
      if (inflight.get(k) === p) inflight.delete(k);
    });
    inflight.set(k, p);
    return p;
  };
  const forget = (w: CameraWorker) => {
    for (const m of [cached, inflight] as Map<string, unknown>[]) for (const k of [...m.keys()]) if (k.startsWith(`${w.id}\u0000`)) m.delete(k);
  };
  // A read bounded like the status (READ_MS): 504 camera_timeout on expiry.
  const timedRead = async <T>(res: Response, p: Promise<T>, what: string): Promise<T | undefined> => {
    try {
      const v = await within(p, READ_MS, { unref: true });
      if (v === TIMED_OUT) return void res.status(504).json({ error: 'camera_timeout' }), undefined;
      return v;
    } catch (err) {
      cameraFailed(res, err, what);
      return undefined;
    }
  };

  // --- settings (§4.8): cams's two sections ----------------------------------
  const command = (w: CameraWorker) => <T>(cmd: string, param?: object) => w.client.command<T>(cmd, param);
  const offline = (res: Response) => void res.status(503).json({ error: 'camera_offline' });
  const readSettings = (w: CameraWorker, section: SettingsSection) => shared(w, `settings:${section}`, async () => (await readSection(command(w), section)).settings, READ_CACHE_MS);

  r.get('/cameras/:cam/settings', async (_req, res) => {
    const w = workerOf(res);
    if (!w.status.state().online) return offline(res);
    const v = await timedRead(res, Promise.all([readSettings(w, 'detection'), readSettings(w, 'image')]), 'settings_read_failed');
    if (v) res.json({ detection: v[0], image: v[1] });
  });

  r.get('/cameras/:cam/settings/:section', async (req, res) => {
    const section = req.params.section;
    if (!isSection(section)) return void res.status(404).json({ error: 'not_found' });
    const w = workerOf(res);
    if (!w.status.state().online) return offline(res);
    const v = await timedRead(res, readSettings(w, section), 'settings_read_failed');
    if (v) res.json(v);
  });

  const requestedBy = (res: Response) => ((res.locals.access as AccessInfo | undefined)?.viaCookie ? 'session' : 'token');
  const who = (req: Request, res: Response) => ({ user: actorOf(res.locals.access as AccessInfo | undefined), ip: clientIp(req), userAgent: req.get('user-agent') });
  // The key names of a body (at most 20, each cut to 64 characters): never a value.
  const fieldNames = (body: unknown): string[] => (body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).slice(0, 20).map((k) => k.slice(0, 64)) : []);
  // A path segment for a record: printable, at most 40 characters.
  const segment = (v: unknown): string => String(v).replace(/[^\x20-\x7e]/g, '?').slice(0, 40);
  const codeOf = (err: unknown): string => (err instanceof CameraError ? err.code : 'camera_error');

  // Admin-kind (a managed admin token through MANAGED_ALLOWED). One write at a
  // time per camera; the camera session ends afterwards. Every request that
  // passed the access check is audited, refusals included (the section and the
  // field names only, never a value for a refusal).
  r.put('/cameras/:cam/settings/:section', requireAccess('admin', d.access), async (req, res) => {
    const w = workerOf(res);
    const refuse = (status: number, error: string, section: string, extra: Record<string, unknown> = {}) => {
      withCamera(d.audit, w.id).write({
        action: 'camera-settings', category: ['configuration'], type: ['change'], outcome: 'failure', ...who(req, res),
        message: `Camera settings (${section}) refused (${error})`, error,
        details: { section, fieldNames: fieldNames(req.body), sent: false, requestedBy: requestedBy(res) },
      });
      res.status(status).json({ error, ...extra });
    };
    const section = req.params.section;
    if (!isSection(section)) return refuse(404, 'not_found', segment(section));
    if (!w.status.state().online) return refuse(503, 'camera_offline', section);
    const sent: string[] = [];
    forget(w);
    try {
      const out = await w.writeLock.run(async () => {
        try {
          return await writeSection(command(w), section, req.body, { sent: (c) => sent.push(c) });
        } finally {
          forget(w);
          await w.client.logout();
        }
      });
      if (out.status === 400) return refuse(400, 'invalid', section, { details: out.details });
      if (out.unexpected.length) logger.warn({ cameraId: w.id, section, keys: out.unexpected.slice(0, 20) }, 'camera_setting_side_effect');
      const failed = Object.values(out.fields).find((f) => !f.ok)?.error;
      const fields = Object.fromEntries(Object.entries(out.fields).map(([k, f]) => [k, f.ok ? 'ok' : f.error]));
      withCamera(d.audit, w.id).write({
        action: 'camera-settings', category: ['configuration'], type: ['change'], outcome: failed ? 'failure' : 'success', ...who(req, res),
        message: `Camera settings (${section}) ${failed ? `partly not saved (${failed})` : 'saved'}: ${Object.keys(out.fields).join(', ') || 'nothing to change'}`,
        ...(failed ? { error: failed } : {}),
        details: { section, patch: out.patch, fields, unexpected: out.unexpected.slice(0, 20), sent: sent.length > 0, requestedBy: requestedBy(res) },
      });
      res.status(out.status).json({ fields: out.fields, settings: out.settings });
    } catch (err) {
      // Offline or refused before or during the write: when a Set was sent, a change may have reached the camera.
      const code = codeOf(err);
      withCamera(d.audit, w.id).write({
        action: 'camera-settings', category: ['configuration'], type: ['change'], outcome: 'failure', ...who(req, res),
        message: `Camera settings (${section}) failed (${code})${sent.length ? ': a change was sent, its state is unknown' : ''}`, error: code,
        details: { section, fieldNames: fieldNames(req.body), sent: sent.length > 0, requestedBy: requestedBy(res) },
      });
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
    const on = await timedRead(res, shared(w, 'light', async () => (await readWhiteLed(w)).state === 1, READ_CACHE_MS), 'light_read_failed');
    if (on !== undefined) res.json({ on });
  });

  // Every request that passed the access check is audited (camera-light):
  // refusals, the no-op, the switch, and a failure (with whether the Set was sent).
  r.put('/cameras/:cam/light', requireAccess('admin', d.access), async (req, res) => {
    const w = workerOf(res);
    const body = req.body as unknown;
    const valid = typeof body === 'object' && body !== null && !Array.isArray(body) && Object.keys(body).length === 1 && typeof (body as { on?: unknown }).on === 'boolean';
    const want = valid ? (body as { on: boolean }).on : undefined;
    const record = (outcome: 'success' | 'failure', message: string, details: Record<string, unknown>, error?: string) => withCamera(d.audit, w.id).write({
      action: 'camera-light', category: ['configuration'], type: ['change'], outcome, ...who(req, res), message, ...(error ? { error } : {}),
      details: { ...(want !== undefined ? { to: want } : {}), ...details, requestedBy: requestedBy(res) },
    });
    if (want === undefined) {
      record('failure', 'Camera light refused: the body is not {"on": true|false}', { sent: false }, 'invalid');
      return bad(res, 'the body is exactly {"on": true|false}');
    }
    forget(w);
    if (!w.status.state().online) {
      record('failure', `Camera light ${want ? 'on' : 'off'} refused (camera_offline)`, { sent: false }, 'camera_offline');
      return offline(res);
    }
    let sent = false;
    try {
      const out = await w.writeLock.run(async () => {
        try {
          const before = await readWhiteLed(w);
          const was = before.state === 1;
          if (was === want) return { changed: false as const, was, on: want };
          sent = true;
          await w.client.command('SetWhiteLed', { WhiteLed: { ...before, channel: 0, state: want ? 1 : 0 } });
          const until = Date.now() + LIGHT.waitMs;
          let on = (await readWhiteLed(w)).state === 1;
          while (on !== want && Date.now() < until) {
            await sleep(LIGHT.pollMs);
            on = (await readWhiteLed(w)).state === 1;
          }
          return { changed: true as const, was, on };
        } finally {
          forget(w);
          await w.client.logout();
        }
      });
      if (!out.changed) {
        record('success', `Camera light already ${want ? 'on' : 'off'}: nothing sent`, { from: out.was, changed: false, sent: false });
        return void res.json({ on: want });
      }
      const ok = out.on === want;
      record(ok ? 'success' : 'failure', `Camera light switched ${want ? 'on' : 'off'}${ok ? '' : ': not applied (the camera did not report it)'}`, { from: out.was, changed: ok, sent: true }, ok ? undefined : 'not_applied');
      if (!ok) return void res.status(502).json({ error: 'not_applied', on: out.on });
      res.json({ on: want });
    } catch (err) {
      const code = codeOf(err);
      record('failure', `Camera light ${want ? 'on' : 'off'} failed (${code})${sent ? ': the switch was sent, its state is unknown' : ''}`, { sent }, code);
      cameraFailed(res, err, 'light_write_failed');
    }
  });

  // --- reboot (§4.8): the camera-reboot action, for cams's managed admin token --
  // Only the exact confirmation body reboots. Audited by CameraReboot itself
  // (camera-reboot). A refusal names no camera command or code.
  r.post('/cameras/:cam/reboot', requireAccess('admin', d.access), async (req, res) => {
    const b = req.body as unknown;
    if (typeof b !== 'object' || b === null || Array.isArray(b) || Object.keys(b).length !== 1 || (b as { confirm?: unknown }).confirm !== 'reboot') return bad(res, 'the body is exactly {"confirm": "reboot"}');
    const w = workerOf(res);
    const a = await w.reboot.request(whoOf(req, res));
    if (a.status === 202) return void res.status(202).json({ confirmed: a.confirmed });
    if (a.status === 429) {
      res.setHeader('Retry-After', String(a.retryAfterS));
      return void res.status(429).json({ error: 'too_soon', detail: tooSoonDetail(a) });
    }
    const offline = a.error === 'camera_offline';
    res.status(offline ? 503 : 502).json({ error: offline ? 'camera_offline' : 'camera_error', detail: 'the reboot request did not reach the camera' });
  });

  return r;
}
