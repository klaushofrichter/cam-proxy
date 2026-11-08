import type { AuditLog } from '../audit/audit-log';
import type { ActionWho } from '../api/actions';
import type { CameraContent } from '../onboarding/content';
import type { CameraRemoveArgs, CameraRemovePreviewArgs } from './command-args';
import type { CommandBody } from './command-check';
import type { Done, Handler } from './commands';

// Remove a camera, decommission this proxy (decommission spec A1-A3; cams-admin
// contract "Remove a camera, decommission a proxy"): camera.remove.preview
// reads what the proxy holds for a camera; camera.remove runs the local remove
// (DELETE /control/cameras/:id) and, for content delete, deletes the camera's
// files now (its Archive only with archive: true); proxy.unenroll, refused
// while a camera is here, unenrolls after its result went out, like
// admin-unenroll, and clears the managed tokens and the allowed commands.
export interface DecommissionDeps {
  // Whether this proxy knows the camera (configured here, moved away, or files left).
  known: (cam: string) => boolean;
  content: (cam: string) => CameraContent;
  remove: (cam: string, who: ActionWho) => Promise<{ status: 200; removed: string[]; leftovers: string[] } | { status: number; error: string; detail?: string }>;
  deleteContent: (cam: string, archive: boolean) => { clips: number; stills: number; archivedClips: number };
  // The cameras that run here (moved-away markers not counted).
  activeCameras: () => string[];
  // admin-unenroll plus the token set and the allow list cleared.
  unenroll: (cmd: CommandBody) => Promise<void>;
  audit: Pick<AuditLog, 'write'>;
  now?: () => number;
}

// The contract's bounds: at most 16 items of 1..80 characters.
const ITEMS_MAX = 16;
const ITEM_LEN = 80;
const items = (l: string[]): string[] => l.filter((x) => x.length > 0).slice(0, ITEMS_MAX).map((x) => (x.length > ITEM_LEN ? `${x.slice(0, ITEM_LEN - 1)}…` : x));
const REMOVE_CODES = new Set(['not_found', 'move_open', 'config_json']);

export function decommissionHandlers(d: DecommissionDeps): Record<'camera.remove.preview' | 'camera.remove' | 'proxy.unenroll', Handler> {
  const who = (cmd: CommandBody): ActionWho => ({ user: 'cams-admin', requestedBy: 'cams-admin', cmdId: cmd.cmdId, actor: cmd.actor });
  return {
    'camera.remove.preview': (args) => {
      const a = args as CameraRemovePreviewArgs;
      if (!d.known(a.camera)) return { status: 'failed', code: 'not_found' };
      return { status: 'ok', result: { camera: a.camera, ...d.content(a.camera) } };
    },
    'camera.remove': async (args, cmd) => {
      const a = args as CameraRemoveArgs;
      const r = await d.remove(a.camera, who(cmd));
      if (r.status !== 200 || !('removed' in r)) {
        const code = 'error' in r && REMOVE_CODES.has(r.error) ? r.error : 'error' in r ? r.error : 'internal';
        return { status: 'failed', code };
      }
      const removed = [...r.removed];
      const leftovers = [...r.leftovers];
      let deleted = { clips: 0, stills: 0, archivedClips: 0 };
      if (a.content === 'delete') {
        try {
          deleted = d.deleteContent(a.camera, a.archive);
        } catch {
          leftovers.push('clips and stills (the delete failed; retention removes them)');
        }
      }
      // Kept on purpose (content keep, the Archive) is no leftover (the contract's fixtures): in the audit record only.
      const left = d.content(a.camera);
      if (a.content === 'delete') d.audit.write({ action: 'camera-content-delete', category: ['file'], type: ['deletion'], outcome: 'success', user: 'cams-admin', camera: a.camera, message: `Camera ${a.camera}'s content deleted by cams-admin (on behalf of ${cmd.actor}): ${deleted.clips} clips, ${deleted.stills} stills${a.archive ? `, ${deleted.archivedClips} archived clips` : '; archived clips kept'}`, details: { archive: a.archive, deleted, kept: left, requestedBy: 'cams-admin', cmdId: cmd.cmdId, actor: cmd.actor } });
      return { status: 'ok', result: { camera: a.camera, removed: items(removed), leftovers: items(leftovers), deleted }, changed: [`camera:${a.camera}:removed`] };
    },
    'proxy.unenroll': (_args, cmd): Done => {
      const cams = d.activeCameras();
      if (cams.length) return { status: 'failed', code: 'has_cameras' };
      const unenrollAt = (d.now ?? Date.now)() + 1000;
      // The result first (journaled, sent), then the unenroll (it says bye and drops the connection).
      return { status: 'ok', result: { unenrollAt }, changed: ['enrollment'], after: () => void d.unenroll(cmd) };
    },
  };
}
