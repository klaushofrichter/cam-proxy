<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { lockedWhy, rights } from '../lib/rights';
  import { poeOnLabel, poeOnText, switchLine, type SwitchView } from '../lib/switches';
  import LockedNote from './LockedNote.svelte';

  // The PoE switches this proxy operates (spec 2026-11-07-poe-switches-design):
  // cams-admin owns the switch records; the password lives here, write-only.
  // "Turn PoE on" is the recovery for a port the proxy may have left off.
  const locked = $derived(lockedWhy($rights, 'local'));
  let switches = $state<SwitchView[]>([]);
  let message = $state('');
  let editing = $state<string | null>(null);
  let password = $state('');
  let busy = $state(false);

  async function load() {
    try {
      switches = (await api<{ switches: SwitchView[] }>('GET', '/control/switches')).switches;
    } catch {
      switches = [];
    }
  }
  onMount(() => void load());

  async function save(id: string) {
    busy = true;
    try {
      await api('PUT', `/control/switches/${encodeURIComponent(id)}/password`, { password });
      message = 'Password saved.';
      editing = null;
    } catch (e) {
      message = e instanceof ApiError ? e.message : 'not saved';
    }
    password = '';
    busy = false;
    void load();
  }

  async function on(id: string, port: number) {
    busy = true;
    try {
      const r = await api<{ wasOn: boolean }>('POST', `/control/switches/${encodeURIComponent(id)}/ports/${port}/poe-on`);
      message = poeOnText(port, r.wasOn);
    } catch (e) {
      message = e instanceof ApiError ? e.message : 'PoE not turned on';
    }
    busy = false;
    void load();
  }
</script>

{#if switches.length}
  <div class="card" data-testid="poe-switches">
    <h3>PoE switches</h3>
    <p class="small">The switches this proxy operates. Their passwords are kept here and never shown.</p>
    {#each switches as s (s.id)}
      <div class="sw" data-testid="poe-switch-{s.id}">
        <p class="line">{switchLine(s)}</p>
        {#if editing === s.id}
          <form onsubmit={(e) => { e.preventDefault(); void save(s.id); }}>
            <input type="password" autocomplete="off" bind:value={password} aria-label="Switch password" data-testid="switch-password-input" />
            <button type="submit" disabled={busy || !password} data-testid="switch-password-save">Save</button>
            <button type="button" onclick={() => { editing = null; password = ''; }}>Cancel</button>
          </form>
        {:else}
          <div><button onclick={() => (editing = s.id)} disabled={!!locked} data-testid="switch-password-set">{s.passwordSet ? 'Change password' : 'Set password'}</button></div>
        {/if}
        {#each s.poeMaybeOff as port (port)}
          <div><button onclick={() => void on(s.id, port)} disabled={busy || s.busy || !s.passwordSet || !!locked} data-testid="switch-poe-on-{port}">{poeOnLabel(port)}</button> <span class="small">PoE may be off on this port.</span></div>
        {/each}
      </div>
    {/each}
    <LockedNote why={locked} testid="poe-switches-locked" />
    {#if message}<p class="msg" role="status" data-testid="poe-switches-message">{message}</p>{/if}
  </div>
{/if}

<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; gap: 8px; }
  h3 { margin: 0; font-size: 16px; }
  p { margin: 0; }
  .sw { display: grid; gap: 6px; padding-top: 6px; border-top: 1px solid var(--border); }
  .line { font-weight: 600; }
  .small { font-size: 13px; color: var(--muted); }
  .msg { color: var(--accent); }
  input { padding: 5px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); }
  button { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); }
  button:hover { border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
