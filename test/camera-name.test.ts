import { describe, it, expect, vi } from 'vitest';
import { CAMERA_NAME_RE, cameraNameProblem } from '../src/camera/name-rules';
import { CameraNameAnnouncer, CameraNameRefused, writeCameraName } from '../src/camera/name';
import { CameraError } from '../src/camera/client';
import { StatusPoller } from '../src/camera/status';
import type { ReolinkClient } from '../src/camera/client';

// The camera's name rules (camera-name design; measured on cam1, firmware
// v3.2.0.6011, 2026-10-03, Obsidian "Reolink API Behaviour" -> "Camera name").
describe('camera name rules', () => {
  it('is the regex of the API contract, character for character (cams has the same)', () => {
    expect(CAMERA_NAME_RE.source).toBe(String.raw`^[A-Za-z0-9()+=\[\]{}-](?:[A-Za-z0-9 ()+=\[\]{}-]{0,29}[A-Za-z0-9()+=\[\]{}-])?$`);
  });

  it('takes 1 to 31 characters, refuses 32 (rspCode -56 on the camera)', () => {
    expect(cameraNameProblem('A')).toBeNull();
    expect(cameraNameProblem('x'.repeat(31))).toBeNull();
    expect(cameraNameProblem('x'.repeat(32))).toBe('too long: 32 characters, at most 31');
    expect(CAMERA_NAME_RE.test('x'.repeat(31))).toBe(true);
    expect(CAMERA_NAME_RE.test('x'.repeat(32))).toBe(false);
  });

  it('takes letters, digits, inner spaces and - ( ) + = [ ] { }', () => {
    for (const ok of ['Backyard Left', 'Den', 'Cam (2) + [Gate] = {North}-1', '0', 'a  b', '-', '{}']) {
      expect(cameraNameProblem(ok), ok).toBeNull();
      expect(CAMERA_NAME_RE.test(ok), ok).toBe(true);
    }
  });

  it('refuses each measured character (rspCode -54), naming it', () => {
    for (const c of ['_', '.', ',', "'", '#', '@', '!', ':', ';', '?', '*', '%', '$', '~', '"', '<', '>', '|', '\\', '`', '^', 'é', 'ä', '/', '&']) {
      expect(cameraNameProblem(`Cam${c}1`), c).toBe(`not allowed: ${c}`);
      expect(CAMERA_NAME_RE.test(`Cam${c}1`), c).toBe(false);
    }
    expect(cameraNameProblem('a!b?c!')).toBe('not allowed: ! ?');
    expect(cameraNameProblem('tab\there')).toBe('not allowed: \\u0009');
  });

  it('refuses a leading or trailing space, and the empty name', () => {
    expect(cameraNameProblem(' Den')).toBe('no leading or trailing space');
    expect(cameraNameProblem('Den ')).toBe('no leading or trailing space');
    expect(cameraNameProblem(' ')).toBe('no leading or trailing space');
    expect(cameraNameProblem('')).toBe('empty: 1 to 31 characters');
    expect(cameraNameProblem(undefined)).toBe('empty: 1 to 31 characters');
    expect(cameraNameProblem(42)).toBe('empty: 1 to 31 characters');
    for (const n of [' Den', 'Den ', '']) expect(CAMERA_NAME_RE.test(n)).toBe(false);
  });

  it('keeps every reason within the 64 characters cams shows', () => {
    expect(cameraNameProblem('!"#$%&\'*,./:;<>?@\\^_`|~')!.length).toBeLessThanOrEqual(64);
  });
});

// A fake camera: SetDevName with the measured rules, GetDevName, offline.
function fakeCamera(name = 'Den') {
  const cam = { name, offline: false, calls: [] as { cmd: string; param: object }[] };
  const command = vi.fn(async (cmd: string, param: object = {}): Promise<unknown> => {
    cam.calls.push({ cmd, param });
    if (cam.offline) throw new CameraError('camera_offline', 'camera unreachable (ECONNREFUSED)');
    if (cmd === 'GetDevName') return { DevName: { name: cam.name } };
    if (cmd === 'SetDevName') {
      const n = (param as { DevName: { name: string } }).DevName.name;
      if (n.length > 31) throw new CameraError('camera_error', 'SetDevName failed (rspCode -56)', false, -56);
      if (!CAMERA_NAME_RE.test(n)) throw new CameraError('camera_error', 'SetDevName failed (rspCode -54)', false, -54);
      cam.name = n;
      return { rspCode: 200 };
    }
    throw new CameraError('camera_error', `${cmd} failed (rspCode -9)`, false, -9);
  });
  return { cam, command };
}

describe('writeCameraName', () => {
  it('writes SetDevName as a whole object, re-reads GetDevName and answers the name read back', async () => {
    const { cam, command } = fakeCamera();
    expect(await writeCameraName(command, 'Backyard Left')).toBe('Backyard Left');
    expect(cam.calls.map((c) => c.cmd)).toEqual(['SetDevName', 'GetDevName']);
    expect(cam.calls[0].param).toEqual({ DevName: { name: 'Backyard Left' } });
  });

  it('answers what the camera reads back, not what was sent', async () => {
    const { cam, command } = fakeCamera();
    command.mockImplementationOnce(async (cmd: string, param: object = {}) => (cam.calls.push({ cmd, param }), { rspCode: 200 })); // a write the camera ignores
    expect(await writeCameraName(command, 'Backyard Left')).toBe('Den');
  });

  it('refuses a name against the rules before calling the camera', async () => {
    const { cam, command } = fakeCamera();
    await expect(writeCameraName(command, 'Back_yard')).rejects.toEqual(new CameraNameRefused('not allowed: _'));
    await expect(writeCameraName(command, '')).rejects.toBeInstanceOf(CameraNameRefused);
    expect(cam.calls).toEqual([]);
  });

  it("a camera refusal (-54, -56) is a CameraNameRefused with the camera's reason", async () => {
    const { command } = fakeCamera();
    command.mockRejectedValueOnce(new CameraError('camera_error', 'SetDevName failed (rspCode -54)', false, -54));
    await expect(writeCameraName(command, 'Fine')).rejects.toEqual(new CameraNameRefused('not allowed by the camera (rspCode -54)'));
    command.mockRejectedValueOnce(new CameraError('camera_error', 'SetDevName failed (rspCode -56)', false, -56));
    await expect(writeCameraName(command, 'Fine')).rejects.toEqual(new CameraNameRefused('too long for the camera (rspCode -56)'));
  });

  it('an offline camera or another error goes through as the CameraError', async () => {
    const { cam, command } = fakeCamera();
    cam.offline = true;
    await expect(writeCameraName(command, 'Fine')).rejects.toMatchObject({ code: 'camera_offline' });
    cam.offline = false;
    command.mockRejectedValueOnce(new CameraError('camera_error', 'SetDevName failed (rspCode -9)', false, -9));
    await expect(writeCameraName(command, 'Fine')).rejects.toMatchObject({ code: 'camera_error', rspCode: -9 });
  });
});

describe('CameraNameAnnouncer', () => {
  it('announces each change once, never the same name twice in a row', () => {
    const said: [string, string][] = [];
    const a = new CameraNameAnnouncer('Den', (name, previous) => said.push([name, previous]));
    a.seen('Den');
    a.seen(undefined);
    expect(said).toEqual([]);
    a.seen('Backyard Left');
    a.seen('Backyard Left');
    a.seen('Backyard Left');
    a.seen('Den');
    expect(said).toEqual([['Backyard Left', 'Den'], ['Den', 'Backyard Left']]);
  });
});

// The routine poll keeps DevInfo.name.
describe('StatusPoller: the camera name', () => {
  const client = (names: string[]) => {
    let i = 0;
    return {
      status: async () => ({ model: 'RLC-1224A', firmware: 'v3', name: names[Math.min(i++, names.length - 1)] }),
      command: async () => ({ Time: { year: 2026, mon: 10, day: 3, hour: 12, min: 0, sec: 0, timeZone: 0 } }),
    } as unknown as ReolinkClient;
  };

  it("keeps GetDevInfo's name, and emits 'name' only when it changes", async () => {
    const poller = new StatusPoller(client(['Den', 'Den', 'Backyard Left', 'Backyard Left']), 60);
    const seen: string[] = [];
    poller.on('name', (n: string) => seen.push(n));
    for (let k = 0; k < 4; k++) await poller.checkNow();
    expect(poller.state().name).toBe('Backyard Left');
    expect(seen).toEqual(['Den', 'Backyard Left']);
  });

  // Review of #137: a poll that read GetDevInfo before the write and finishes
  // after noteName() must not flip the name back (new, old, new).
  it('a poll that read the old name before a write keeps the written name: one announcement, no flip-back', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    // Poll 1 reads "Den"; poll 2 read "Den" before the write but answers after it; then "Backyard Left".
    const slow = {
      status: async () => {
        const n = ++calls;
        if (n === 2) await gate;
        return { model: 'RLC-1224A', firmware: 'v3', name: n <= 2 ? 'Den' : 'Backyard Left' };
      },
      command: async () => ({ Time: { year: 2026, mon: 10, day: 3, hour: 12, min: 0, sec: 0, timeZone: 0 } }),
    } as unknown as ReolinkClient;
    const poller = new StatusPoller(slow, 60);
    const told: string[] = [];
    const announcer = new CameraNameAnnouncer('Den', (name) => told.push(name));
    poller.on('name', (n: string) => announcer.seen(n));
    await poller.checkNow(); // Den
    const stale = poller.checkNow(); // reads "Den" ... slowly
    poller.noteName('Backyard Left'); // the write lands meanwhile
    release();
    await stale;
    expect(poller.state().name).toBe('Backyard Left');
    await poller.checkNow(); // the next poll reads the new name
    expect(poller.state().name).toBe('Backyard Left');
    expect(told).toEqual(['Backyard Left']);
  });

  it('noteName (a write through the proxy) updates the state at once and emits once', async () => {
    const poller = new StatusPoller(client(['Den']), 60);
    await poller.checkNow();
    const seen: string[] = [];
    poller.on('name', (n: string) => seen.push(n));
    poller.noteName('Backyard Left');
    poller.noteName('Backyard Left');
    expect(poller.state().name).toBe('Backyard Left');
    expect(seen).toEqual(['Backyard Left']);
  });
});
