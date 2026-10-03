import { EventEmitter } from 'events';
import { sleep } from '../async';
import type { ReolinkClient } from '../camera/client';
import type { Config } from '../config/defaults';
import { logger } from '../log';
import { OnvifAuthError, OnvifSubscription } from './onvif';
import { pollStates } from './poll';
import { topicKind, type EventTracker } from './tracker';

export interface IntakeState {
  onvif: 'subscribed' | 'connecting' | 'down';
  since: number;
  source: 'onvif' | 'poll' | 'none';
  lastError?: string;
  resubscribes: number;
}

// Keeps an ONVIF PullPoint subscription alive and feeds the tracker. While
// ONVIF is down longer than events.poll.afterOnvifDownS, it polls
// GetMdState/GetAiState instead, until ONVIF is back.
export class EventIntake extends EventEmitter {
  private st: IntakeState = { onvif: 'down', since: Date.now(), source: 'none', resubscribes: 0 };
  private running = false;
  private stopper = new AbortController();
  private pullAbort: AbortController | undefined;
  private loop: Promise<void> | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private polling = false; // ticking, not just waiting to start
  private sweepTimer: NodeJS.Timeout | undefined;
  private everSubscribed = false;
  private deliberate = false; // resubscribe() asked for a new subscription
  private downSince = Date.now();
  private readonly topics = new Map<string, boolean>(); // per ONVIF topic
  private readonly sub: OnvifSubscription;

  constructor(
    private readonly d: {
      client: ReolinkClient;
      tracker: EventTracker;
      cfg: Config['events'];
      onvif: { host: string; port: number; user: string; password: string };
      backoff?: { minMs: number; maxMs: number };
    },
  ) {
    super();
    this.sub = new OnvifSubscription(d.onvif, { subscribeMin: d.cfg.onvif.subscribeMin, pullTimeoutS: d.cfg.onvif.pullTimeoutS });
  }

  state(): IntakeState {
    return { ...this.st };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopper = new AbortController();
    this.downSince = Date.now();
    this.loop = this.run();
    this.sweepTimer = setInterval(() => this.d.tracker.sweep(), 10_000);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.stopper.abort();
    this.pullAbort?.abort();
    this.stopPolling();
    clearInterval(this.sweepTimer);
    await this.loop;
    await this.sub.unsubscribe().catch(() => undefined);
    this.set({ onvif: 'down', source: 'none' });
  }

  // Drops the current subscription; the loop subscribes again.
  resubscribe(): void {
    this.deliberate = true;
    this.pullAbort?.abort();
  }

  private set(p: Partial<IntakeState>): void {
    const before = JSON.stringify(this.st);
    const changedOnvif = p.onvif !== undefined && p.onvif !== this.st.onvif;
    this.st = { ...this.st, ...p, ...(changedOnvif ? { since: Date.now() } : {}) };
    if (JSON.stringify(this.st) !== before) this.emit('state', this.state());
  }

  private kindStates(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const [topic, state] of this.topics) {
      const kind = topicKind(topic);
      if (kind) out[kind] = (out[kind] ?? false) || state;
    }
    return out;
  }

  private async run(): Promise<void> {
    let delay = this.d.backoff?.minMs ?? 1000;
    const maxDelay = this.d.backoff?.maxMs ?? 60_000;
    while (this.running) {
      try {
        this.set({ onvif: 'connecting' });
        await this.sub.subscribe();
        if (this.everSubscribed) this.set({ resubscribes: this.st.resubscribes + 1 });
        this.everSubscribed = true;
        this.stopPolling();
        this.set({ onvif: 'subscribed', source: 'onvif', lastError: undefined });
        delay = this.d.backoff?.minMs ?? 1000;
        this.topics.clear();
        let first = true;
        while (this.running) {
          if (this.sub.needsRenew()) await this.sub.renew();
          this.pullAbort = new AbortController();
          const msgs = await this.sub.pull(this.pullAbort.signal);
          const inits = msgs.filter((m) => m.op === 'Initialized');
          const changes = msgs.filter((m) => m.op !== 'Initialized');
          // The camera answers a new subscription with Initialized messages (the
          // state now), and a Changed one may come in the same pull: a person
          // starting right after a (re)subscribe. The Initialized ones are the
          // state only; the Changed/Deleted ones are normal transitions.
          // A first pull without any Initialized message has no baseline to
          // judge a Changed one against, so it is taken as the initial state
          // (the safe reading; pull() already drops other ops).
          if (first || inits.length) {
            if (first && !inits.length) {
              for (const m of msgs) this.topics.set(m.topic, m.state);
            } else {
              for (const m of inits) this.topics.set(m.topic, m.state);
            }
            this.d.tracker.initialize(this.kindStates());
            if (first && !inits.length) changes.length = 0;
            first = false;
          }
          // Changed/Deleted: transitions, by kind in the order the topics were
          // first seen (a motion event opens before a person event that starts
          // with it, as the Timeline expects), each at its own message time.
          const before = this.kindStates();
          for (const m of changes) this.topics.set(m.topic, m.state);
          const after = this.kindStates();
          for (const [kind, state] of Object.entries(after)) {
            if (before[kind] === state) continue;
            const mine = changes.filter((m) => topicKind(m.topic) === kind);
            this.d.tracker.apply('onvif', kind, state, Math.max(...mine.map((m) => m.utc)), { topics: mine.map((m) => m.topic) });
          }
        }
      } catch (err) {
        if (!this.running) break;
        if (this.deliberate) {
          // Asked for: subscribe again at once (subscribe() ends the old one).
          this.deliberate = false;
          continue;
        }
        const why = err instanceof OnvifAuthError ? 'onvif_auth_failed' : (err as Error).message;
        if (this.st.onvif === 'subscribed') this.downSince = Date.now();
        this.set({ onvif: 'down', lastError: why, source: this.polling ? 'poll' : 'none' });
        logger.warn({ err: why }, 'onvif_down');
        this.maybePoll();
        await sleep(delay, this.stopper.signal);
        delay = Math.min(delay * 2, maxDelay);
      }
    }
  }

  private maybePoll(): void {
    const p = this.d.cfg.poll;
    if (!p.enabled || this.pollTimer) return;
    const wait = Math.max(0, p.afterOnvifDownS * 1000 - (Date.now() - this.downSince));
    this.pollTimer = setTimeout(() => {
      if (!this.running || this.st.onvif === 'subscribed') return void (this.pollTimer = undefined);
      this.polling = true;
      this.set({ source: 'poll' });
      const tick = async () => {
        try {
          const states = await pollStates(this.d.client);
          for (const [kind, state] of Object.entries(states)) this.d.tracker.apply('poll', kind, state, Date.now());
        } catch (err) {
          logger.warn({ err: (err as Error).message }, 'poll_failed');
        }
        if (this.pollTimer && this.running && this.st.source === 'poll') this.pollTimer = setTimeout(tick, p.intervalS * 1000);
      };
      void tick();
    }, wait);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.polling = false;
  }
}
