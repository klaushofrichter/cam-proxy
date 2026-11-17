// Klaus 2026-11-15: separate camera and proxy restart. The Maintenance
// page's camera restart always takes the camera's own route (also on a
// one-camera proxy, the Pi); the proxy's restarts are host-wide, under Proxy.
import { describe, expect, it } from 'vitest';
import { pendingRestarts, restartBadgeTitle, restartCamera, restartProxyServices, PROXY_PROCESS_RESTART, PROXY_SERVICES_RESTART } from '../web/src/lib/restarts';

const cam = (id: string) => ({ id, camera: { name: id, online: true, since: 0 }, intake: { onvif: 'subscribed', since: 0, source: 'onvif', resubscribes: 0 }, stream: { enabled: true, up: true, go2rtcUp: true, lastFrameTs: 1 }, ftp: { enabled: false } });
const status = (ids: string[]) => ({ version: 'v', camera: cam(ids[0]).camera, intake: cam(ids[0]).intake, stream: cam(ids[0]).stream, ftp: cam(ids[0]).ftp, cameras: ids.map(cam) }) as never;
const recorder = () => {
  const calls: string[] = [];
  return { calls, api: async (m: string, p: string) => void calls.push(`${m} ${p}`) };
};

describe('the camera restart: always the camera route', () => {
  it('one camera (the Pi) and several: the picked camera\'s route, never the host-wide one', async () => {
    const r = recorder();
    for (const [ids, sel] of [[['cam1'], null], [['cam1'], 'gone'], [['cam3', 'cam4'], 'cam4'], [['cam3', 'cam4'], 'gone'], [['a b'], null]] as const) await restartCamera(r.api, status([...ids]), sel);
    expect(r.calls).toEqual(['cam1', 'cam1', 'cam4', 'cam3', 'a%20b'].map((c) => `POST /control/cameras/${c}/actions/restart`));
  });
  it('no camera known (no status yet, or none configured): nothing posted', async () => {
    const r = recorder();
    expect(await restartCamera(r.api, { ...(status(['cam1']) as object), cameras: [] } as never, null)).toBe('Restart camera side: no camera');
    expect(r.calls).toEqual([]);
  });
  it('posts the camera route on one camera and on several; answers a line naming the camera; never throws', async () => {
    const one = recorder();
    expect(await restartCamera(one.api, status(['cam1']), null)).toBe('Restart camera side (cam1): started; this camera only, back in a few seconds');
    expect(one.calls).toEqual(['POST /control/cameras/cam1/actions/restart']);
    const many = recorder();
    await restartCamera(many.api, status(['cam3', 'cam4']), 'cam4');
    expect(many.calls).toEqual(['POST /control/cameras/cam4/actions/restart']);
    const none = recorder();
    expect(await restartCamera(none.api, null, null)).toBe('Restart camera side: no camera');
    expect(none.calls).toEqual([]);
    expect(await restartCamera(async () => { throw new Error('camera_restarting'); }, status(['cam1']), null)).toBe('Restart camera side (cam1): camera_restarting');
  });
});

describe('the proxy restarts: host-wide', () => {
  it('the routes', () => {
    expect(PROXY_SERVICES_RESTART).toBe('/control/actions/restart');
    expect(PROXY_PROCESS_RESTART).toBe('/control/actions/restart-proxy');
  });
  it('restartProxyServices posts the host-wide restart; an error is a line', async () => {
    const r = recorder();
    expect(await restartProxyServices(r.api)).toBe('Restart proxy services: started; every camera is back in a few seconds and pending settings apply');
    expect(r.calls).toEqual(['POST /control/actions/restart']);
    expect(await restartProxyServices(async () => { throw new Error('admin_only'); })).toBe('Restart proxy services: admin_only');
  });
});

describe('settings waiting for a restart', () => {
  const view = {
    'cameras.cam1.statusPollS': { pending: true, restartScope: 'camera' as const },
    'cameras.cam2.statusPollS': { pending: true, restartScope: 'camera' as const },
    'cameras.cam1.name': { pending: false, restartScope: 'camera' as const },
    'ftp.port': { pending: true, restartScope: 'host' as const },
    'go2rtc.apiPort': { pending: false, restartScope: 'host' as const },
    'server.trustProxy': { pending: true, restartScope: 'process' as const },
    'server.port': { pending: true, restartScope: 'process' as const },
    'sse.pingS': { pending: false },
  };
  it('by what applies them: the camera\'s restart, the proxy services restart, a new process', () => {
    expect(pendingRestarts(view, 'cam1')).toEqual({ camera: ['cameras.cam1.statusPollS'], cameras: ['cameras.cam1.statusPollS', 'cameras.cam2.statusPollS'], host: ['ftp.port'], process: ['server.trustProxy', 'server.port'] });
    expect(pendingRestarts(view, null).camera).toEqual([]);
    expect(pendingRestarts({}, 'cam1')).toEqual({ camera: [], cameras: [], host: [], process: [] });
  });
});

describe("the Settings page's restart badge", () => {
  it('names the restart that applies the setting', () => {
    expect(restartBadgeTitle('camera')).toBe("applies after this camera's restart (Restart camera side) or Restart proxy services");
    expect(restartBadgeTitle('host')).toBe('applies after Restart proxy services (Maintenance → Proxy; every camera side restarts)');
    expect(restartBadgeTitle('process')).toMatch(/^applies after Restart proxy process/);
  });
});
