import type { TimeInfo } from '../camera/time';

// The camera's time info for the day limits, refreshed on read: the camera
// client caches it for an hour and keeps its last answer, so this costs at
// most one GetTime per hour. Errors are silent (UTC days until it answers).
// `get` is called each time, so it follows a client rebuilt by restart().
export function refreshingTimeInfo(get: () => Promise<TimeInfo>): () => TimeInfo | undefined {
  let info: TimeInfo | undefined;
  let asking = false;
  return () => {
    if (!asking) {
      asking = true;
      void get().then(
        (t) => void ((info = t), (asking = false)),
        () => void (asking = false),
      );
    }
    return info;
  };
}
