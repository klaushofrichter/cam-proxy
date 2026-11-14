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
import type { ReolinkPtz } from '../camera/ptz';
import { errorMessage, logger } from '../log';
import type { MoveLease } from './lease';

// Two reads (GetPtzCurPos, GetZoomFocus) per tick; a travel that has not
// settled after the cap is left alone.
export const GO_FOCUS_TICK_MS = 300;
export const GO_FOCUS_CAP_MS = 20_000;

export type FocusOutcome = 'focused' | 'self' | 'cancelled' | 'timeout' | 'failed';

export interface FocusAfterGoDeps {
  cam: string;
  lease: Pick<MoveLease, 'mark' | 'current' | 'runIf'>;
  ptz: Pick<ReolinkPtz, 'position' | 'zoomPos' | 'focusAt'>;
  enabled: () => boolean; // capabilities.ptz.autofocus
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref());
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
    const end = Date.now() + GO_FOCUS_CAP_MS;
    let last: string | undefined;
    let zoom = before;
    try {
      for (;;) {
        await sleep(GO_FOCUS_TICK_MS);
        if (!lease.current(mark)) return 'cancelled';
        if (Date.now() > end) return 'timeout';
        let reading = '';
        const ran = await lease.runIf(mark, async () => {
          const p = await ptz.position();
          zoom = await ptz.zoomPos();
          reading = `${p.pan}/${p.tilt}/${zoom}`;
        });
        if (!ran) return 'cancelled';
        if (reading === last) break;
        last = reading;
      }
      // Another zoom: the camera refocuses by itself.
      if (zoom !== before) return 'self';
      return (await lease.runIf(mark, () => ptz.focusAt(zoom))) ? 'focused' : 'cancelled';
    } catch (err) {
      logger.info({ cameraId: this.d.cam, err: errorMessage(err) }, 'ptz_go_focus_failed');
      return 'failed';
    }
  }
}
