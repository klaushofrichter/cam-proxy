import type { AuditLog } from '../audit/audit-log';
import type { Done, Handler } from '../fleet/commands';
import { MOVE_COMMANDS } from '../fleet/policy';
import type { MoveCancelArgs, MoveFinishArgs, MoveOfferArgs } from '../fleet/command-args';
import { evaluate, type EvaluateDeps, type Evaluation } from './evaluate';
import type { MoveReturns } from './returns';
import type { MoveSource } from './source';
import type { MoveTarget } from './target';
import type { MoveEvent } from './types';

// cams-admin's move commands (cam-proxy plan 2026-10-21-camera-move-cam-proxy):
// the nine handlers by command name; one this proxy can't serve (no source
// or target side wired) answers failed/internal (the allow entries keep the
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
  // Step 4 Task 9: the copy back (move.return.open/.start, move.finish {return: true}).
  returns?: MoveReturns;
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
  if (deps.returns) Object.assign(handlers, deps.returns.handlers());
  // Task 10: move.finish and move.cancel by the side the args name (the allow
  // entry was checked for that side, entryFor). A side this proxy can't play answers internal.
  const bySide = (fn: (side: MoveSource | MoveTarget, a: never) => Promise<Done>): Handler => async (args) => {
    const side = (args as { role?: string }).role === 'target' ? deps.target : deps.source;
    if (!side) return { status: 'failed', code: 'internal' };
    try {
      return await fn(side, args as never);
    } catch {
      return { status: 'failed', code: 'internal' };
    }
  };
  const finish = bySide((side, a: MoveFinishArgs) => side.finish(a));
  // A return's finish (ruling 2): the returns side, whichever role it names.
  handlers['move.finish'] = async (args, cmd) => {
    if ((args as { return?: unknown }).return !== true) return finish(args, cmd);
    if (!deps.returns) return { status: 'failed', code: 'internal' };
    try {
      return await deps.returns.finish(args as MoveFinishArgs);
    } catch {
      return { status: 'failed', code: 'internal' };
    }
  };
  handlers['move.cancel'] = bySide((side, a: MoveCancelArgs) => side.cancel(a));
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
