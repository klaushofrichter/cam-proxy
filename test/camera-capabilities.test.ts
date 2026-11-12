import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { deriveCapabilities, readCapabilities, POSITIONS_MAX } from '../src/camera/capabilities';

const MODELS = ['e1-outdoor-pro', 'rlc-1224a', 'cx820'];
const raw = (n: string) => readFileSync(join(__dirname, 'fixtures', 'abilities', `${n}.json`), 'utf8');
const fx = (n: string) => JSON.parse(raw(n)) as { Ability: { abilityChn: Record<string, { permit: number }>[] } };

describe('deriveCapabilities', () => {
  it('E1 Outdoor Pro: move, zoom, focus, autofocus, speed and 20 positions', () => {
    expect(deriveCapabilities(fx('e1-outdoor-pro'))).toEqual({ schema: 1, ptz: { move: true, zoom: true, focus: true, autofocus: true, speed: true, positions: { max: 20 } }, live: ['main', 'ext', 'sub'] });
    expect(POSITIONS_MAX).toBe(20);
  });

  it.each(['rlc-1224a', 'cx820'])('%s: no ptz, although supportZoom/supportFocus are set', (n) => {
    const a = fx(n);
    expect(a.Ability.abilityChn[0].supportZoom?.permit ?? a.Ability.abilityChn[0].supportFocus?.permit).toBeGreaterThan(0);
    expect(deriveCapabilities(a)).toMatchObject({ schema: 1, ptz: null });
  });

  // Reolink's abilityChn.live: ver 1 = main + ext + sub, ver 2 = main + sub (measured 2026-11-03).
  it.each([['cx820', ['main', 'ext', 'sub']], ['e1-outdoor-pro', ['main', 'ext', 'sub']], ['rlc-1224a', ['main', 'sub']]] as const)('%s: live streams %j', (n, live) => {
    expect(deriveCapabilities(fx(n)).live).toEqual(live);
  });

  it('live: only ver 1 offers ext; missing, 0 or unknown is main + sub', () => {
    for (const v of [undefined, { permit: 4 }, { permit: 4, ver: 0 }, { permit: 4, ver: 2 }, { permit: 4, ver: '1' }, { permit: 4, ver: 3 }]) {
      const a = fx('cx820');
      if (v === undefined) delete a.Ability.abilityChn[0].live;
      else a.Ability.abilityChn[0].live = v as { permit: number };
      expect(deriveCapabilities(a).live).toEqual(['main', 'sub']);
    }
  });

  it('ptzCtrl without ptzPreset: no positions key', () => {
    const a = fx('e1-outdoor-pro');
    a.Ability.abilityChn[0].ptzPreset = { permit: 0 };
    const caps = deriveCapabilities(a);
    expect(caps.ptz).not.toBeNull();
    expect(caps.ptz).not.toHaveProperty('positions');
  });

  it('speed false when supportPtzSpeed.permit is 0', () => {
    const a = fx('e1-outdoor-pro');
    a.Ability.abilityChn[0].supportPtzSpeed = { permit: 0 };
    expect(deriveCapabilities(a).ptz).toMatchObject({ speed: false, zoom: true, focus: true });
  });

  // Autofocus is started by a zoom to the current zoom (measured on the E1,
  // 2026-11-12): it needs zoom and a camera that has autofocus at all.
  it('autofocus needs disableAutoFocus and zoom', () => {
    const noAf = fx('e1-outdoor-pro');
    noAf.Ability.abilityChn[0].disableAutoFocus = { permit: 0 };
    expect(deriveCapabilities(noAf).ptz?.autofocus).toBe(false);
    const noZoom = fx('e1-outdoor-pro');
    noZoom.Ability.abilityChn[0].supportZoom = { permit: 0 };
    expect(deriveCapabilities(noZoom).ptz?.autofocus).toBe(false);
  });

  it('garbage → ptz null', () => {
    for (const v of [null, undefined, 7, 'x', {}, { Ability: {} }, { Ability: { abilityChn: [] } }, { Ability: { abilityChn: [null] } }]) expect(deriveCapabilities(v)).toEqual({ schema: 1, ptz: null, live: ['main', 'sub'] });
  });

  it('readCapabilities sends GetAbility with the user', async () => {
    const sent: unknown[] = [];
    const caps = await readCapabilities(async (cmd, param) => {
      sent.push([cmd, param]);
      return fx('e1-outdoor-pro');
    }, 'proxy');
    expect(sent).toEqual([['GetAbility', { User: { userName: 'proxy' } }]]);
    expect(caps.ptz?.move).toBe(true);
  });

  it('the fixtures carry no addresses or identifiers', () => {
    for (const n of MODELS) {
      const s = raw(n);
      expect(s).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
      expect(s).not.toMatch(/"(serial|mac|uid|UID)"\s*:/);
    }
  });
});
