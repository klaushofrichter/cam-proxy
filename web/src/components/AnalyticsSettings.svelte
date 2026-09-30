<script lang="ts">
  import { api, ApiError } from '../lib/api';
  import { status } from '../lib/state';
  import { costEstimate, parseLimit, type UiProviderState } from '../lib/analytics';

  // The Analytics card (spec 2026-09-30-analytics-design): event kinds, and per
  // provider its switch, masked key, limits, estimate and the shared-key note.
  let { view, onsaved }: { view: Record<string, { value: unknown }>; onsaved: (v: Record<string, { value: unknown }>) => void } = $props();
  let message = $state('');
  const val = <T,>(p: string) => view[p]?.value as T;
  const provider = $derived(($status?.analytics?.[0] ?? null) as UiProviderState | null);
  // A draft stays undefined until the user types, so a reload of the settings
  // (Refresh, another save) never overwrites what is being typed; the field
  // shows the saved value meanwhile.
  const savedMonthly = $derived(String(val<number>('analytics.googleVision.monthlyLimit') ?? 0));
  const savedDaily = $derived(String(val<number>('analytics.googleVision.dailyCap') ?? 0));
  let monthlyDraft = $state<string | undefined>(undefined);
  let dailyDraft = $state<string | undefined>(undefined);
  const monthly = $derived(monthlyDraft ?? savedMonthly);
  const daily = $derived(dailyDraft ?? savedDaily);
  const monthlyValue = $derived(parseLimit(monthly, 100000));
  const dailyValue = $derived(parseLimit(daily, 10000));

  async function put(body: object, what: string, clear?: () => void) {
    try {
      onsaved(await api('PUT', '/control/config', { analytics: body }));
      if (clear) clear();
      message = `${what} saved`;
    } catch (e) {
      message = e instanceof ApiError ? e.message : 'not saved';
    }
  }
  const kinds = ['person', 'vehicle', 'pet'] as const;
  const noKinds = $derived(kinds.every((k) => !val<boolean>(`analytics.kinds.${k}`)));
</script>

<div class="card analytics" data-testid="analytics-settings">
  <h3>Analytics</h3>
  <p class="muted small">Sends the still of an event to an image-analysis service and keeps the objects it finds (a second opinion on the camera's label).</p>
  <fieldset>
    <legend>Analyse these events</legend>
    {#each kinds as k (k)}
      <label><input type="checkbox" data-testid={`analytics-kind-${k}`} checked={val<boolean>(`analytics.kinds.${k}`)} onchange={(e) => void put({ kinds: { [k]: (e.currentTarget as HTMLInputElement).checked } }, `${k} events`)} /> {k}</label>
    {/each}
    <p class="muted small">Motion-only events are never analysed.{noKinds ? ' No kind is selected: nothing is analysed.' : ''}</p>
  </fieldset>

  <div class="provider" data-testid="analytics-provider-google-vision">
    <h4>Google Vision</h4>
    <label class="switch">
      <input type="checkbox" data-testid="analytics-enabled" disabled={!provider?.keyMasked} checked={val<boolean>('analytics.googleVision.enabled')}
        onchange={(e) => void put({ googleVision: { enabled: (e.currentTarget as HTMLInputElement).checked } }, 'Google Vision')} />
      enabled
    </label>
    <p class="small" data-testid="analytics-key">
      Key: {#if provider?.keyMasked}<span class="mono">{provider.keyMasked}</span>{:else}not set: add <span class="mono">CAMPROXY_GOOGLE_VISION_KEY</span> to the environment and restart{/if}
    </p>
    <label>Calls per month <input type="number" min="0" max="100000" step="1" value={monthly} oninput={(e) => (monthlyDraft = e.currentTarget.value)} data-testid="analytics-monthly" />
      <button disabled={monthlyValue === null} data-testid="analytics-monthly-save" onclick={() => monthlyValue !== null && void put({ googleVision: { monthlyLimit: monthlyValue } }, 'Monthly limit', () => (monthlyDraft = undefined))}>Save</button></label>
    {#if monthlyValue === null}<p class="hint small" data-testid="analytics-monthly-hint">a whole number from 0 to 100,000</p>{/if}
    <label>At most per day (0 = no cap) <input type="number" min="0" max="10000" step="1" value={daily} oninput={(e) => (dailyDraft = e.currentTarget.value)} data-testid="analytics-daily" />
      <button disabled={dailyValue === null} data-testid="analytics-daily-save" onclick={() => dailyValue !== null && void put({ googleVision: { dailyCap: dailyValue } }, 'Daily cap', () => (dailyDraft = undefined))}>Save</button></label>
    {#if dailyValue === null}<p class="hint small" data-testid="analytics-daily-hint">a whole number from 0 to 10,000</p>{/if}
    <p class="small" data-testid="analytics-estimate">{costEstimate(monthlyValue ?? 0)}</p>
    <p class="muted small">The limit counts this proxy's calls only. Proxies that share a key share Google's budget: keep their limits' total within it.</p>
  </div>
  {#if message}<p class="msg" data-testid="analytics-message">{message}</p>{/if}
</div>

<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
  .analytics { border-left: 4px solid #a855f7; }
  h3 { margin: 0 0 6px; font-size: 16px; }
  h4 { margin: 8px 0 4px; font-size: 14px; }
  fieldset { border: 0; padding: 0; margin: 0; display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  legend { font-size: 13px; color: var(--muted); padding: 0; margin-bottom: 4px; }
  .provider { display: grid; gap: 6px; padding-top: 6px; border-top: 1px solid var(--border); }
  input[type='number'] { width: 90px; padding: 4px 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; }
  button { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); }
  button:hover { border-color: var(--accent); }
  .mono { font-family: var(--mono); }
  .muted { color: var(--muted); margin: 0; }
  .small { font-size: 13px; }
  .hint { margin: 0; color: var(--danger); }
  button:disabled { opacity: 0.5; cursor: default; }
  .msg { margin: 6px 0 0; color: var(--accent); }
</style>
