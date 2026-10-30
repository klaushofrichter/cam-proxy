import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { deriveCapabilities, readCapabilities, POSITIONS_MAX } from '../src/camera/capabilities';

const MODELS = ['e1-outdoor-pro', 'rlc-1224a', 'cx820'];
const raw = (n: string) => readFileSync(join(__dirname, 'fixtures', 'abilities', `${n}.json`), 'utf8');
const fx = (n: string) => JSON.parse(raw(n)) as { Ability: { abilityChn: Record<string, { permit: number }>[] } };

describe('deriveCapabilities', () => {
  it('E1 Outdoor Pro: move, zoom, focus, speed and 20 positions', () => {
    expect(deriveCapabilities(fx('e1-outdoor-pro'))).toEqual({ schema: 1, ptz: { move: true, zoom: true, focus: true, speed: true, positions: { max: 20 } } });
    expect(POSITIONS_MAX).toBe(20);
  });

  it.each(['rlc-1224a', 'cx820'])('%s: no ptz, although supportZoom/supportFocus are set', (n) => {
    const a = fx(n);
    expect(a.Ability.abilityChn[0].supportZoom?.permit ?? a.Ability.abilityChn[0].supportFocus?.permit).toBeGreaterThan(0);
    expect(deriveCapabilities(a)).toEqual({ schema: 1, ptz: null });
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

  it('garbage → ptz null', () => {
    for (const v of [null, undefined, 7, 'x', {}, { Ability: {} }, { Ability: { abilityChn: [] } }, { Ability: { abilityChn: [null] } }]) expect(deriveCapabilities(v)).toEqual({ schema: 1, ptz: null });
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
