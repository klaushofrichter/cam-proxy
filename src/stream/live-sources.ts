// The go2rtc stream a live client is relayed from (#296). A camera with stills
// has its streams in the host's go2rtc all the time (the stills path keeps
// them; nothing here touches them). A camera without stills gets its streams
// on demand: added with its first live client and removed after its last.
// While no camera has stills there is no host go2rtc: the first live client
// starts one and it stops again after the last live client of any camera.
// One change at a time, in arrival order.
import { within } from '../async';
import type { StreamSource } from '../stills/go2rtc';

export interface LiveGo2rtc {
  up(): boolean;
  ready(): Promise<void>;
  wsUrl(cam: string, stream: 'sub' | 'main'): string;
  setStream(s: StreamSource): Promise<void>;
  removeStream(cam: string): Promise<void>;
}

export interface LiveSourcesDeps {
  go2rtc: () => LiveGo2rtc | undefined; // the host's go2rtc, if one runs
  start: () => LiveGo2rtc | undefined; // makes and starts one (its sources include the cameras with live clients)
  stop: () => Promise<void>; // stops it (none runs afterwards)
  stillsOn: (cam: string) => boolean; // the camera's streams are the stills path's
  anyStills: () => boolean; // some camera needs the host go2rtc for stills
  source: (cam: string) => StreamSource;
  readyMs?: number; // how long an acquire waits for go2rtc (10 s)
}

const noop = () => undefined;

export class LiveSources {
  private readonly held = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: LiveSourcesDeps) {}

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.then(noop, noop);
    return p;
  }

  // Live clients held now: of one camera, or all.
  users(cam?: string): number {
    if (cam !== undefined) return this.held.get(cam) ?? 0;
    let n = 0;
    for (const v of this.held.values()) n += v;
    return n;
  }

  // The go2rtc to relay this camera from, up; null when there is none in
  // time (nothing is held then). Every non-null answer needs one release().
  acquire(cam: string): Promise<LiveGo2rtc | null> {
    return this.lock(async () => {
      const first = this.users(cam) === 0;
      this.held.set(cam, this.users(cam) + 1);
      try {
        const g = this.d.go2rtc() ?? this.d.start();
        if (!g) throw new Error('no go2rtc');
        await within(g.ready(), this.d.readyMs ?? 10_000, { unref: true });
        if (!g.up()) throw new Error('go2rtc not up');
        if (first && !this.d.stillsOn(cam)) await g.setStream(this.d.source(cam));
        return g;
      } catch {
        await this.drop(cam);
        return null;
      }
    });
  }

  release(cam: string): Promise<void> {
    return this.lock(() => (this.users(cam) > 0 ? this.drop(cam) : Promise.resolve()));
  }

  // One client of `cam` fewer: its on-demand stream goes with the last one,
  // the host go2rtc with the last client anywhere when no stills need it.
  private async drop(cam: string): Promise<void> {
    const n = this.users(cam) - 1;
    if (n > 0) return void this.held.set(cam, n);
    this.held.delete(cam);
    const g = this.d.go2rtc();
    if (!g) return;
    if (this.users() === 0 && !this.d.anyStills()) return this.d.stop();
    if (!this.d.stillsOn(cam)) await g.removeStream(cam).catch(noop);
  }
}
