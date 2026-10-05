// The /control/status answer's type, apart from state.ts (which needs a
// browser) so that node-side code and tests can import it.
import type { UiProviderState } from './analytics';
import type { CameraReboot, PoeSwitchStatus } from './maintenance';
import type { RecordingsStatus } from './recordings';
import type { CameraFtp, ClipsStall } from './ftp';
import type { UiHealth } from './health';
import type { UiArchive } from './archive';
import type { CameraBlock } from './cameras';

export interface Status {
  version: string;
  camera: { name?: string; nameSource?: 'camera' | 'config'; online: boolean; since: number; model?: string; firmware?: string; clockOffsetMs?: number; error?: string; webUiUrl?: string | null; reboot?: CameraReboot | null; poeSwitch?: PoeSwitchStatus };
  intake: { onvif: string; since: number; source: string; lastError?: string; resubscribes: number };
  sse: { clients: number };
  stream: { enabled: boolean; up: boolean; go2rtcUp: boolean; lastFrameTs: number | null };
  retention: { lastRun: number | null; totals: Record<string, number> };
  storage: { paused: boolean };
  analytics?: UiProviderState[];
  analyticsUnmapped?: { mid: string; name: string; count: number; lastSeen: number }[];
  ftp: { enabled: boolean; listening: boolean; port: number; tls: boolean; publicHost: string | null; passwordSet: boolean; lastUpload: number | null; lastClip: number | null; clips: number; failures: number; camera?: CameraFtp | null; stalled?: ClipsStall | null };
  recordings?: RecordingsStatus;
  health?: UiHealth; // the health summary (spec 2026-10-03-health-summary-design)
  archive?: UiArchive; // spec 2026-10-05-archive-design §6
  cameras?: CameraBlock[]; // every camera, config order (spec 2026-10-05-multi-camera-host-design §6.3); absent from an older proxy
}
