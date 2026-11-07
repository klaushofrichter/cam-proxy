import { afterEach, describe, expect, it, vi } from 'vitest';
import { cameraStateText, isNewStart, poeAlert, poeLine, poeOnText, powerCycleMessage, powerCycleDisabled, powerCycleFailText, powerLine, powerResultText, rebootEndText, readHealth, restartWatch, waitForNewProxy, RESTART_GIVE_UP_MS } from '../web/src/lib/maintenance';

describe('Maintenance page helpers (#71, #83)', () => {
  it('tells a new proxy start by its version or start time', () => {
    const before = { version: 'v1', startedAt: 1000 };
    expect(isNewStart(before, { version: 'v1', startedAt: 1000 })).toBe(false);
    expect(isNewStart(before, { version: 'v1', startedAt: 2000 })).toBe(true);
    expect(isNewStart(before, { version: 'v2', startedAt: 1000 })).toBe(true);
    // An older proxy without startedAt: the version decides.
    expect(isNewStart({ version: 'v1' }, { version: 'v1' })).toBe(false);
    expect(isNewStart(null, { version: 'v1', startedAt: 5 })).toBe(true);
    expect(RESTART_GIVE_UP_MS).toBe(120_000);
  });

  it('shows the camera as rebooting while a reboot is under way', () => {
    const at = new Date(2026, 9, 1, 14, 7).getTime();
    expect(cameraStateText({ online: false, reboot: { phase: 'rebooting', requestedAt: at } })).toBe('rebooting (requested 14:07)');
    expect(cameraStateText({ online: true, reboot: { phase: 'rebooting', requestedAt: at } })).toBe('rebooting (requested 14:07)');
    expect(cameraStateText({ online: true, reboot: { phase: 'back', requestedAt: at } })).toBe('online');
    expect(cameraStateText({ online: false, reboot: null })).toBe('offline');
    expect(cameraStateText({ online: true })).toBe('online');
  });

  it('shows "power-cycling" while the PoE is off, then "rebooting" (#85)', () => {
    const at = new Date(2026, 9, 1, 19, 18).getTime();
    expect(cameraStateText({ online: false, reboot: { kind: 'powercycle', phase: 'power-cycling', requestedAt: at } })).toBe('power-cycling (requested 19:18)');
    expect(cameraStateText({ online: false, reboot: { kind: 'powercycle', phase: 'rebooting', requestedAt: at } })).toBe('rebooting (requested 19:18)');
    expect(cameraStateText({ online: true, reboot: { kind: 'powercycle', phase: 'back', requestedAt: at } })).toBe('online');
  });

  it('asks before a power-cycle through cams-admin, naming the switch and port it knows', () => {
    expect(powerCycleMessage({ kind: 'poe', switchName: 'Switch 2', port: 3 })).toBe(
      'Ask cams-admin to power-cycle the camera (PoE: Switch 2, port 3)? cams-admin first checks that the camera is on that port, then cuts its PoE for a few seconds. The camera is offline for about a minute.',
    );
    expect(powerCycleMessage(null)).toBe(
      'Ask cams-admin to power-cycle the camera? cams-admin first checks that the camera is on that port, then cuts its PoE for a few seconds. The camera is offline for about a minute.',
    );
  });

  // Camera settings and the Maintenance page: the camera's power as cams-admin sent it (camera.power.set).
  it("describes the camera's power from cams-admin", () => {
    const now = new Date(2026, 10, 7, 12, 0).getTime();
    expect(powerLine({ kind: 'poe', switchName: 'Switch 2', port: 3, watts: 4.5, verifiedAt: now - 2 * 3600_000 }, now)).toBe('PoE: Switch 2, port 3, verified 2 h ago');
    expect(powerLine({ kind: 'poe', switchName: 'Switch 2', port: 3 }, now)).toBe('PoE: Switch 2, port 3, not verified');
    expect(powerLine({ kind: 'poe', switchName: 'Switch 2', port: 3, verifiedAt: now - 60_000, notSeen: true }, now)).toBe('PoE: Switch 2, port 3, verified 1 min ago; not seen there at the last check');
    expect(powerLine({ kind: 'data-only', switchName: 'Switch 2', port: 5 }, now)).toBe('Data only: power adapter');
    expect(powerLine({ kind: 'adapter' }, now)).toBe('Power adapter');
    expect(powerLine({ kind: 'unknown' }, now)).toBe('Unknown');
    expect(powerLine(null, now)).toBe('Unknown');
  });

  it("says cams-admin's answer to a power-cycle request", () => {
    expect(powerResultText({ requestId: 'pc_1', ok: true, at: 1 })).toBe('Camera power-cycle: done by cams-admin');
    expect(powerResultText({ requestId: 'pc_1', ok: false, reason: 'not PoE powered', at: 1 })).toBe('Camera power-cycle refused by cams-admin: not PoE powered');
    expect(powerResultText({ requestId: 'pc_1', ok: false, at: 1 })).toBe('Camera power-cycle refused by cams-admin');
  });

  it('the power-cycle button: off while asked or not allowed, on again once the request ended (answered or timed out)', () => {
    const view = { power: { kind: 'poe' as const }, setAt: 1, asked: { requestId: 'pc_1', at: 1 }, result: null, canRequest: true, why: null };
    expect(powerCycleDisabled(view, false)).toBe(true);
    expect(powerCycleDisabled({ ...view, asked: null, result: { requestId: 'pc_1', ok: false, reason: 'no answer from cams-admin within 5 minutes', at: 2 } }, false)).toBe(false);
    expect(powerCycleDisabled({ ...view, asked: null }, true)).toBe(true);
    expect(powerCycleDisabled({ ...view, asked: null, canRequest: false, why: 'x' }, false)).toBe(true);
    expect(powerCycleDisabled(null, false)).toBe(true);
  });

  it('the end of a reboot or power-cycle that did not bring the camera back', () => {
    expect(rebootEndText({ kind: 'powercycle', phase: 'not-back', requestedAt: 1 })).toBe('The camera did not answer within 5 minutes of the power-cycle.');
    expect(rebootEndText({ kind: 'reboot', phase: 'not-back', requestedAt: 1 })).toBe('The camera did not answer within 5 minutes of the reboot.');
    expect(rebootEndText({ kind: 'powercycle', phase: 'not-back', requestedAt: 1, message: 'PoE may still be OFF on Switch 2 port 3' })).toBe('The power-cycle failed: PoE may still be OFF on Switch 2 port 3');
  });

  it('describes the switch and its last reading', () => {
    const sw = { model: 'sscpoe-web', host: '192.168.1.217', port: 8, ports: 8, offSeconds: 10, passwordSet: true, configured: true, busy: false, poeMaybeOff: false, last: null };
    expect(poeLine(sw)).toBe('192.168.1.217 port 8 · not read yet');
    const at = new Date(2026, 9, 1, 19, 18).getTime();
    expect(poeLine({ ...sw, last: { at, port: 8, index: 0, poe: true, watts: 6.8, link: true, sn: 'GPS208', firmware: null } })).toBe('192.168.1.217 port 8 · PoE on, 6.8 W (read 19:18)');
    expect(poeLine({ ...sw, last: { at, port: 8, index: 0, poe: false, watts: 0, link: false, sn: 'GPS208', firmware: null } })).toBe('192.168.1.217 port 8 · PoE off, 0 W (read 19:18)');
    expect(poeLine({ ...sw, model: 'none', configured: false })).toBe('none');
    expect(poeLine({ ...sw, passwordSet: false, configured: false })).toBe('192.168.1.217 port 8 · not configured: CAMPROXY_POE_SWITCH_PASSWORD is not set');
  });

  // #78 review item 2: a failed first /health read must not reload the page on the old process.
  it('reloads only for a start time that differs from one actually read', () => {
    const old = { version: 'v1', startedAt: 1000 };
    const fresh = { version: 'v1', startedAt: 2000 };
    const w = restartWatch(null);
    expect(w(null)).toBe(false);
    expect(w(old)).toBe(false); // the first answer is the reference, not a new start
    expect(w(old)).toBe(false);
    expect(w(null)).toBe(false);
    expect(w(fresh)).toBe(true);
    const v = restartWatch(old);
    expect(v(old)).toBe(false);
    expect(v(null)).toBe(false);
    expect(v(fresh)).toBe(true);
  });

  // #85 review: the failure states of a power-cycle, and the recovery.
  it('warns while the camera\'s PoE may be off', () => {
    const sw = { model: 'sscpoe-web', host: '192.168.1.217', port: 8, ports: 8, offSeconds: 10, passwordSet: true, configured: true, busy: false, poeMaybeOff: false, last: null };
    expect(poeAlert(sw)).toBeNull();
    expect(poeAlert(null)).toBeNull();
    expect(poeAlert({ ...sw, poeMaybeOff: true })).toBe("The camera's PoE may be OFF: use 'Turn camera PoE on', or the switch's web UI (port 8).");
  });

  it('says what a failed power-cycle left behind', () => {
    expect(powerCycleFailText({ error: 'switch_error', detail: 'x', poeOff: true, turnedOn: true }, 8)).toBe('Camera power-cycle failed after the PoE-off request: PoE may have been cut, and it is on again (x)');
    expect(powerCycleFailText({ error: 'switch_error', detail: 'y', poeOff: true, turnedOn: false }, 8)).toBe("Camera power-cycle failed: the camera's PoE may be OFF: use 'Turn camera PoE on', or the switch's web UI (port 8). (y)");
    expect(powerCycleFailText({ error: 'switch_busy', detail: 'z' }, 8)).toBe('Camera power-cycle: z');
    expect(powerCycleFailText({ error: 'power_cycle_needs_cams_admin', detail: 'cams-admin is not connected' }, null)).toBe('Camera power-cycle: cams-admin is not connected');
  });

  it('describes the PoE-on answer', () => {
    expect(poeOnText({ port: 8, wasOn: true, watts: 6.8 })).toBe('Camera PoE: port 8 was on already (6.8 W)');
    expect(poeOnText({ port: 8, wasOn: false, watts: 0 })).toBe('Camera PoE: turned on on port 8; the camera boots in about a minute');
  });

  // #85 review: the first /health read after the POST may already be the new process.
  it('a failed read before the POST: an answer started after the POST is the new process', () => {
    const postedAt = 5000;
    expect(restartWatch(null, postedAt)({ version: 'v1', startedAt: 6000 })).toBe(true);
    const w = restartWatch(null, postedAt);
    expect(w({ version: 'v1', startedAt: 1000 })).toBe(false); // the old process
    expect(w({ version: 'v1', startedAt: 6000 })).toBe(true);
    // With a read before the POST, that one decides.
    expect(restartWatch({ version: 'v1', startedAt: 1000 }, postedAt)({ version: 'v1', startedAt: 1000 })).toBe(false);
  });
});

describe('the restart wait (Maintenance, Find camera)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const answers = (list: ({ version: string; startedAt: number } | null)[]) => {
    vi.stubGlobal('fetch', async () => {
      const h = list.length > 1 ? list.shift() : list[0];
      if (h === null) throw new Error('down');
      return { ok: true, json: async () => h };
    });
  };

  it('readHealth: the answer, null when the proxy does not answer', async () => {
    answers([{ version: 'v1', startedAt: 1 }]);
    expect(await readHealth()).toEqual({ version: 'v1', startedAt: 1 });
    answers([null]);
    expect(await readHealth()).toBeNull();
  });

  it('polls every second and calls back once a new process answers', async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    answers([{ version: 'v1', startedAt: 1 }, null, { version: 'v1', startedAt: 9 }]);
    const gone = vi.fn();
    waitForNewProxy({ version: 'v1', startedAt: 1 }, 5, reload, gone);
    await vi.advanceTimersByTimeAsync(2000);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(gone).not.toHaveBeenCalled();
  });

  it('gives up after RESTART_GIVE_UP_MS; the stop ends the wait', async () => {
    vi.useFakeTimers();
    answers([{ version: 'v1', startedAt: 1 }]);
    const gone = vi.fn();
    waitForNewProxy({ version: 'v1', startedAt: 1 }, 5, () => undefined, gone);
    await vi.advanceTimersByTimeAsync(RESTART_GIVE_UP_MS + 2000);
    expect(gone).toHaveBeenCalledTimes(1);
    const gone2 = vi.fn();
    const stop = waitForNewProxy({ version: 'v1', startedAt: 1 }, 5, () => undefined, gone2);
    stop();
    await vi.advanceTimersByTimeAsync(RESTART_GIVE_UP_MS + 2000);
    expect(gone2).not.toHaveBeenCalled();
  });
});
