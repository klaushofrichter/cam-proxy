import { killChildren } from './children';
import { logger } from './log';

// What the process does on SIGTERM/SIGINT (src/cli.ts): stop the proxy
// gracefully and exit 0. A stop that takes longer than `timeoutMs`, or a
// second signal, kills the children (go2rtc, ffmpeg) and exits 1 at once, so
// no child outlives the process with its ports.
export function shutdownHandler(o: { stop: (reason: string) => Promise<unknown>; exit: (code: number) => void; timeoutMs?: number }): (sig: string) => void {
  let stopping = false;
  const hard = (why: string) => {
    logger.warn({ why }, 'cam_proxy_stop_forced');
    killChildren();
    o.exit(1);
  };
  return (sig: string) => {
    if (stopping) return hard(`second signal ${sig}`);
    stopping = true;
    logger.info({ sig }, 'cam_proxy_stopping');
    const t = setTimeout(() => hard('stop timed out'), o.timeoutMs ?? 10_000);
    t.unref();
    void o.stop(sig).then(
      () => (clearTimeout(t), o.exit(0)),
      (err: Error) => (clearTimeout(t), logger.error({ err: err.message }, 'cam_proxy_stop_failed'), killChildren(), o.exit(1)),
    );
  };
}
