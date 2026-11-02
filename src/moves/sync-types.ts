// The post-move sync's record (issue #311, sync.ts), kept in the move's
// tombstone (journal.ts). Plain data: no behaviour.

// pending: waiting (for its time, the copy back, the camera, a retry);
// running: its inventories run; done: it ran to its end (clips.stopped says
// whether that end was early); failed: it can't run (the camera is gone from
// this proxy, a person cancelled one of its runs); gave-up: still not done 24 h
// after it became due (the camera offline, a run failing), `error` says why.
export type MoveSyncState = 'pending' | 'running' | 'done' | 'failed' | 'gave-up';
// finished: the receiving proxy after move.finish; cancelled: the original
// proxy after a cancel past the switch-over (the camera runs here again).
export type MoveSyncTrigger = 'finished' | 'cancelled';
// Why the clips loop ended with recordings still missing: a repair's stop
// (retention-full, paused, failures, refused), nothing-fetched (a repair got
// none), round-cap (MAX_ROUNDS checks); null: nothing missing at the end.
export interface MoveSyncClips { missingBefore: number; fetched: number; missingAfter: number; rounds: number; stopped: string | null }
export interface MoveSyncEvents { missing: number; added: number }

export interface MoveSyncRecord {
  state: MoveSyncState;
  trigger: MoveSyncTrigger;
  camera: string;
  requestedAt: number;
  // Not before this (a cancel's wait for the copy back, a retry's backoff).
  dueAt: number;
  // A cancel: waiting for its copy back (the return) to finish, or for dueAt.
  waitReturn?: boolean;
  // When it first became due: the 24 h until it gives up count from here.
  since?: number;
  attempts: number;
  startedAt?: number;
  finishedAt?: number;
  // The step to run next (a retry goes on from it): clips, then events.
  step?: 'clips' | 'events';
  clips?: MoveSyncClips;
  events?: MoveSyncEvents;
  // The last retry's reason while pending; why it failed or gave up at the end.
  error?: string;
}
