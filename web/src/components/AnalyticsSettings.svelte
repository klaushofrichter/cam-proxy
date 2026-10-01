<script lang="ts">
  import { api, ApiError } from '../lib/api';
  import { refresh, status } from '../lib/state';
  import { estimateFor, keyNotice, parseLimit, validKey, type UiProviderState } from '../lib/analytics';

  // The Analytics card (spec 2026-09-30-analytics-design): event kinds, and per
  // provider its switch, masked key, limits, estimate and the shared-key note.
  let { view, onsaved }: { view: Record<string, { value: unknown }>; onsaved: (v: Record<string, { value: unknown }>) => void } = $props();
  let message = $state('');
  const val = <T,>(p: string) => view[p]?.value as T;
  const provider = $derived((($status?.analytics ?? []) as UiProviderState[]).find((p) => p.id === 'google-vision') ?? null);
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

  // The message is cleared first, so a new "saved" is never the old one. A
  // refused change puts a checkbox back (`box`).
  async function put(body: object, what: string, clear?: () => void, box?: HTMLInputElement) {
    message = '';
    try {
      onsaved(await api('PUT', '/control/config', { analytics: body }));
      if (clear) clear();
      message = `${what} saved`;
    } catch (e) {
      if (box) box.checked = !box.checked;
      message = e instanceof ApiError ? e.message : 'not saved';
    }
  }
  // A checkbox's change, put back if the PUT is refused.
  const toggle = (e: Event, body: (on: boolean) => object, what: string) => {
    const box = e.currentTarget as HTMLInputElement;
    void put(body(box.checked), what, undefined, box);
  };
  // Issue #70: a key set here is kept in memory only (never shown again, never
  // saved); the field is cleared once it is accepted.
  let keyDraft = $state('');
  const keyOk = $derived(validKey(keyDraft));
  const notice = $derived(keyNotice(provider));
  async function setKey() {
    if (!keyOk) return;
    message = '';
    try {
      await api('PUT', '/control/secrets/google-vision-key', { key: keyDraft });
      keyDraft = '';
      message = 'Google Vision key set';
      await refresh();
    } catch (e) {
      message = e instanceof ApiError ? e.message : 'not set';
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
      <label><input type="checkbox" data-testid={`analytics-kind-${k}`} checked={val<boolean>(`analytics.kinds.${k}`)} onchange={(e) => toggle(e, (on) => ({ kinds: { [k]: on } }), `${k} events`)} /> {k}</label>
    {/each}
    <p class="muted small">Motion-only events are never analysed.{noKinds ? ' No kind is selected: nothing is analysed.' : ''}</p>
  </fieldset>

  <div class="provider" data-testid="analytics-provider-google-vision">
    <h4>Google Vision</h4>
    <label class="switch">
      <!-- Disabled only once the status says there is no key (no flash while it loads). -->
      <input type="checkbox" data-testid="analytics-enabled" disabled={provider !== null && !provider.keyMasked} aria-describedby="analytics-key-text" checked={val<boolean>('analytics.googleVision.enabled')}
        onchange={(e) => toggle(e, (on) => ({ googleVision: { enabled: on } }), 'Google Vision')} />
      enabled
    </label>
    <p class="small" id="analytics-key-text" data-testid="analytics-key">
      Key: {#if provider?.keyMasked}<span class="mono">{provider.keyMasked}</span>{:else}not set: add <span class="mono">CAMPROXY_GOOGLE_VISION_KEY</span> to the environment and restart, or set one below{/if}
    </p>
    {#if notice}<p class="notice small" data-testid="analytics-key-notice">{notice}</p>{/if}
    <form class="row" onsubmit={(e) => { e.preventDefault(); void setKey(); }}>
      <label>Google Vision key <input type="password" autocomplete="off" spellcheck="false" bind:value={keyDraft} placeholder="AIza…" data-testid="analytics-key-input" /></label>
      <button type="submit" disabled={!keyOk} data-testid="analytics-key-set" aria-label="Set the Google Vision key">Set</button>
    </form>
    {#if keyDraft && !keyOk}<p class="hint small" data-testid="analytics-key-hint">20 to 200 characters, no spaces</p>{/if}
    <p class="muted small">A key set here replaces the configured one at once. It is kept in memory only, not saved: a restart restores the configured key (or none).</p>
    <div class="row"><label>Calls per month <input type="number" min="0" max="100000" step="1" value={monthly} oninput={(e) => (monthlyDraft = e.currentTarget.value)} data-testid="analytics-monthly" /></label>
      <button disabled={monthlyValue === null} data-testid="analytics-monthly-save" aria-label="Save calls per month" onclick={() => monthlyValue !== null && void put({ googleVision: { monthlyLimit: monthlyValue } }, 'Monthly limit', () => (monthlyDraft = undefined))}>Save</button></div>
    {#if monthlyValue === null}<p class="hint small" data-testid="analytics-monthly-hint">a whole number from 0 to 100,000</p>{/if}
    <div class="row"><label>At most per day (0 = no cap) <input type="number" min="0" max="10000" step="1" value={daily} oninput={(e) => (dailyDraft = e.currentTarget.value)} data-testid="analytics-daily" /></label>
      <button disabled={dailyValue === null} data-testid="analytics-daily-save" aria-label="Save the daily cap" onclick={() => dailyValue !== null && void put({ googleVision: { dailyCap: dailyValue } }, 'Daily cap', () => (dailyDraft = undefined))}>Save</button></div>
    {#if dailyValue === null}<p class="hint small" data-testid="analytics-daily-hint">a whole number from 0 to 10,000</p>{/if}
    <p class="small" data-testid="analytics-estimate">{estimateFor(monthly, Number(savedMonthly))}</p>
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
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  input[type='password'] { margin-left: 4px; width: 260px; max-width: 100%; padding: 4px 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; }
  .notice { margin: 0; padding: 6px 8px; border-radius: 6px; border: 1px solid #a855f7; background: var(--surface-2); }
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
