import type { AuditLog } from '../audit/audit-log';
import type { Handler } from '../fleet/commands';
import { MOVE_COMMANDS } from '../fleet/policy';
import type { MoveOfferArgs } from '../fleet/command-args';
import { evaluate, type EvaluateDeps, type Evaluation } from './evaluate';
import type { MoveSource } from './source';
import type { MoveTarget } from './target';
import type { MoveEvent } from './types';

// cams-admin's move commands (cam-proxy plan 2026-10-21-camera-move-cam-proxy):
// the nine handlers by command name. Tasks 2-12 fill them in; until a task
// does, its handler answers failed/internal (the allow entries keep the
// commands off by default).
export interface MoveDeps {
  // Sends a signed move event (CamsAdmin.emitEvent).
  emit: (e: MoveEvent) => void;
  audit: Pick<AuditLog, 'write'>;
  // Filled in by later tasks: the move journal (Task 2), the catalog and
  // storage (Tasks 3, 9), certificates (Task 7), configuration and secrets (Tasks 6, 7).
  // Task 6: the target's evaluation of an offer (move.offer).
  evaluate?: EvaluateDeps;
  // Task 7: the source side (move.targets, move.open, move.answer, move.go, move.release).
  source?: MoveSource;
  // Task 8: the target side from move.start on (the switch-over runner).
  target?: MoveTarget;
  // This proxy's id at cams-admin (the move-offer record names it as the target).
  proxyId?: () => string;
  journal?: unknown;
  catalog?: unknown;
  storage?: unknown;
  certs?: unknown;
  config?: unknown;
  secrets?: unknown;
}

export function moveHandlers(deps: MoveDeps): Record<string, Handler> {
  const stub: Handler = () => ({ status: 'failed', code: 'internal' });
  const handlers: Record<string, Handler> = Object.fromEntries(MOVE_COMMANDS.map((c) => [c, stub]));
  const ev = deps.evaluate;
  if (ev) {
    // The answer carries a reason, never a detail; the token stays out of every message.
    handlers['move.offer'] = async (args) => {
      const a = args as MoveOfferArgs;
      try {
        const answer = await evaluate(ev, a);
        offerAudit(deps, a, answer);
        return { status: 'ok', result: { ...answer } };
      } catch {
        return { status: 'failed', code: 'internal' };
      }
    };
  }
  if (deps.source) Object.assign(handlers, deps.source.handlers());
  if (deps.target) Object.assign(handlers, deps.target.handlers());
  return handlers;
}

// The target's answer to an offer (S §12 move-offer): accept with the space
// result, or the reason. Never the token.
function offerAudit(deps: MoveDeps, a: MoveOfferArgs, e: Evaluation): void {
  const cam = a.camera.proxyCameraId;
  deps.audit.write({
    action: 'move-offer', category: ['configuration'], type: ['change'], outcome: e.accept ? 'success' : 'failure',
    user: 'cams-admin', camera: cam,
    message: `Camera move ${a.moveId} offered: ${cam} from ${a.source.name}: ${e.accept ? `accepted (${e.space.fits ? 'fits' : 'does not fit'})` : `rejected (${e.reason})`}`,
    details: {
      moveId: a.moveId, camera: cam, source: a.source.proxyId, sourceName: a.source.name, target: deps.proxyId?.() || null, role: 'target', accept: e.accept,
      ...(e.accept ? { space: e.space, probeBps: e.probeBps } : { reason: e.reason }),
      bytes: Object.values(a.summary).reduce((n, k) => n + k.bytes, 0),
    },
  });
}
