import type { TimeInfo } from '../camera/time';

const RETRY_MS = 60_000;

// The camera's time info for the day limits, refreshed on read: the camera
// client caches it for an hour and keeps its last answer, so this costs at
// most one GetTime per hour. Errors are silent (UTC days until it answers);
// after one, the next ask waits a minute (the camera is down: not one
// GetTime per read). `get` is called each time, so it follows a client
// rebuilt by restart().
export function refreshingTimeInfo(get: () => Promise<TimeInfo>, now: () => number = Date.now): () => TimeInfo | undefined {
  let info: TimeInfo | undefined;
  let asking = false;
  let failedAt: number | undefined;
  return () => {
    if (!asking && (failedAt === undefined || now() - failedAt >= RETRY_MS)) {
      asking = true;
      void get().then(
        (t) => void ((info = t), (failedAt = undefined), (asking = false)),
        () => void ((failedAt = now()), (asking = false)),
      );
    }
    return info;
  };
}
