// Focus after going to a saved position (Klaus, 2026-11-14). Measured on the
// E1 (Obsidian Cameras/Reolink E1 Outdoor Pro, "Focus after going to a
// preset"): a ToPos to another zoom refocuses by itself once the zoom has
// arrived; one to the same zoom does not, so a bad focus stays bad. So after
// a go the proxy waits until pan, tilt and zoom stand still and, when the
// zoom is the one from before, runs one autofocus.
//
// The go does not wait for this. Every camera read and the autofocus run in
// the lease's command queue under the go's mark: any later PTZ action (move,
// zoom, focus, stop, another go, autofocus) changes the mark and ends it, so
// it never fights the user.
import { sleep } from '../async';
import type { ReolinkPtz } from '../camera/ptz';
import { errorMessage, logger } from '../log';
import type { MoveLease } from './lease';

// One read (GetPtzCurPos: pan, tilt and Zpos) per tick; GetZoomFocus once
// after settling, for focusAt's scale. A travel that has not settled after
// the cap is left alone.
export const GO_FOCUS_TICK_MS = 300;
export const GO_FOCUS_CAP_MS = 20_000;
// Settled means two equal readings after the camera has moved away from its
// first reading, or after it has not moved at all for this long (a go to
// where it already is). A camera may start moving only after a tick or two
// (the E1's zoom arrives ~0.9 s after ToPos), and the old position must not
// read as settled: at another zoom, an autofocus to the old zoom would cut
// the go short.
export const GO_FOCUS_STILL_MS = 1500;

export type FocusOutcome = 'focused' | 'self' | 'cancelled' | 'timeout' | 'failed';

export interface FocusAfterGoDeps {
  cam: string;
  lease: Pick<MoveLease, 'mark' | 'current' | 'runIf'>;
  ptz: Pick<ReolinkPtz, 'position' | 'zoomPos' | 'focusAt'>;
  enabled: () => boolean; // capabilities.ptz.autofocus
}

export class FocusAfterGo {
  constructor(private readonly d: FocusAfterGoDeps) {}

  enabled(): boolean {
    return this.d.enabled();
  }

  // The zoom before the ToPos; undefined (no focus after this go) when the
  // read fails: the go itself goes on.
  async zoomBefore(): Promise<number | undefined> {
    try {
      return await this.d.ptz.zoomPos();
    } catch (err) {
      logger.debug({ cameraId: this.d.cam, err: errorMessage(err) }, 'ptz_go_focus_no_zoom');
      return undefined;
    }
  }

  // Runs in the background after the go; mark: the lease's mark taken when
  // the go was queued. Never rejects.
  async start(before: number, mark: number): Promise<FocusOutcome> {
    const outcome = await this.settle(before, mark);
    const line = { cameraId: this.d.cam, outcome };
    if (outcome === 'focused' || outcome === 'timeout') logger.info(line, 'ptz_go_focus');
    else logger.debug(line, 'ptz_go_focus');
    return outcome;
  }

  private async settle(before: number, mark: number): Promise<FocusOutcome> {
    const { lease, ptz } = this.d;
    const start = Date.now();
    const end = start + GO_FOCUS_CAP_MS;
    let first: string | undefined;
    let last: string | undefined;
    let moved = false;
    try {
      for (;;) {
        await sleep(GO_FOCUS_TICK_MS, undefined, { unref: true });
        if (!lease.current(mark)) return 'cancelled';
        if (Date.now() > end) return 'timeout';
        let reading = '';
        const ran = await lease.runIf(mark, async () => {
          const p = await ptz.position();
          reading = `${p.pan}/${p.tilt}/${p.zoom ?? ''}`;
        });
        if (!ran) return 'cancelled';
        first ??= reading;
        if (reading !== first) moved = true;
        if (reading === last && (moved || Date.now() - start >= GO_FOCUS_STILL_MS)) break;
        last = reading;
      }
      // Another zoom: the camera refocuses by itself. The zoom is read and
      // the autofocus sent in one queue turn, so nothing slips in between.
      let self = false;
      const ran = await lease.runIf(mark, async () => {
        const zoom = await ptz.zoomPos();
        if (zoom !== before) self = true;
        else await ptz.focusAt(zoom);
      });
      if (!ran) return 'cancelled';
      return self ? 'self' : 'focused';
    } catch (err) {
      logger.info({ cameraId: this.d.cam, err: errorMessage(err) }, 'ptz_go_focus_failed');
      return 'failed';
    }
  }
}
