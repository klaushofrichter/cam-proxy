import type { NextFunction, Request, Response } from 'express';
import { clientIp } from '../api/auth';
import type { AuditLog } from '../audit/audit-log';
import { logger } from '../log';
import { isMoveId, moveEnded, type MoveJournal, type MoveRecord } from './journal';
import { moveTokenMatches } from './token';

// The only guard of the source's move endpoints (/api/moves/:id/..., S §8.1):
// they sit ahead of the client auth, so no other credential opens them.
// A request passes when the move is a source record of this proxy that has
// not ended, the bearer token's sha256 matches the stored `tokenHash`
// (constant time, B3/B31), and the caller's address equals the target's
// (`peer.ip`, IPv4-mapped forms folded like clientIp). Anything else is one
// answer, 403 move_token, whatever failed; an unreadable journal is 503 busy.
// Refusals are audited (`move-token-refused`) at most once per move and
// reason per 10 minutes, so junk requests naming a real move can't use up the
// record of a later wrong-token or wrong-address attempt; refusals for move
// ids this proxy doesn't have share one bucket, so made-up ids can't flood
// the log. Never the token in a record or log line.
// A valid token from another address (B46/X15): the token is out of the
// target's hands; `onWrongAddress` reports the move once (the proxy sends
// move.phase failed, code token_address), whatever the audit throttle does.
export interface MoveGuardDeps {
  journal: Pick<MoveJournal, 'load'>;
  audit: Pick<AuditLog, 'write'>;
  now?: () => number;
  onWrongAddress?: (r: MoveRecord) => void;
}

export type MoveRefusal = 'no-token' | 'unknown-move' | 'ended' | 'wrong-token' | 'wrong-address';

const WINDOW_MS = 10 * 60_000;
const BEARER = /^Bearer ([\x21-\x7e]{1,512})$/;
const UNKNOWN = '*';

const plainIp = (ip: string): string => ip.trim().replace(/^::ffff:/i, '').toLowerCase();

// The source record a request may use, or why not.
function check(req: Request, r: MoveRecord | null): MoveRefusal | null {
  if (!r || r.role !== 'source') return 'unknown-move';
  if (moveEnded(r.phase)) return 'ended';
  const m = BEARER.exec(req.get('authorization') ?? '');
  if (!m) return 'no-token';
  if (!r.tokenHash || !moveTokenMatches(m[1], r.tokenHash)) return 'wrong-token';
  if (!r.peer?.ip || plainIp(clientIp(req)) !== plainIp(r.peer.ip)) return 'wrong-address';
  return null;
}

export function moveTokenGuard(d: MoveGuardDeps) {
  const now = d.now ?? Date.now;
  const buckets = new Map<string, { until: number; suppressed: number }>();
  const reported = new Set<string>();

  const refused = (req: Request, id: string, r: MoveRecord | null, reason: MoveRefusal) => {
    const key = r ? `${id}|${reason}` : UNKNOWN;
    const t = now();
    const b = buckets.get(key);
    if (b && t < b.until) {
      b.suppressed++;
      return;
    }
    buckets.set(key, { until: t + WINDOW_MS, suppressed: 0 });
    const ip = clientIp(req);
    d.audit.write({
      action: 'move-token-refused', category: ['authentication'], type: ['denied'], outcome: 'failure',
      ip, userAgent: req.get('user-agent'),
      ...(r ? { camera: r.camera } : {}),
      message: `Move endpoint refused for ${isMoveId(id) ? id : 'an unknown move'} from ${ip || 'unknown'} (${reason})`,
      details: { moveId: isMoveId(id) ? id : null, reason, path: req.path.slice(0, 256), suppressed: b?.suppressed ?? 0 },
    });
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    const id = String(req.params.id ?? '');
    let r: MoveRecord | null = null;
    if (isMoveId(id)) {
      try {
        r = d.journal.load(id);
      } catch (err) {
        logger.warn({ moveId: id, code: (err as NodeJS.ErrnoException).code ?? 'error' }, 'move_journal_unreadable');
        res.set('Cache-Control', 'no-store');
        return void res.status(503).json({ error: 'busy' });
      }
    }
    const why = check(req, r);
    if (why) {
      refused(req, id, r, why);
      if (why === 'wrong-address' && r && !reported.has(r.id)) {
        reported.add(r.id);
        try {
          d.onWrongAddress?.(r);
        } catch (err) {
          logger.warn({ moveId: r.id, err: (err as Error).message }, 'move_wrong_address_report_failed');
        }
      }
      res.set('Cache-Control', 'no-store');
      return void res.status(403).json({ error: 'move_token' });
    }
    res.locals.move = r;
    next();
  };
}
