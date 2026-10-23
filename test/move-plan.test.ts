import { describe, expect, it } from 'vitest';
import { autoPlan } from '../src/moves/plan';
import { approveProblem } from '../src/moves/source';
import { planFrom as webPlanFrom } from '../web/src/lib/moves';
import { planFrom } from '../src/moves/plan';
import type { MoveAnswer, MoveBounds, MoveKind, MoveSummary, Space } from '../src/moves/types';

const kind = (files: number, bytes: number) => ({ files, bytes, rows: 0, oldest: files ? 1_700_000_000_000 : null, newest: files ? 1_700_000_900_000 : null });
const summary: MoveSummary = { stills: kind(10, 4 * 1024 ** 3), clips: kind(5, 2 * 1024 ** 3), events: kind(0, 0), checks: kind(0, 0), archive: kind(1, 1024 ** 3) };
const tight: Space = { needed: 7 * 1024 ** 3, available: 3 * 1024 ** 3, fits: false, perKind: {}, retentionProposal: { 'stills.maxGB': 90, 'storage.maxBytes': 200 * 1024 ** 3 } };
const fitsA: MoveAnswer = { accept: true, space: { needed: 7 * 1024 ** 3, available: 100 * 1024 ** 3, fits: true, perKind: {}, retentionProposal: null }, estimateS: 540 };
const tightA: MoveAnswer = { accept: true, space: tight, estimateS: 540 };
const all5 = ['stills', 'clips', 'events', 'checks', 'archive'] as MoveKind[];

describe('autoPlan', () => {
  it('fits: all kinds with content, space all, budget the rounded estimate', () =>
    expect(autoPlan({ transfer: true, kinds: all5, space: 'fit', maxBudgetS: 3600 }, summary, fitsA))
      .toEqual({ plan: { transfer: true, kinds: ['stills', 'clips', 'archive'], space: 'all', targetSettings: null, budgetS: 540, estimateS: 540 } }));
  it('bounds kinds narrow the plan', () =>
    expect((autoPlan({ transfer: true, kinds: ['clips'], space: 'fit', maxBudgetS: 3600 }, summary, fitsA) as any).plan.kinds).toEqual(['clips']));
  it('over the budget waits', () =>
    expect(autoPlan({ transfer: true, kinds: all5, space: 'fit', maxBudgetS: 539 }, summary, fitsA)).toEqual({ reason: 'over_budget' }));
  it('estimate equal to maxBudgetS', () =>
    expect((autoPlan({ transfer: true, kinds: all5, space: 'fit', maxBudgetS: 540 }, summary, fitsA) as any).plan.budgetS).toBe(540));
  it('the rounded budget is capped at maxBudgetS', () =>
    expect((autoPlan({ transfer: true, kinds: all5, space: 'fit', maxBudgetS: 560 }, summary, { ...fitsA, estimateS: 541 }) as any).plan.budgetS).toBe(560));
  it('tight + omit leaving stills out fits exactly', () =>
    expect((autoPlan({ transfer: true, kinds: ['clips', 'archive'], space: 'omit', maxBudgetS: 3600 }, summary, tightA) as any).plan)
      .toMatchObject({ kinds: ['clips', 'archive'], space: 'omit', targetSettings: null }));
  it('tight + omit that still does not fit waits', () =>
    expect(autoPlan({ transfer: true, kinds: ['stills'], space: 'omit', maxBudgetS: 3600 }, summary, tightA)).toEqual({ reason: 'space' }));
  it('tight + all waits', () =>
    expect(autoPlan({ transfer: true, kinds: all5, space: 'all', maxBudgetS: 3600 }, summary, tightA)).toEqual({ reason: 'space' }));
  it('tight + retention takes the proposal', () =>
    expect((autoPlan({ transfer: true, kinds: all5, space: 'retention', maxBudgetS: 3600 }, summary, tightA) as any).plan)
      .toMatchObject({ space: 'retention', targetSettings: { 'stills.maxGB': 90, 'storage.maxBytes': 200 * 1024 ** 3 } }));
  it('tight + retention without a proposal waits', () =>
    expect(autoPlan({ transfer: true, kinds: all5, space: 'retention', maxBudgetS: 3600 }, summary, { ...tightA, space: { ...tight, retentionProposal: null } })).toEqual({ reason: 'space' }));
  it('no transfer: no kinds, budget the estimate', () =>
    expect(autoPlan({ transfer: false, kinds: [], space: 'all', maxBudgetS: 3600 }, summary, fitsA))
      .toEqual({ plan: { transfer: false, kinds: [], space: 'all', targetSettings: null, budgetS: 540, estimateS: 540 } }));
  it('no estimate waits', () =>
    expect(autoPlan({ transfer: true, kinds: all5, space: 'fit', maxBudgetS: 3600 }, summary, { accept: true, space: fitsA.space })).toEqual({ reason: 'no_estimate' }));
  it('every plan autoPlan returns passes approveProblem', () => {
    let plans = 0;
    for (const space of ['all', 'omit', 'retention', 'fit'] as const)
      for (const transfer of [true, false])
        for (const kinds of [all5, ['clips'], []] as MoveKind[][])
          for (const a of [fitsA, tightA]) {
            const b: MoveBounds = { transfer, kinds, space, maxBudgetS: 3600 };
            const r = autoPlan(b, summary, a);
            if ('plan' in r) { plans++; expect(approveProblem(r.plan, summary, a)).toBeNull(); }
          }
    expect(plans).toBeGreaterThan(8);
  });
  it('the web lib re-exports the same functions', () => expect(webPlanFrom).toBe(planFrom));
});
