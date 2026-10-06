import { describe, expect, it } from 'vitest';
import { cameraPath, newCameraProblem, settingGroups, storageRows } from '../web/src/lib/camera-settings';

describe('per-camera settings (spec 2026-10-05-multi-camera-host-design §6.3)', () => {
  it('host groups apart from the selected camera', () => {
    const g = settingGroups(['sse.pingS', 'poeSwitch.host', 'cameras.cam3.host', 'cameras.cam4.host', 'cameras.cam4.stills.intervalS'], 'cam4');
    expect(g.host).toEqual({ sse: ['sse.pingS'], poeSwitch: ['poeSwitch.host'] });
    expect(g.camera).toEqual(['cameras.cam4.host', 'cameras.cam4.stills.intervalS']);
  });
  it('the action path: the camera route with several cameras, the old one with one', () => {
    expect(cameraPath('cam4', true, 'actions/camera-test')).toBe('/control/cameras/cam4/actions/camera-test');
    expect(cameraPath('cam1', false, 'actions/camera-test')).toBe('/control/actions/camera-test');
    expect(cameraPath('cam1', false, 'name')).toBe('/control/camera/name');
    expect(cameraPath('cam4', true, 'name')).toBe('/control/cameras/cam4/name');
  });
  it('a new camera: a valid, unused id and an address', () => {
    expect(newCameraProblem({ id: 'cam6', host: '192.168.60.16' }, ['cam3'])).toBeNull();
    expect(newCameraProblem({ id: 'cam3', host: 'x' }, ['cam3'])).toBe('cam3 exists already');
    expect(newCameraProblem({ id: 'Cam 6', host: 'x' }, [])).toBe('the id is lower-case letters, digits and -, up to 32 (not "file" or ending in "-file")');
    expect(newCameraProblem({ id: 'cam6', host: '' }, [])).toBe('the camera needs an address');
    // As the server checks it (review of #173): a name or address with an optional port, nothing else.
    expect(newCameraProblem({ id: 'cam6', host: 'x${CAM_CAM1_PASSWORD}.evil.example' }, [])).toBe('the address is a name or IP address, optional :port');
    expect(newCameraProblem({ id: 'cam6', host: '192.168.60.16:8443' }, [])).toBeNull();
    expect(newCameraProblem({ id: 'file', host: 'x' }, [])).toBe('the id is lower-case letters, digits and -, up to 32 (not "file" or ending in "-file")');
  });
  it("the Status page's storage per camera: one row each, with several", () => {
    const by = { cam3: { stills: { bytes: 2 * 2 ** 30, files: 1 }, previews: { bytes: 0, files: 0 }, clips: { bytes: 2 ** 20, files: 1 }, recordings: { bytes: 0, files: 0 } } };
    expect(storageRows(by, ['cam3', 'cam4'])).toEqual([{ id: 'cam3', text: 'stills 2.0 GB · previews 0 B · clips 1.0 MB · recordings 0 B' }, { id: 'cam4', text: 'nothing stored' }]);
    expect(storageRows(by, ['cam3'])).toEqual([]);
  });
});
