// The camera name field on the Settings page (camera-name design): the
// name is stored on the camera and saved with PUT /control/camera/name. The
// rules are the server's own list (src/camera/name-rules.ts), so the field
// refuses exactly what the proxy and the camera refuse.
export { cameraNameProblem, CAMERA_NAME_MAX } from '../../../src/camera/name-rules';

// Why a save failed, for people: the 400's reason, an offline camera, or the status.
export function nameSaveError(status: number, body: unknown): string {
  const b = (body && typeof body === 'object' ? body : {}) as { error?: unknown; reason?: unknown };
  if (status === 400 && typeof b.reason === 'string') return `Not saved: ${b.reason}`;
  if (status === 503 || b.error === 'camera_offline') return 'Not saved: the camera is offline';
  return `Not saved: ${typeof b.error === 'string' ? b.error : `HTTP ${status}`}`;
}
