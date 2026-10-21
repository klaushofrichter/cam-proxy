import type { AuditLog } from '../audit/audit-log';
import type { Handler } from '../fleet/commands';
import { MOVE_COMMANDS } from '../fleet/policy';
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
  journal?: unknown;
  catalog?: unknown;
  storage?: unknown;
  certs?: unknown;
  config?: unknown;
  secrets?: unknown;
}

export function moveHandlers(_deps: MoveDeps): Record<string, Handler> {
  const stub: Handler = () => ({ status: 'failed', code: 'internal' });
  return Object.fromEntries(MOVE_COMMANDS.map((c) => [c, stub]));
}
