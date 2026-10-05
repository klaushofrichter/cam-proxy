import { describe, expect, it } from 'vitest';
import { blockOf, cameraIds, multiCamera, pickCamera } from '../web/src/lib/cameras';

const cam = (id: string, online = true) => ({ id, camera: { name: id, online, since: 0 }, intake: { onvif: 'subscribed', since: 0, source: 'onvif', resubscribes: 0 }, stream: { enabled: true, up: true, go2rtcUp: true, lastFrameTs: 1 }, ftp: { enabled: false } });
const status = (ids: string[]) => ({ version: 'v', camera: cam(ids[0]).camera, intake: cam(ids[0]).intake, stream: cam(ids[0]).stream, ftp: cam(ids[0]).ftp, cameras: ids.map((i) => cam(i, i !== 'cam4')) }) as never;

describe('camera picker (spec §16 P1)', () => {
  it('ids in config order; multi only with more than one', () => {
    expect(cameraIds(status(['cam3', 'cam4']))).toEqual(['cam3', 'cam4']);
    expect(multiCamera(status(['cam3', 'cam4']))).toBe(true);
    expect(multiCamera(status(['cam1']))).toBe(false);
    expect(cameraIds(null)).toEqual([]);
  });
  it('the selection survives while listed, else the first', () => {
    expect(pickCamera(['cam3', 'cam4'], 'cam4')).toBe('cam4');
    expect(pickCamera(['cam3', 'cam4'], 'gone')).toBe('cam3');
    expect(pickCamera([], 'cam4')).toBeNull();
  });
  it("the selected camera's block; an older proxy without cameras: the top level", () => {
    expect(blockOf(status(['cam3', 'cam4']), 'cam4')?.camera.online).toBe(false);
    const old = { ...status(['cam1']), cameras: undefined } as never;
    expect(blockOf(old, null)?.id).toBe('');
    expect(blockOf(old, null)?.camera.name).toBe('cam1');
  });
});
