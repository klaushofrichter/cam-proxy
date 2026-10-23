import { describe, expect, it } from 'vitest';
import { autoWaitText, budgetDefault, movedText, refusalText, estimateText, failText, limitText, phaseText, planFrom, rejectText, sizeText, spaceOptions, statusLine, type MoveForm } from '../web/src/lib/moves';
import type { MoveSummary, Space } from '../src/moves/types';

const kind = (files: number, bytes: number) => ({ files, bytes, rows: 0, oldest: files ? 1_700_000_000_000 : null, newest: files ? 1_700_000_900_000 : null });
const summary: MoveSummary = { stills: kind(10, 4 * 1024 ** 3), clips: kind(5, 2 * 1024 ** 3), events: kind(0, 0), checks: kind(0, 0), archive: kind(1, 1024 ** 3) };
const tight: Space = { needed: 7 * 1024 ** 3, available: 3 * 1024 ** 3, fits: false, perKind: {}, retentionProposal: { 'stills.maxGB': 90, 'storage.maxBytes': 200 * 1024 ** 3 } };
const base: MoveForm = { transfer: true, leaveOut: [], option: 'fit', budgetMin: 10, estimateS: 540, summary, space: tight };

describe('budgetDefault', () => {
  it('rounds the estimate up to whole minutes', () => {
    expect(budgetDefault(540)).toBe(9);
    expect(budgetDefault(541)).toBe(10);
    expect(budgetDefault(1)).toBe(1);
    expect(budgetDefault(0)).toBe(1);
  });
});

describe('estimateText', () => {
  it('reads in seconds, minutes, hours', () => {
    expect(estimateText(45)).toBe('45 s');
    expect(estimateText(600)).toBe('10 min');
    expect(estimateText(4800)).toBe('1 h 20 min');
    expect(estimateText(7200)).toBe('2 h');
  });
});

describe('spaceOptions', () => {
  it('offers retention only with a proposal', () => {
    expect(spaceOptions(tight)).toEqual(['omit', 'retention', 'fit']);
    expect(spaceOptions({ ...tight, retentionProposal: null })).toEqual(['omit', 'fit']);
    expect(spaceOptions({ ...tight, retentionProposal: {} })).toEqual(['omit', 'fit']);
  });
  it('offers nothing when everything fits or there is no answer', () => {
    expect(spaceOptions({ ...tight, fits: true })).toEqual([]);
    expect(spaceOptions(undefined)).toEqual([]);
  });
});

describe('planFrom', () => {
  it('refuses a budget below the estimate', () => {
    const r = planFrom({ ...base, budgetMin: 5 });
    expect(r.plan).toBeNull();
    expect(r.error).toBe("The time budget can't be below the estimate (9 min).");
  });
  it('fit: every kind with content, newest first on the target', () => {
    expect(planFrom(base).plan).toEqual({ transfer: true, kinds: ['stills', 'clips', 'archive'], space: 'fit', targetSettings: null, budgetS: 600, estimateS: 540 });
  });
  it('omit: the kinds left out are dropped, and what is left must fit', () => {
    expect(planFrom({ ...base, option: 'omit', leaveOut: ['stills'] }).plan).toMatchObject({ kinds: ['clips', 'archive'], space: 'omit' });
    expect(planFrom({ ...base, option: 'omit', leaveOut: [] }).error).toBe("What is left still doesn't fit.");
  });
  it('retention: the proposal travels as the target settings', () => {
    expect(planFrom({ ...base, option: 'retention' }).plan).toMatchObject({ space: 'retention', kinds: ['stills', 'clips', 'archive'], targetSettings: tight.retentionProposal });
  });
  it('everything fits: space all; no transfer: nothing else', () => {
    expect(planFrom({ ...base, space: { ...tight, fits: true } }).plan).toMatchObject({ space: 'all', targetSettings: null });
    expect(planFrom({ ...base, transfer: false }).plan).toEqual({ transfer: false, kinds: [], space: 'all', targetSettings: null, budgetS: 600, estimateS: 540 });
  });
});

describe('texts', () => {
  it('rejections name the target and the reason', () => {
    expect(rejectText('Shed', 'camera_limit', '192.0.2.10')).toBe("Shed can't take this camera: it already has as many cameras as it may");
    expect(rejectText('Shed', 'ca_does_not_cover_camera', '192.0.2.10')).toBe("Shed can't take this camera: its site certificate authority doesn't cover 192.0.2.10");
    expect(rejectText('Shed', undefined, '')).toBe("Shed can't take this camera: it didn't answer");
    expect(rejectText('Shed', 'not_registered', '192.0.2.10')).toBe("Shed can't take this camera: cams-admin doesn't know this camera (register it in cams-admin first)");
    expect(rejectText('Shed', 'internal', '192.0.2.10')).toBe("Shed can't take this camera: something went wrong in cams-admin; try again");
  });
  it('an offer cams-admin started and the source left for a person says why', () => {
    expect(autoWaitText('over_budget')).toBe('Started from cams-admin; not approved automatically: the estimate is over the time budget cams-admin allowed. Approve it here or cancel.');
    expect(autoWaitText('space')).toBe("Started from cams-admin; not approved automatically: the content doesn't fit the way cams-admin allowed. Approve it here or cancel.");
    expect(autoWaitText('no_estimate')).toBe('Started from cams-admin; not approved automatically: the target gave no estimate. Approve it here or cancel.');
    expect(autoWaitText('not_allowed')).toBe("Started from cams-admin; not approved automatically: sending cameras away isn't allowed here right now. Approve it here or cancel.");
    expect(autoWaitText('plan')).toBe('Started from cams-admin; not approved automatically: the plan did not fit the answer. Approve it here or cancel.');
  });
  it('limits show their unit', () => {
    expect(limitText('stills.maxGB', 90)).toBe('stills.maxGB: 90 GB');
    expect(limitText('storage.maxBytes', 200 * 1024 ** 3)).toBe('storage.maxBytes: 200.0 GB');
  });
  it('this proxy refusing to start, and a moved leftover', () => {
    expect(refusalText('no_site_ca')).toBe("This proxy has no site certificate authority, so its cameras can't be moved.");
    expect(refusalText('whatever')).toBe('whatever');
    expect(movedText('Shed', 'mv_0123456789ABCDEFGHJK')).toBe('Moved to Shed (mv_0123456789ABCDEFGHJK). You can delete it from config.json.');
  });
  it('sizes', () => {
    expect(sizeText(512)).toBe('512 B');
    expect(sizeText(1536 * 1024)).toBe('1.5 MB');
  });
  it('phases and failures', () => {
    expect(phaseText('opened')).toBe('waiting for approval');
    expect(phaseText('switching')).toBe('switching over');
    expect(phaseText('released')).toBe('copying');
    expect(phaseText('finished')).toBe('done');
    expect(failText('cert_failed')).toBe('the certificate could not be handed over');
    expect(failText('weird_code')).toBe('weird_code');
  });
  it('the status line', () => {
    const v = { camera: 'cam1', target: { proxyId: 'p', name: 'Shed' }, phase: 'copying', budgetExceeded: false, progress: { bytesDone: 1024 ** 3, bytesTotal: 4 * 1024 ** 3, rateBps: 1e6, etaS: 600 } };
    expect(statusLine(v, 'Garden')).toBe('Moving Garden to Shed: copying, 1.0 GB of 4.0 GB (25%), about 10 min left');
    expect(statusLine({ ...v, phase: 'switching', progress: undefined }, 'Garden')).toBe('Moving Garden to Shed: switching over');
    expect(statusLine({ ...v, phase: 'failed', failure: 'camera_failed' }, 'Garden')).toBe('Moving Garden to Shed: failed, the camera did not take the new settings');
  });
});
