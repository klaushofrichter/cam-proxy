import type { Done } from '../fleet/commands';
import type { Purged } from './purge';
import { FILE_KINDS, type MovePlan } from './types';

// The small helpers every move module shares: a handler's answers, an empty
// per-kind tally, and plan equality.
export const ok = (result: Record<string, unknown> = {}): Done => ({ status: 'ok', result });
export const failed = (code: string): Done => ({ status: 'failed', code });
export const zeros = (): Purged => Object.fromEntries(FILE_KINDS.map((k) => [k, { files: 0, bytes: 0 }])) as Purged;
// Two plans alike: kinds in any order, target settings in any key order.
const canonical = (p: MovePlan): string => JSON.stringify([p.transfer, [...p.kinds].sort(), p.space, p.targetSettings ? Object.entries(p.targetSettings).sort(([a], [b]) => (a < b ? -1 : 1)) : null, p.budgetS, p.estimateS]);
export const samePlan = (a: MovePlan | null, b: MovePlan): boolean => a !== null && canonical(a) === canonical(b);
