import express from 'express';
import type { MoveSource, Asker } from '../moves/source';
import { isMoveId } from '../moves/journal';
import { clientIp, type AccessInfo } from './auth';

// The source proxy's camera-move routes (camera-move plan Task 7, S §4, §7):
// mounted under /control behind requireAccess('admin') (sessions need the
// CSRF header). A cams-admin sign-in (a managed session) reaches the writes
// only with the move.send UI unlock (P9, src/api/auth.ts UI_UNLOCKS); a
// cams-admin-managed token never. Answers carry no password, token or key.
const CAMERA = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PROXY_ID = /^prx_[0-9A-HJKMNP-TV-Z]{20}$/;
const REQUEST_ID = /^rq_[0-9A-HJKMNP-TV-Z]{20}$/;
const LABEL_MAX = 64;
// The contract's actor label: 1-64 characters, no control characters.
const label = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, LABEL_MAX) || 'cams-admin sign-in';

// Who is asking (B33): the local admin, or a cams-admin sign-in by its token's display name.
export function askerOf(req: express.Request): Asker {
  const a = req.res?.locals.access as AccessInfo | undefined;
  const managed = a?.origin === 'managed';
  return {
    actor: managed ? { origin: 'managed', label: label(a?.tokenLabel ?? '') } : { origin: 'local', label: 'local admin' },
    user: !managed ? 'admin' : a?.tokenLabel ? `token:${a.tokenLabel}` : 'managed-admin',
    ip: clientIp(req),
    userAgent: req.get('user-agent'),
  };
}

export function movesControlApi(source: MoveSource): express.Router {
  const r = express.Router();
  const refuse = (res: express.Response, cam: string): boolean => {
    const why = source.refusal(cam);
    if (why === 'unknown_camera') return void res.status(404).json({ error: 'unknown_camera' }), true;
    if (why) return void res.status(409).json({ error: 'move_refused', reason: why }), true;
    return false;
  };
  const cameraOf = (req: express.Request, res: express.Response): string | null => {
    const cam = (req.body ?? {}).camera;
    if (typeof cam !== 'string' || !CAMERA.test(cam)) return void res.status(400).json({ error: 'invalid', detail: 'camera' }), null;
    return cam;
  };

  r.get('/moves', (_req, res) => void res.json({ items: source.list() }));

  r.post('/moves/targets', (req, res) => {
    const cam = cameraOf(req, res);
    if (cam === null || refuse(res, cam)) return;
    res.status(202).json(source.startTargets(cam));
  });

  r.get('/moves/targets/:requestId', (req, res) => {
    const t = REQUEST_ID.test(req.params.requestId) ? source.targetsFor(req.params.requestId) : null;
    if (!t) return void res.status(404).json({ error: 'unknown_request' });
    res.json(t);
  });

  r.post('/moves', (req, res) => {
    const cam = cameraOf(req, res);
    if (cam === null) return;
    const target = (req.body ?? {}).target;
    if (typeof target !== 'string' || !PROXY_ID.test(target)) return void res.status(400).json({ error: 'invalid', detail: 'target' });
    if (refuse(res, cam)) return;
    res.status(202).json(source.request(cam, target, askerOf(req)));
  });

  r.post('/moves/:id/approve', (req, res) => {
    if (!isMoveId(req.params.id)) return void res.status(404).json({ error: 'unknown_move' });
    // Not without move.send.
    const why = source.hostRefusal();
    if (why) return void res.status(409).json({ error: 'move_refused', reason: why });
    const out = source.approve(req.params.id, (req.body ?? {}).plan, askerOf(req));
    res.status(out.status).json(out.body);
  });

  r.post('/moves/:id/cancel', (req, res) => {
    const copied = (req.body ?? {}).copied;
    if (copied !== 'delete' && copied !== 'age-out') return void res.status(400).json({ error: 'invalid', detail: 'copied' });
    if (!isMoveId(req.params.id)) return void res.status(404).json({ error: 'unknown_move' });
    const out = source.requestCancel(req.params.id, copied);
    res.status(out.status).json(out.body);
  });

  return r;
}
