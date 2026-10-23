// The camera-move plan rules, shared by the admin UI (web/src/lib/moves.ts
// re-exports them) and the proxy's auto-approval. No Node imports: the web
// bundle imports this file.
import type { MoveAnswer, MoveBounds, MoveKind, MovePlan, MoveSummary, Space } from './types';

export const KINDS: readonly MoveKind[] = ['stills', 'clips', 'events', 'checks', 'archive'];

export function estimateText(s: number): string {
  const sec = Math.max(0, Math.round(s));
  if (sec < 60) return `${sec} s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

// The time budget field is in minutes: the estimate rounded up to whole minutes (at least one).
export const budgetDefault = (estimateS: number): number => Math.max(1, Math.ceil(estimateS / 60));

export const hasContent = (s: MoveSummary, k: MoveKind): boolean => s[k].files + s[k].rows > 0;
export const kindsWithContent = (s: MoveSummary): MoveKind[] => KINDS.filter((k) => hasContent(s, k));

// The options when the content does not fit the target; retention only with a proposal.
export function spaceOptions(space: Space | undefined): ('omit' | 'retention' | 'fit')[] {
  if (!space || space.fits) return [];
  return space.retentionProposal && Object.keys(space.retentionProposal).length ? ['omit', 'retention', 'fit'] : ['omit', 'fit'];
}

export interface MoveForm {
  transfer: boolean;
  leaveOut: MoveKind[];
  option: 'omit' | 'retention' | 'fit';
  budgetMin: number;
  estimateS: number;
  summary: MoveSummary;
  space?: Space;
}

// The plan the form means, or why not (a budget below the estimate is refused here, as by the proxy).
export function planFrom(f: MoveForm): { plan: MovePlan | null; error: string | null } {
  const budgetS = Math.round(f.budgetMin * 60);
  if (!Number.isFinite(budgetS) || budgetS < f.estimateS) return { plan: null, error: `The time budget can't be below the estimate (${estimateText(f.estimateS)}).` };
  const common = { budgetS, estimateS: f.estimateS };
  if (!f.transfer) return { plan: { transfer: false, kinds: [], space: 'all', targetSettings: null, ...common }, error: null };
  const all = kindsWithContent(f.summary);
  if (!f.space || f.space.fits) return { plan: { transfer: true, kinds: all, space: 'all', targetSettings: null, ...common }, error: null };
  if (f.option === 'omit') {
    const kinds = all.filter((k) => !f.leaveOut.includes(k));
    if (kinds.reduce((n, k) => n + f.summary[k].bytes, 0) > f.space.available) return { plan: null, error: "What is left still doesn't fit." };
    return { plan: { transfer: true, kinds, space: 'omit', targetSettings: null, ...common }, error: null };
  }
  if (f.option === 'retention') {
    if (!f.space.retentionProposal) return { plan: null, error: 'The target proposed no limits.' };
    return { plan: { transfer: true, kinds: all, space: 'retention', targetSettings: f.space.retentionProposal, ...common }, error: null };
  }
  return { plan: { transfer: true, kinds: all, space: 'fit', targetSettings: null, ...common }, error: null };
}

// Why an offer is left for a person instead of being approved by the source.
export type AutoWaitReason = 'over_budget' | 'space' | 'no_estimate' | 'not_allowed' | 'plan';

// The plan the panel would build for the bounds and the target's accepted
// answer (the caller checks accept), or why a person has to decide.
export function autoPlan(b: MoveBounds, summary: MoveSummary, answer: MoveAnswer): { plan: MovePlan } | { reason: AutoWaitReason } {
  const estimateS = answer.estimateS;
  if (estimateS === undefined) return { reason: 'no_estimate' };
  if (estimateS > b.maxBudgetS) return { reason: 'over_budget' };
  const fits = !answer.space || answer.space.fits;
  if (b.transfer && !fits && b.space === 'all') return { reason: 'space' };
  const r = planFrom({
    transfer: b.transfer,
    leaveOut: kindsWithContent(summary).filter((k) => !b.kinds.includes(k)),
    option: fits || b.space === 'all' ? 'fit' : b.space,
    budgetMin: (b.transfer ? Math.min(budgetDefault(estimateS) * 60, b.maxBudgetS) : estimateS) / 60,
    estimateS,
    summary,
    space: answer.space,
  });
  if (!r.plan) return { reason: 'space' };
  if (r.plan.space !== 'omit') r.plan.kinds = r.plan.kinds.filter((k) => b.kinds.includes(k));
  return { plan: r.plan };
}
