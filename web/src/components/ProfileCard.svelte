<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { refreshTick } from '../lib/state';
  import { lockedWhy, rights } from '../lib/rights';
  import { draftOf, ignoredNotes, profileBody, profileProblem, profileRows, showOnHome, warningText, type ProfileDraft, type ProfileView } from '../lib/profile';
  import LockedNote from './LockedNote.svelte';

  // The proxy profile (cams-admin spec 2026-10-25-proxy-profile-design §0).
  // `home`: the Status page, shown only until the profile is set (or while it
  // warns); otherwise the Settings page's card. Set with the local admin token only.
  let { home = false }: { home?: boolean } = $props();
  let view = $state<ProfileView | null>(null);
  let draft = $state<ProfileDraft | null>(null);
  let message = $state('');
  let copied = $state(false);
  const locked = $derived(lockedWhy($rights, 'local'));
  const problem = $derived(draft && view ? profileProblem(draft, view.ftp.enabled) : null);

  const load = () =>
    void api<ProfileView>('GET', '/control/profile')
      .then((v) => {
        view = v;
        // A draft being typed is kept across refreshes.
        draft ??= draftOf(v);
      })
      .catch(() => undefined);
  onMount(load);
  $effect(() => {
    if ($refreshTick) load();
  });

  async function save() {
    if (!draft || problem) return;
    message = '';
    try {
      view = await api<ProfileView>('PUT', '/control/profile', profileBody(draft));
      draft = draftOf(view);
      message = 'Profile saved';
    } catch (e) {
      message = e instanceof ApiError ? e.message : 'not saved';
    }
  }
  async function copy() {
    if (!view) return;
    try {
      await navigator.clipboard.writeText(view.firewall.lines.join('\n'));
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      message = 'Copy failed: select the lines and copy them';
    }
  }
</script>

{#if view && draft && (!home || showOnHome(view))}
  <div class="card" class:wide={home} data-testid={home ? 'card-profile-home' : 'settings-card-profile'}>
    <h3>{home && !view.set ? "Set this proxy's profile" : `Profile${view.name ? ` · ${view.name}` : ''}`}</h3>
    {#if !view.set}<p class="muted small" data-testid="profile-unset">How many cameras this proxy can hold, and how much storage it may use. Until it is set, it takes no camera from a move beyond the cameras it holds. Nothing checks the values against the hardware: that is your call.</p>{/if}
    {#each view.warnings as w (w)}<p class="warn small" role="alert" data-testid="profile-warning" data-kind={w}>{warningText(w, view)}</p>{/each}
    {#each ignoredNotes(view) as n (n)}<p class="muted small" data-testid="profile-ignored">{n}</p>{/each}
    <dl>
      {#each profileRows(view) as r (r.key)}<dt>{r.label}</dt><dd data-testid="profile-row-{r.key}">{r.text}</dd>{/each}
    </dl>
    <form class="grid" onsubmit={(e) => { e.preventDefault(); void save(); }}>
      <label>Name <input bind:value={draft.name} placeholder="e.g. mini PC (N100, 1 TB)" maxlength="60" autocomplete="off" disabled={!!locked} data-testid="profile-name" /></label>
      <label>Cameras <input bind:value={draft.cameras} inputmode="numeric" autocomplete="off" disabled={!!locked} data-testid="profile-cameras" /></label>
      <label>Storage, GB <input bind:value={draft.storageGB} inputmode="numeric" placeholder="(storage.* budget)" autocomplete="off" disabled={!!locked} data-testid="profile-storage" /></label>
      <label>Firewall
        <select bind:value={draft.firewall} disabled={!!locked} data-testid="profile-firewall"><option value="ufw">ufw</option><option value="nft">nft</option></select>
      </label>
      <div class="row"><button type="submit" disabled={!!locked || !!problem} title={locked ?? problem ?? undefined} data-testid="profile-save">{view.set ? 'Save' : 'Set profile'}</button></div>
    </form>
    <LockedNote why={locked} testid="profile-locked" />
    {#if problem}<p class="field-error" data-testid="profile-problem">{problem}</p>{/if}
    {#if message}<p class="msg" role="status" data-testid="profile-message">{message}</p>{/if}
    {#if view.firewall.lines.length}
      <div class="fw">
        <div class="fw-head"><span class="muted small">Firewall lines for the cameras with FTP ({view.firewall.tool}; run them on the host, nothing here runs them)</span><button type="button" onclick={() => void copy()} data-testid="profile-copy">{copied ? 'Copied' : 'Copy'}</button></div>
        <pre data-testid="profile-firewall-lines">{view.firewall.lines.join('\n')}</pre>
      </div>
    {/if}
  </div>
{/if}

<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; min-width: 0; }
  .wide { grid-column: 1 / -1; }
  h3 { margin: 0 0 6px; font-size: 16px; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 8px 0; font-size: 14px; }
  dt { color: var(--muted); } dd { margin: 0; font-family: var(--mono); overflow-wrap: anywhere; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; align-items: end; }
  label { display: grid; gap: 4px; font-size: 13px; }
  input, select { padding: 4px 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; }
  button { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); }
  button:hover { border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .muted { color: var(--muted); margin: 0 0 8px; }
  .small { font-size: 13px; }
  .warn { color: #f59e0b; margin: 0 0 8px; }
  .msg { margin: 8px 0 0; color: var(--accent); }
  .field-error { margin: 8px 0 0; font-size: 12px; color: #ef4444; }
  .fw { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
  .fw-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
  pre { margin: 8px 0 0; padding: 8px; font-size: 12px; background: var(--surface-2); border-radius: 6px; overflow-x: auto; white-space: pre; }
</style>
