import { setImmediate as yieldToLoop } from 'timers/promises';
import type { AuditLog, AuditRecord } from '../audit/audit-log';
import { DAY, dayStart } from '../time-units';

// Every audit record of `actions` in [from, to], oldest first. AuditLog.list
// reads a day file whole and synchronously (a busy day can reach 50 MB), so
// this asks for one UTC day at a time and yields to the event loop between
// days (#106): the stall is one day's read, not eight.
export async function records(audit: Pick<AuditLog, 'list'>, actions: string[], from: number, to: number): Promise<AuditRecord[]> {
  const out: AuditRecord[] = [];
  for (let day = dayStart(from); day <= to; day += DAY) {
    let after = '';
    for (;;) {
      const page = audit.list({ actions, from: Math.max(from, day), to: Math.min(to, day + DAY - 1), after, limit: 500 });
      out.push(...page.records);
      if (!page.hasMore || !page.next) break;
      after = page.next;
    }
    await yieldToLoop();
  }
  return out;
}
