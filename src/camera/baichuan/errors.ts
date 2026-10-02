// src/camera/baichuan/errors.ts
// Ported from reolink_aio 5d37cb3 and its PR #186 9a1bb52 (MIT; see THIRD_PARTY_NOTICES).
export type BaichuanErrorCode = 'offline' | 'auth' | 'refused' | 'not_found' | 'timeout' | 'protocol';

// Messages are for people and logs: never a path, a password, a nonce or a key.
export class BaichuanError extends Error {
  constructor(
    readonly code: BaichuanErrorCode,
    message: string,
    readonly status?: number, // the camera's status, when it answered
    // 'connect': no connection to the camera was made (the camera is
    // unreachable), as against a connection lost after it was up.
    // 'writer': a stall while the output didn't take the bytes (a slow or
    // paused client): not the camera's fault.
    readonly phase?: 'connect' | 'writer',
  ) {
    super(message);
    this.name = 'BaichuanError';
  }
}

// A stall caused by the output, not the camera: treated like an abort.
export const isWriterStall = (e: unknown): boolean => e instanceof BaichuanError && e.code === 'timeout' && e.phase === 'writer';
