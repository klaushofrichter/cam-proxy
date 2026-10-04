import { CameraError } from './client';
import { cameraNameProblem } from './name-rules';

// The camera name (camera-name design): the camera stores it, the routine
// status poll reads it (GetDevInfo.name), and PUT /control/camera/name writes
// it here. GetDevName, GetDevInfo.name and the OSD text are one value on the
// camera, so one SetDevName is enough.

// A name the camera won't take: by the measured rules (checked before the
// call) or by the camera itself (-54, -56). `reason` is for people.
export class CameraNameRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'CameraNameRefused';
  }
}

type Command = (cmd: string, param?: object) => Promise<unknown>;

const CAMERA_REASONS: Record<number, string> = {
  [-54]: 'not allowed by the camera (rspCode -54)',
  [-56]: 'too long for the camera (rspCode -56)',
};

export async function readCameraName(command: Command): Promise<string> {
  const v = (await command('GetDevName', { channel: 0 })) as { DevName?: { name?: unknown } } | undefined;
  const name = v?.DevName?.name;
  if (typeof name !== 'string') throw new CameraError('camera_error', 'GetDevName: no name in the answer');
  return name;
}

// Validates, writes the whole DevName object, reads it back: the answer is
// the name the camera has now. A camera that is offline or fails otherwise
// throws its CameraError.
export async function writeCameraName(command: Command, name: unknown): Promise<string> {
  const problem = cameraNameProblem(name);
  if (problem) throw new CameraNameRefused(problem);
  try {
    await command('SetDevName', { DevName: { name } });
  } catch (err) {
    const reason = err instanceof CameraError && err.rspCode !== undefined ? CAMERA_REASONS[err.rspCode] : undefined;
    if (reason) throw new CameraNameRefused(reason);
    throw err;
  }
  return readCameraName(command);
}

// Tells clients the name once per change: `announced` is the name they were
// last told (the newest `camera` stream message, or the configured fallback
// they saw before the camera was read).
export class CameraNameAnnouncer {
  constructor(
    private announced: string,
    private readonly announce: (name: string, previous: string) => void,
  ) {}

  seen(name: string | undefined): void {
    if (name === undefined || name === this.announced) return;
    const previous = this.announced;
    this.announced = name;
    this.announce(name, previous);
  }
}
