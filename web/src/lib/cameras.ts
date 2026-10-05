import { writable } from 'svelte/store';
import type { Status } from './state';
import type { RecordingsStatus } from './recordings';

export interface CameraBlock { id: string; camera: Status['camera']; intake: Status['intake']; stream: Status['stream']; ftp: Status['ftp']; recordings?: RecordingsStatus }

const KEY = 'camproxy.camera';
const stored = (): string | null => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
// The camera the pages show (several cameras on this proxy), kept per browser.
export const selectedCamera = writable<string | null>(typeof localStorage === 'undefined' ? null : stored());
selectedCamera.subscribe((v) => {
  try {
    if (v) localStorage.setItem(KEY, v);
  } catch {
    // private mode: the choice lasts this page only
  }
});

export const cameraIds = (s: Status | null): string[] => s?.cameras?.map((c) => c.id) ?? [];
export const multiCamera = (s: Status | null): boolean => cameraIds(s).length > 1;
export const pickCamera = (ids: string[], selected: string | null): string | null => (selected && ids.includes(selected) ? selected : (ids[0] ?? null));

export function blockOf(s: Status | null, id: string | null): CameraBlock | null {
  if (!s) return null;
  const found = s.cameras?.find((c) => c.id === pickCamera(cameraIds(s), id));
  return found ?? { id: s.cameras?.[0]?.id ?? '', camera: s.camera, intake: s.intake, stream: s.stream, ftp: s.ftp, recordings: s.recordings };
}
