import type { ProviderState } from '../analytics/service';
import { PROVIDERS } from '../analytics/providers';
import type { Config } from '../config/defaults';
import type { Handler } from './commands';

// analytics.usage.get (cams-admin Vision management design 2026-11-05): the
// state GET /control/analytics answers, per provider, for cams-admin's Vision
// tab. Where the key comes from (env, manual, none), never the key or its mask.
// A read: its own rate budget (command-check.ts), only the admin-command record.
export interface AnalyticsCommandDeps {
  state: () => ProviderState[];
  config: () => Config;
  now?: () => number;
}

const PROVIDERS_MAX = 8;
const CAMERAS_MAX = 64;

export function analyticsHandlers(d: AnalyticsCommandDeps): Record<'analytics.usage.get', Handler> {
  return {
    'analytics.usage.get': () => {
      const at = (d.now ?? Date.now)();
      const analytics = d.config().analytics;
      const providers = d.state().slice(0, PROVIDERS_MAX).map((s) => {
        const p = PROVIDERS.find((x) => x.id === s.id);
        const g = p ? analytics[p.configKey] : undefined;
        return {
          id: s.id,
          name: s.name,
          enabled: s.enabled,
          key: s.keySource,
          monthlyLimit: s.month.limit,
          remoteMaxMonthly: g?.remoteMaxMonthly ?? 0,
          dailyCap: s.today.cap,
          month: { calls: s.month.calls },
          today: { calls: s.today.calls },
          paused: s.paused ? { reason: s.paused.reason.slice(0, 64), until: s.paused.until } : null,
          // An error noted before its time was kept: the answer's time.
          lastError: s.lastError ? { at: s.lastErrorAt ?? at, message: s.lastError.slice(0, 200) } : null,
          cameras: s.cameras.slice(0, CAMERAS_MAX).map((c) => ({ id: c.id, today: c.today, month: c.month })),
        };
      });
      return { status: 'ok', result: { v: 1, at, providers } };
    },
  };
}
