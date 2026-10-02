import { describe, expect, it } from 'vitest';
import { cameraStateText, isNewStart, poeAlert, poeLine, poeOnText, powerCycleMessage, powerCycleFailText, restartWatch, RESTART_GIVE_UP_MS } from '../web/src/lib/maintenance';

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

  it('asks before a power-cycle with the switch, the port and the off time', () => {
    expect(powerCycleMessage({ host: '192.168.1.217', port: 8, offSeconds: 10 })).toBe(
      "Cut the camera's PoE power on 192.168.1.217 port 8 for 10 s? The camera is offline for about a minute. Only works while nobody is logged in to the switch's web UI.",
    );
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
