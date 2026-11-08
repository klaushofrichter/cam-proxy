import { join, resolve, sep } from 'path';
import { cameraItems, summarize, type InventoryDeps } from '../moves/inventory';
import { FILE_KINDS } from '../moves/types';
import { purgeExcept, type PurgeDeps } from '../moves/purge';

// What this proxy holds for one camera, and deleting it now (decommission spec
// A1, A2: camera.remove.preview, camera.remove with content delete). Counts:
// clips (rows with their file), stills (minute files in stills/, not the
// previews), archived clips (Archive items); bytes: every file of the camera
// (stills and previews, clips with snapshots, event images, still checks,
// the Archive).
export interface CameraContent { clips: number; stills: number; archivedClips: number; bytes: number }

export function cameraContent(d: InventoryDeps, cam: string): CameraContent {
  const stillsDir = join(resolve(d.dataDir), 'stills', cam) + sep;
  const sum = summarize(d, cam);
  return {
    clips: cameraItems(d, cam, 'clips').length,
    stills: cameraItems(d, cam, 'stills').filter((it) => it.files[0]?.startsWith(stillsDir)).length,
    archivedClips: cameraItems(d, cam, 'archive').length,
    bytes: FILE_KINDS.reduce((n, k) => n + sum[k].bytes, 0),
  };
}

// Every file and row of the camera now (its recordings cache too); its
// Archive only with `archive`, else every archived clip stays. Answers how
// many clips, stills and archived clips went.
export function deleteCameraContent(d: PurgeDeps, cam: string, archive: boolean): { clips: number; stills: number; archivedClips: number } {
  const before = cameraContent(d, cam);
  purgeExcept(d, cam, { keep: {}, listed: new Set(), archive: archive ? 'delete' : 'keep' });
  const after = cameraContent(d, cam);
  const gone = (k: 'clips' | 'stills' | 'archivedClips') => Math.max(0, before[k] - after[k]);
  return { clips: gone('clips'), stills: gone('stills'), archivedClips: gone('archivedClips') };
}
