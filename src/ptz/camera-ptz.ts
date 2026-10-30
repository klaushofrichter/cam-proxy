// One camera's PTZ side (spec 2026-10-30-ptz-capabilities-design §5, §6): the
// Reolink commands, the move lease and the saved positions, made once per
// camera worker. The command goes to the worker's current client.
import type { CameraCommand, Capabilities } from '../camera/capabilities';
import { ReolinkPtz } from '../camera/ptz';
import type { Catalog } from '../catalog/db';
import { errorMessage, logger } from '../log';
import type { StreamLog } from '../stream/log';
import { MoveLease } from './lease';
import { PtzPositions } from './positions';

export interface CameraPtzDeps {
  cam: string;
  command: CameraCommand;
  capabilities: () => Capabilities | null;
  online: () => boolean;
  catalog: Catalog;
  log: StreamLog;
}

export class CameraPtz {
  readonly camera: ReolinkPtz;
  readonly lease: MoveLease;
  readonly positions: PtzPositions;

  constructor(private readonly d: CameraPtzDeps) {
    this.camera = new ReolinkPtz(d.command, () => d.capabilities()?.ptz?.speed === true);
    this.lease = new MoveLease({ stop: () => this.camera.stop() });
    this.positions = new PtzPositions({
      cam: d.cam,
      catalog: d.catalog,
      ptz: this.camera,
      lease: this.lease,
      online: d.online,
      changed: () => void d.log.append(d.cam, 'ptz-positions', {}),
    });
  }

  // Before the camera session ends (restart, stop): a leased move is stopped.
  async halt(): Promise<void> {
    if (!this.lease.active()) return;
    try {
      await this.lease.stop();
    } catch (err) {
      logger.warn({ cameraId: this.d.cam, err: errorMessage(err) }, 'ptz_halt_failed');
    }
  }
}
