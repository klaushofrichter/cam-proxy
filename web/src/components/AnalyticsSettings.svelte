<script lang="ts">
  import { api, ApiError } from '../lib/api';
  import { refresh, status } from '../lib/state';
  import { estimateFor, keyNotice, parseLimit, validKey, type UiProviderState } from '../lib/analytics';
  import { lockedWhy, narrowWhy, rights, settingLockedWhy } from '../lib/rights';
  import LockedNote from './LockedNote.svelte';
  import HelpTip from './HelpTip.svelte';

  // The Analytics card (spec 2026-09-30-analytics-design): event kinds, and per
  // provider its switch, masked key, limits, estimate and the shared-key note.
  let { view, onsaved }: { view: Record<string, { value: unknown }>; onsaved: (v: Record<string, { value: unknown }>) => void } = $props();
  let message = $state('');
  // Issue #227: settings need ui.config for a cams-admin sign-in; the key is the local admin's.
  const locked = $derived(lockedWhy($rights, 'config'));
  const keyLocked = $derived(lockedWhy($rights, 'local'));
  // With ui.config, the caps only go down (Klaus, 2026-10-21); Google Vision on
  // and a higher monthly limit only within the ceiling set here (Vision
  // management, 2026-11-05), which stays the local admin's.
  const enabledLocked = $derived(settingLockedWhy($rights, 'analytics.googleVision.enabled'));
  const ceilingLocked = $derived(settingLockedWhy($rights, 'analytics.googleVision.remoteMaxMonthly'));
  const val = <T,>(p: string) => view[p]?.value as T;
  const savedCeiling = $derived(val<number>('analytics.googleVision.remoteMaxMonthly') ?? 0);
  const capWhy = (leaf: string, v: number | null) => (v === null ? null : narrowWhy($rights, `analytics.googleVision.${leaf}`, val<number>(`analytics.googleVision.${leaf}`), v, savedCeiling));
  // Switching on from a cams-admin sign-in needs a ceiling above 0.
  const enableWhy = $derived(narrowWhy($rights, 'analytics.googleVision.enabled', val<boolean>('analytics.googleVision.enabled'), true, savedCeiling));
  const provider = $derived((($status?.analytics ?? []) as UiProviderState[]).find((p) => p.id === 'google-vision') ?? null);
  // A draft stays undefined until the user types, so a reload of the settings
  // (Refresh, another save) never overwrites what is being typed; the field
  // shows the saved value meanwhile.
  const savedMonthly = $derived(String(val<number>('analytics.googleVision.monthlyLimit') ?? 0));
  const savedDaily = $derived(String(val<number>('analytics.googleVision.dailyCap') ?? 0));
  let monthlyDraft = $state<string | undefined>(undefined);
  let dailyDraft = $state<string | undefined>(undefined);
  const savedChecks = $derived(String(val<number>('analytics.googleVision.checksPerDay') ?? 10));
  let checksDraft = $state<string | undefined>(undefined);
  // Per camera and day (spec 2026-10-05-multi-camera-host-design §8.2); 0 = none.
  const savedPerCamera = $derived(String(val<number>('analytics.googleVision.perCameraDailyCap') ?? 0));
  let perCameraDraft = $state<string | undefined>(undefined);
  const perCamera = $derived(perCameraDraft ?? savedPerCamera);
  const perCameraValue = $derived(parseLimit(perCamera, 10000));
  const checks = $derived(checksDraft ?? savedChecks);
  const checksValue = $derived(parseLimit(checks, 1000));
  const monthly = $derived(monthlyDraft ?? savedMonthly);
  const daily = $derived(dailyDraft ?? savedDaily);
  const monthlyValue = $derived(parseLimit(monthly, 100000));
  const dailyValue = $derived(parseLimit(daily, 10000));
  const monthlyWhy = $derived(capWhy('monthlyLimit', monthlyValue));
  const dailyWhy = $derived(capWhy('dailyCap', dailyValue));
  const checksWhy = $derived(capWhy('checksPerDay', checksValue));
  const perCameraWhy = $derived(capWhy('perCameraDailyCap', perCameraValue));
  // cams-admin's ceiling (remoteMaxMonthly): local only.
  let ceilingDraft = $state<string | undefined>(undefined);
  const ceiling = $derived(ceilingDraft ?? String(savedCeiling));
  const ceilingValue = $derived(parseLimit(ceiling, 100000));
  const ceilingBelowLimit = $derived(savedCeiling < (val<number>('analytics.googleVision.monthlyLimit') ?? 0));

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
  let keyMessage = $state(''); // next to the field, not the card's shared line
  const keyOk = $derived(validKey(keyDraft));
  const notice = $derived(keyNotice(provider));
  async function setKey() {
    if (!keyOk) return;
    keyMessage = '';
    try {
      await api('PUT', '/control/secrets/google-vision-key', { key: keyDraft });
      keyDraft = '';
      keyMessage = 'Google Vision key set';
      await refresh();
    } catch (e) {
      keyMessage = e instanceof ApiError ? e.message : 'not set';
    }
  }
  // What each limit counts (src/analytics/service.ts limitReached, still checks
  // per camera): Google Vision calls with the current key, by camera-local day.
  const HELP = {
    monthly: 'All Google Vision calls in a calendar month, by every camera of this proxy together: automatic analyses and still checks. 0 = no calls at all.',
    daily: 'All Google Vision calls in one day, by every camera together: automatic analyses and still checks. 0 = no daily cap; the monthly limit still applies.',
    checks: 'Still checks each camera may have in a day: a moment picked by hand in cams (Timeline or Video page) and sent to Google Vision. The number is per camera, not for all cameras together, and the checks count toward the other limits. 0 = still checks off.',
    perCamera: 'All Google Vision calls one camera may make in a day: its automatic analyses and its still checks together. 0 = no per-camera cap.',
  } as const;
  const kinds = ['person', 'vehicle', 'pet'] as const;
  const noKinds = $derived(kinds.every((k) => !val<boolean>(`analytics.kinds.${k}`)));
</script>

<div class="card analytics" data-testid="analytics-settings">
  <h3>Analytics</h3>
  <LockedNote why={locked ?? keyLocked} testid="analytics-locked" />
  <p class="muted small">Sends the still of an event to an image-analysis service and keeps the objects it finds (a second opinion on the camera's label).</p>
  <fieldset>
    <legend>Analyse these events</legend>
    {#each kinds as k (k)}
      <label><input type="checkbox" data-testid={`analytics-kind-${k}`} checked={val<boolean>(`analytics.kinds.${k}`)} disabled={!!locked} onchange={(e) => toggle(e, (on) => ({ kinds: { [k]: on } }), `${k} events`)} /> {k}</label>
    {/each}
    <p class="muted small">Motion-only events are never analysed.{noKinds ? ' No kind is selected: nothing is analysed.' : ''}</p>
  </fieldset>

  <div class="provider" data-testid="analytics-provider-google-vision">
    <div class="row head">
    <h4>Google Vision</h4>
    <label class="switch">
      <!-- Disabled only once the status says there is no key (no flash while it loads). -->
      <input type="checkbox" data-testid="analytics-enabled" disabled={(provider !== null && !provider.keyMasked) || !!locked || !!enabledLocked || (!val<boolean>('analytics.googleVision.enabled') && !!enableWhy)} title={enabledLocked ?? enableWhy ?? undefined} aria-describedby="analytics-key-text" checked={val<boolean>('analytics.googleVision.enabled')}
        onchange={(e) => toggle(e, (on) => ({ googleVision: { enabled: on } }), 'Google Vision')} />
      enabled
    </label>
    </div>
    {#if !locked}<LockedNote why={enabledLocked} testid="analytics-enabled-locked" />{/if}
    {#if !locked && !enabledLocked && enableWhy && !val<boolean>('analytics.googleVision.enabled')}<p class="hint small" data-testid="analytics-enabled-dir">{enableWhy}</p>{/if}
    <form class="row key" onsubmit={(e) => { e.preventDefault(); void setKey(); }}>
      <span class="small" id="analytics-key-text" data-testid="analytics-key">
        Current key: {#if provider?.keyMasked}<span class="mono">{provider.keyMasked}</span>{:else}not set: add <span class="mono">CAMPROXY_GOOGLE_VISION_KEY</span> to the environment and restart, or set one here{/if}
      </span>
      <label>Custom Google Vision key <input type="password" autocomplete="off" spellcheck="false" bind:value={keyDraft} placeholder="AIza…" data-testid="analytics-key-input" /></label>
      <button type="submit" disabled={!keyOk || !!keyLocked} title={keyLocked ?? undefined} data-testid="analytics-key-set" aria-label="Set the Google Vision key">Set</button>
      {#if keyMessage}<span class="msg small" role="status" data-testid="analytics-key-message">{keyMessage}</span>{/if}
    </form>
    {#if notice}<p class="notice small" data-testid="analytics-key-notice">{notice}</p>{/if}
    {#if keyDraft && !keyOk}<p class="hint small" data-testid="analytics-key-hint">20 to 200 characters: letters, digits and symbols, no spaces</p>{/if}
    <p class="muted small">A key set here replaces the configured one at once. It is kept in memory only, not saved: a restart restores the configured key (or none).</p>
    <div class="row"><label>Calls per month <input type="number" min="0" max="100000" step="1" value={monthly} oninput={(e) => (monthlyDraft = e.currentTarget.value)} data-testid="analytics-monthly" /></label>
      <HelpTip label="calls per month" testid="analytics-monthly-help" text={HELP.monthly} />
      <button disabled={monthlyValue === null || !!locked || !!monthlyWhy} data-testid="analytics-monthly-save" aria-label="Save calls per month" onclick={() => monthlyValue !== null && void put({ googleVision: { monthlyLimit: monthlyValue } }, 'Monthly limit', () => (monthlyDraft = undefined))}>Save</button></div>
    {#if monthlyValue === null}<p class="hint small" data-testid="analytics-monthly-hint">a whole number from 0 to 100,000</p>{/if}
    {#if monthlyWhy}<p class="hint small" data-testid="analytics-monthly-dir">{monthlyWhy}</p>{/if}
    <div class="row"><label>At most per day (0 = no cap) <input type="number" min="0" max="10000" step="1" value={daily} oninput={(e) => (dailyDraft = e.currentTarget.value)} data-testid="analytics-daily" /></label>
      <HelpTip label="at most per day" testid="analytics-daily-help" text={HELP.daily} />
      <button disabled={dailyValue === null || !!locked || !!dailyWhy} data-testid="analytics-daily-save" aria-label="Save the daily cap" onclick={() => dailyValue !== null && void put({ googleVision: { dailyCap: dailyValue } }, 'Daily cap', () => (dailyDraft = undefined))}>Save</button></div>
    {#if dailyValue === null}<p class="hint small" data-testid="analytics-daily-hint">a whole number from 0 to 10,000</p>{/if}
    {#if dailyWhy}<p class="hint small" data-testid="analytics-daily-dir">{dailyWhy}</p>{/if}
    <!-- Still checks (cams #179): a second picked by hand in cams, within the limits above. -->
    <div class="row"><label>Still checks per day (0 = off) <input type="number" min="0" max="1000" step="1" value={checks} oninput={(e) => (checksDraft = e.currentTarget.value)} data-testid="analytics-checks" /></label>
      <HelpTip label="still checks per day" testid="analytics-checks-help" text={HELP.checks} />
      <button disabled={checksValue === null || !!locked || !!checksWhy} data-testid="analytics-checks-save" aria-label="Save still checks per day" onclick={() => checksValue !== null && void put({ googleVision: { checksPerDay: checksValue } }, 'Still checks per day', () => (checksDraft = undefined))}>Save</button></div>
    {#if checksValue === null}<p class="hint small" data-testid="analytics-checks-hint">a whole number from 0 to 1,000</p>{/if}
    {#if checksWhy}<p class="hint small" data-testid="analytics-checks-dir">{checksWhy}</p>{/if}
    <div class="row"><label>Per camera and day (0 = no cap) <input type="number" min="0" max="10000" step="1" value={perCamera} oninput={(e) => (perCameraDraft = e.currentTarget.value)} data-testid="analytics-per-camera" /></label>
      <HelpTip label="per camera and day" testid="analytics-per-camera-help" text={HELP.perCamera} />
      <button disabled={perCameraValue === null || !!locked || !!perCameraWhy} data-testid="analytics-per-camera-save" aria-label="Save the per-camera daily cap" onclick={() => perCameraValue !== null && void put({ googleVision: { perCameraDailyCap: perCameraValue } }, 'Per-camera cap', () => (perCameraDraft = undefined))}>Save</button></div>
    {#if perCameraValue === null}<p class="hint small" data-testid="analytics-per-camera-hint">a whole number from 0 to 10,000</p>{/if}
    {#if perCameraWhy}<p class="hint small" data-testid="analytics-per-camera-dir">{perCameraWhy}</p>{/if}
    <p class="muted small">Still checks are made by hand in cams, on any second; they count toward the limits above.</p>
    <!-- Vision management (cams-admin design 2026-11-05): the bound of cams-admin's changes; local only. -->
    <div class="row"><label>cams-admin may allow up to <input type="number" min="0" max="100000" step="1" value={ceiling} disabled={!!ceilingLocked} title={ceilingLocked ?? undefined} oninput={(e) => (ceilingDraft = e.currentTarget.value)} data-testid="analytics-remote-max" /> calls a month</label>
      <button disabled={ceilingValue === null || !!locked || !!ceilingLocked} data-testid="analytics-remote-max-save" aria-label="Save the most calls a month cams-admin may allow" onclick={() => ceilingValue !== null && void put({ googleVision: { remoteMaxMonthly: ceilingValue } }, 'cams-admin ceiling', () => (ceilingDraft = undefined))}>Save</button></div>
    {#if ceilingValue === null}<p class="hint small" data-testid="analytics-remote-max-hint">a whole number from 0 to 100,000</p>{/if}
    <p class="muted small" data-testid="analytics-remote-max-text">cams-admin may allow up to {savedCeiling.toLocaleString('en-US')} calls a month; 0 = cams-admin can't switch Vision on. It can always lower the limit or switch Vision off.</p>
    {#if ceilingBelowLimit}<p class="small" data-testid="analytics-remote-max-below">The monthly limit ({(val<number>('analytics.googleVision.monthlyLimit') ?? 0).toLocaleString('en-US')}) is above this ceiling and stays as it is: the ceiling only bounds cams-admin's next change.</p>{/if}
    <p class="small" data-testid="analytics-estimate">{estimateFor(monthly, Number(savedMonthly))}</p>
    <p class="muted small">The limits count this key's calls by every camera of this proxy; a new key starts a fresh count. Each proxy counts only its own calls. Proxies that share a key share its budget: keep the sum of their monthly limits within it.</p>
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
  .row.head { gap: 16px; }
  .row.head h4 { margin: 0; }
  .row.key { gap: 6px 16px; }
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
  .row .msg { margin: 0; }
</style>
