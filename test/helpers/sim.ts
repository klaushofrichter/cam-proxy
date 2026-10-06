// The camera for cams' tests: cam-sim (github.com/klaushofrichter/cam-sim),
// in process. The options switch on cam-sim faults; the state reads its
// counters and switches.
import { createCamSim, DEMO_CLIPS, type CamSim, type FaultSpec, type SeedClip } from 'cam-sim';

export interface SimCameraOptions {
  user: string;
  password: string;
  firmware?: string;
  flvDelayMs?: number;
  downloadDelayMs?: number;
  clips?: SeedClip[];
  searchDelayMs?: number;
  dropFirstDownloads?: number;
  settingsFailures?: string[];
  ignoreWrites?: string[];
  rebootMs?: number;
  rebootDropsConnection?: boolean;
  // cam-sim's cert.ignoreImport: ImportCertificate answers 200 and installs nothing.
  ignoreImport?: boolean;
}

export interface SimState {
  readonly logins: number;
  readonly loginAttempts: number;
  readonly activeStreams: number;
  readonly streamsOpened: number;
  readonly devInfoCalls: number;
  offline: boolean;
  rejectAllStreams: boolean;
  readonly downloads: number;
  readonly activeDownloads: number;
  readonly droppedDownloads: number;
  readonly downloadOrder: string[];
  readonly settings: CamSim['engine']['settings']['running'];
  readonly setCalls: string[];
  readonly reboots: number;
  // What GetHddInfo reports: capacity and FREE space (size), in MB.
  readonly hddInfo: { capacity: number; size: number };
  revokeTokens(): void;
  dropStreams(): void;
  dropDownloads(): void;
}

export async function createSimCamera(opts: SimCameraOptions): Promise<{ app: CamSim['cameraApp']; state: SimState; sim: CamSim }> {
  const faults: FaultSpec[] = [
    // A partial write's resets show at once, so tests see them without a
    // reboot (the firmware, and cam-sim by default, wait for the reboot).
    { name: 'settings.strictPartial' },
  ];
  if (opts.flvDelayMs) faults.push({ name: 'flv.delayMs', ms: opts.flvDelayMs });
  if (opts.downloadDelayMs) faults.push({ name: 'downloads.delayMs', ms: opts.downloadDelayMs });
  if (opts.searchDelayMs) faults.push({ name: 'search.delayMs', ms: opts.searchDelayMs });
  if (opts.dropFirstDownloads) faults.push({ name: 'downloads.dropFirst', count: opts.dropFirstDownloads });
  if (opts.settingsFailures?.length) faults.push({ name: 'settings.fail', cmds: opts.settingsFailures });
  if (opts.ignoreWrites?.length) faults.push({ name: 'settings.ignore', cmds: opts.ignoreWrites });
  if (opts.ignoreImport) faults.push({ name: 'cert.ignoreImport' });

  const sim = await createCamSim({
    users: [{ name: opts.user, level: 'admin', password: opts.password }],
    name: 'Den',
    ...(opts.firmware ? { firmVer: opts.firmware } : {}),
    faults,
    seedClips: opts.clips ?? DEMO_CLIPS,
    reboot: { ms: opts.rebootMs ?? 50, dropsConnection: opts.rebootDropsConnection ?? false },
    sdMb: 61047, // the real camera's 64 GB card
  });
  const e = sim.engine;
  const c = e.counters;
  const toggle = (name: 'offline' | 'flv.reset', on: boolean) => (on ? e.faults.set({ name }) : e.faults.clear(name));
  const state: SimState = {
    get logins() { return c.logins; },
    get loginAttempts() { return c.loginAttempts; },
    get activeStreams() { return c.activeStreams; },
    get streamsOpened() { return c.streamsOpened; },
    get devInfoCalls() { return c.devInfoCalls; },
    get offline() { return e.offline(); },
    set offline(v: boolean) { toggle('offline', v); },
    get rejectAllStreams() { return !!e.faults.active('flv.reset'); },
    set rejectAllStreams(v: boolean) { toggle('flv.reset', v); },
    get downloads() { return c.downloads; },
    get activeDownloads() { return c.activeDownloads; },
    get droppedDownloads() { return c.droppedDownloads; },
    get downloadOrder() { return c.downloadOrder; },
    get settings() { return e.settings.running; },
    get setCalls() { return c.setCalls; },
    get reboots() { return c.reboots; },
    get hddInfo() { return e.sd.hddInfo()[0]; },
    revokeTokens: () => e.sessions.revokeAll(),
    dropStreams: () => e.dropFlv(),
    dropDownloads: () => e.dropDownloads(),
  };
  return { app: sim.cameraApp, state, sim };
}

// A fully listening cam-sim (camera HTTP, ONVIF, RTSP, Baichuan) for the proxy's
// integration tests. Users: `admin` and `proxy` (the proxy's own user).
// `ignoreImport`: the camera refuses a certificate import (cam-sim's cert.ignoreImport).
export async function startSim(opts: { rebootMs?: number; ignoreImport?: boolean } = {}) {
  const password = 'proxy-pw';
  const sim = await createCamSim({
    users: [
      { name: 'admin', level: 'admin', password: 'admin-pw' },
      { name: 'proxy', level: 'admin', password },
    ],
    seedClips: 'demo',
    reboot: { ms: opts.rebootMs ?? 200, dropsConnection: true },
    faults: opts.ignoreImport ? [{ name: 'cert.ignoreImport' }] : [],
  });
  const ports = await sim.listen({ http: 0, https: 0, control: 0, rtsp: 0, onvif: 0, baichuan: 0 }, '127.0.0.1');
  // Always set when listening in process (the type makes it optional).
  const baichuan = ports.baichuan;
  if (baichuan === undefined) throw new Error('cam-sim did not open a Baichuan port');
  return {
    sim,
    ports: { ...ports, baichuan },
    password,
    camera: { host: `127.0.0.1:${ports.http}`, protocol: 'http' as const, user: 'proxy', onvifPort: ports.onvif, rtspPort: ports.rtsp, baichuanPort: baichuan },
    close: () => sim.close(),
  };
}
