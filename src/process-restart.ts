import { TIMED_OUT, within } from './async';
import { logger } from './log';

// How long a restart waits for the graceful stop before it exits anyway, so
// a stuck camera logout can't block a restart (issue #71).
const RESTART_STOP_TIMEOUT_MS = 15_000;

// Restarts the process (issue #71): the normal stop, then exit 0, and the
// supervisor (compose `restart: unless-stopped`, the cluster Deployment)
// starts it again. No re-exec: in a container the process is PID 1. `exit`
// is injected so tests never end the test runner.
export async function restartProcess(d: { stop: () => Promise<void>; exit: (code: number) => void; timeoutMs?: number }): Promise<'stopped' | 'failed' | 'timeout'> {
  const stopped = d.stop().then(
    () => 'stopped' as const,
    (err: Error) => {
      logger.error({ err: err.message }, 'restart_stop_failed');
      return 'failed' as const;
    },
  );
  const r = await within(stopped, d.timeoutMs ?? RESTART_STOP_TIMEOUT_MS);
  const result = r === TIMED_OUT ? 'timeout' : r;
  if (result === 'timeout') logger.error({ timeoutMs: d.timeoutMs ?? RESTART_STOP_TIMEOUT_MS }, 'restart_stop_timed_out');
  logger.info({ result }, 'cam_proxy_exiting_for_restart');
  d.exit(0);
  return result;
}
