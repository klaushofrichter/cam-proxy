// Small async helpers shared by the loops and the shutdown paths.

export const abortError = (why = 'aborted'): Error => Object.assign(new Error(why), { name: 'AbortError' });
export const isAbort = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError';

// Waits `ms`; an abort ends the wait early (it resolves, never rejects).
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export const TIMED_OUT = Symbol('timed out');

// `p`, but at most `ms`: TIMED_OUT when it took longer (p keeps running).
export async function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<typeof TIMED_OUT>((r) => (timer = setTimeout(() => r(TIMED_OUT), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}
