import express, { type Request, type Response } from 'express';
import type { OnboardingService, Refusal, Who } from '../onboarding/service';
import { actorOf, clientIp, type AccessInfo } from './auth';
import { cameraParam } from './camera-param';

// The onboarding routes (spec 2026-10-30-camera-onboarding-design §4), mounted
// on /control behind requireAccess('admin'). A camera password is write-only:
// never in an answer, a log line or an audit record.
export const whoOf = (req: Request, res: Response): Who => ({
  user: actorOf(res.locals.access as AccessInfo | undefined),
  requestedBy: res.locals.access?.viaCookie ? 'session' : 'token',
  ip: clientIp(req),
  ...(req.get('user-agent') ? { userAgent: req.get('user-agent') } : {}),
});

export function sendOutcome(res: Response, o: { status: number } & Record<string, unknown>): void {
  if (typeof o.retryAfterS === 'number') res.setHeader('Retry-After', String(o.retryAfterS));
  if (typeof o.error === 'string') {
    const r = o as unknown as Refusal;
    res.locals.errorCode = r.error;
    return void res.status(r.status).json({ error: r.error, ...(r.detail ? { detail: r.detail } : {}), ...(r.extra ?? {}) });
  }
  const { status, retryAfterS: _r, ...body } = o;
  res.status(status).json(body);
}

export function onboardingApi(s: OnboardingService): express.Router {
  const r = express.Router();
  r.param('cam', cameraParam(s.d.cameras, 'admin'));
  // Write-only: 200 {credentials}; the value is never returned.
  // The onboarding status (§4.5): one camera's, or every camera's in config order.
  r.get('/onboarding', async (_req, res) => void res.json({ cameras: await s.status() }));
  r.get('/cameras/:cam/onboarding', async (req, res) => {
    const [one] = await s.status(String(req.params.cam));
    if (!one) return void res.status(404).json({ error: 'not_found' });
    res.json(one);
  });
  r.put('/cameras/:cam/password', async (req, res) => sendOutcome(res, await s.savePassword(String(req.params.cam), req.body?.password, whoOf(req, res))));
  return r;
}
