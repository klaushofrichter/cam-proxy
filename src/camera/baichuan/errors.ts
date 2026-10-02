// src/camera/baichuan/errors.ts
// Ported from reolink_aio 5d37cb3 and its PR #186 9a1bb52 (MIT; see THIRD_PARTY_NOTICES).
export type BaichuanErrorCode = 'offline' | 'auth' | 'refused' | 'not_found' | 'timeout' | 'protocol';

// Messages are for people and logs: never a path, a password, a nonce or a key.
export class BaichuanError extends Error {
  constructor(
    readonly code: BaichuanErrorCode,
    message: string,
    readonly status?: number, // the camera's status, when it answered
  ) {
    super(message);
    this.name = 'BaichuanError';
  }
}
