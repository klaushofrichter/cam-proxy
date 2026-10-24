import type { Config } from '../config/defaults';

// What a finished or cancelled move leaves to age out (contract move.phase
// keepDays, 7..3650): the longest of the retention settings, at least a week.
export function keepDaysOf(r: Pick<Config['retention'], 'stillsDays' | 'previewsDays' | 'clipsDays' | 'eventsDays'>): number {
  return Math.min(3650, Math.max(7, r.stillsDays, r.previewsDays, r.clipsDays, r.eventsDays));
}
