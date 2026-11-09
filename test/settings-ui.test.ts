import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { poeOnLabel, poeOnText, switchLine } from '../web/src/lib/switches';
import { parseSetting, resetCounts, resetLabel, resetPlan, sameBadge, settingText } from '../web/src/lib/settings';

// The Settings page turns its text fields into the setting's type (#85: an
// optional number without a value, camera.poeSwitch.port, was saved as text).
describe('Settings page: parseSetting', () => {
  it('uses the setting type, also when there is no value yet', () => {
    expect(parseSetting('integer', undefined, '8')).toBe(8);
    expect(parseSetting('integer', 3, '12')).toBe(12);
    expect(parseSetting('boolean', undefined, 'true')).toBe(true);
    expect(parseSetting('boolean', true, 'false')).toBe(false);
    expect(parseSetting('string', undefined, '192.168.1.217')).toBe('192.168.1.217');
    expect(parseSetting('string', 'none', 'sscpoe-web')).toBe('sscpoe-web');
  });

  it('falls back to the current value type without one (an older proxy)', () => {
    expect(parseSetting(undefined, 5, '6')).toBe(6);
    expect(parseSetting(undefined, false, 'true')).toBe(true);
    expect(parseSetting(undefined, undefined, '7')).toBe('7');
  });
});

// Klaus 2026-10-05: Reset shows what it goes back to, in the setting's unit.
describe('Settings page: Reset shows the default', () => {
  it('formats a value with the unit its name carries', () => {
    expect(settingText('retention.auditDays', 90)).toBe('90 days');
    expect(settingText('retention.auditDays', 1)).toBe('1 day');
    expect(settingText('retention.intervalMin', 60)).toBe('60 min');
    expect(settingText('sse.pingS', 15)).toBe('15 s');
    expect(settingText('camera.poeSwitch.offSeconds', 10)).toBe('10 s');
    expect(settingText('storage.keepHours.stills', 24)).toBe('24 hours');
    expect(settingText('ftp.stalledHours', 6)).toBe('6 hours');
    expect(settingText('recordings.cacheMB', 2048)).toBe('2048 MB');
    expect(settingText('stills.maxGB', 20)).toBe('20 GB');
    expect(settingText('storage.minFreeBytes', 2147483648)).toBe('2147483648 bytes');
    expect(settingText('health.diskPercent', 90)).toBe('90 %');
    expect(settingText('health.tempC', 75)).toBe('75 °C');
    expect(settingText('sse.maxClients', 50)).toBe('50');
    expect(settingText('stills.enabled', true)).toBe('on');
    expect(settingText('ftp.tls', false)).toBe('off');
    expect(settingText('stills.stream', 'sub')).toBe('sub');
    expect(settingText('server.logLevel', '')).toBe('(empty)');
    expect(settingText('camera.poeSwitch.port', undefined)).toBe('not set');
  });
  it('labels Reset with the value it goes back to, naming config.json when it comes from there', () => {
    expect(resetLabel('retention.auditDays', { value: 90, source: 'default' })).toBe('Reset – 90 days');
    expect(resetLabel('stills.enabled', { value: true, source: 'default' })).toBe('Reset – on');
    expect(resetLabel('camera.statusPollS', { value: 5, source: 'file' })).toBe('Reset – 5 s (config.json)');
    expect(resetLabel('camera.poeSwitch.port', { source: 'default' })).toBe('Reset – not set');
    expect(resetLabel('sse.pingS', undefined)).toBe('Reset');
  });
  it('plans "Reset to defaults": every override, current → what it goes back to', () => {
    const view = {
      'retention.auditDays': { value: 30, source: 'override' as const, resetTo: { value: 90, source: 'default' as const } },
      'retention.stillsDays': { value: 7, source: 'default' as const },
      'camera.statusPollS': { value: 5, source: 'override' as const, pending: true, next: 8, resetTo: { value: 5, source: 'file' as const } },
      'stills.enabled': { value: false, source: 'override' as const, resetTo: { value: true, source: 'default' as const } },
    };
    expect(resetPlan(view)).toEqual([
      'retention.auditDays: 30 days → 90 days',
      'camera.statusPollS: 8 s → 5 s (config.json)',
      'stills.enabled: off → on',
    ]);
    expect(resetPlan({ 'retention.stillsDays': { value: 7, source: 'default' } })).toEqual([]);
  });
});

// Klaus 2026-10-05 (the Pi's PoE rows): Reset only where it changes
// something, and say what an unset state means.
describe('Settings page: honest Reset', () => {
  it('names what none / not set / off means on the button', () => {
    expect(resetLabel('camera.poeSwitch.model', { value: 'none', source: 'default', means: 'no PoE switch: power-cycle off' })).toBe('Reset – none (no PoE switch: power-cycle off)');
    expect(resetLabel('camera.poeSwitch.host', { source: 'default', means: 'PoE switch control off: no switch address' })).toBe('Reset – not set (PoE switch control off: no switch address)');
  });
  it('marks an override equal to the default (or config.json) instead of offering a Reset', () => {
    expect(sameBadge('camera.poeSwitch.ports', { value: 8, source: 'default', same: true })).toEqual({ text: 'override = default', title: expect.stringMatching(/same as the default \(8\).*Reset would change nothing.*Reset to defaults/) });
    expect(sameBadge('sse.pingS', { value: 20, source: 'file', same: true })).toEqual({ text: 'override = config.json', title: expect.stringMatching(/same as the config\.json value \(20 s\)/) });
    expect(sameBadge('sse.pingS', { value: 20, source: 'file' })).toBeNull();
    expect(sameBadge('sse.pingS', undefined)).toBeNull();
  });
  it('lists overrides equal to the default as one "no change in effect" line in Reset to defaults', () => {
    const view = {
      'camera.poeSwitch.model': { value: 'sscpoe-web', source: 'override' as const, resetTo: { value: 'none', source: 'default' as const, means: 'no PoE switch: power-cycle off' } },
      'camera.poeSwitch.host': { value: '192.168.1.217', source: 'override' as const, resetTo: { source: 'default' as const, means: 'PoE switch control off: no switch address' } },
      'camera.poeSwitch.ports': { value: 8, source: 'override' as const, resetTo: { value: 8, source: 'default' as const, same: true as const } },
      'camera.poeSwitch.offSeconds': { value: 10, source: 'override' as const, resetTo: { value: 10, source: 'default' as const, same: true as const } },
    };
    expect(resetPlan(view)).toEqual([
      'camera.poeSwitch.model: sscpoe-web → none (no PoE switch: power-cycle off)',
      'camera.poeSwitch.host: 192.168.1.217 → not set (PoE switch control off: no switch address)',
      '2 overrides equal to the default are removed too, no change in effect: camera.poeSwitch.ports, camera.poeSwitch.offSeconds',
    ]);
    expect(resetCounts(view)).toEqual({ changes: 2, same: 2 });
    expect(resetPlan({ 'sse.pingS': view['camera.poeSwitch.ports'] })).toEqual(['1 override equal to the default is removed too, no change in effect: sse.pingS']);
  });
});

// The PoE switches card (spec 2026-11-07-poe-switches-design): the password is only ever set, never shown.
describe('Settings page: PoE switches card', () => {
  const sw = { id: 'sw_a', model: 'sscpoe-web', host: '203.0.113.17', ports: 8, offSeconds: 10, busy: false, poeMaybeOff: [5], passwordElsewhere: false };
  it('says whether the password is set', () => {
    expect(switchLine({ ...sw, passwordSet: true })).toBe('203.0.113.17 · 8 ports · password set');
    expect(switchLine({ ...sw, passwordSet: false })).toBe('203.0.113.17 · 8 ports · no password yet');
  });
  // #364: a password stored for the switch's old address is not "no password yet".
  it('a password set for another address says so', () => {
    expect(switchLine({ ...sw, passwordSet: false, passwordElsewhere: true })).toBe('203.0.113.17 · 8 ports · password set for another address: set it again');
  });
  it('words the per-port PoE on', () => {
    expect(poeOnLabel(5)).toBe('Turn PoE on (port 5)');
    expect(poeOnText(5, false)).toBe('PoE turned on at port 5.');
    expect(poeOnText(5, true)).toBe('Port 5 had PoE on already.');
  });
});

describe('PoE switches card: the password field', () => {
  it('is a new password to the browser (never filled with the saved proxy login)', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'src', 'components', 'PoeSwitchesCard.svelte'), 'utf8');
    const input = /<input[^>]*data-testid="switch-password-input"[^>]*>/.exec(src)?.[0] ?? '';
    expect(input).toContain('autocomplete="new-password"');
  });
});
