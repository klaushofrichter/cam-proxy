<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import { agoText } from '../lib/format';
  import { allowedText, commandsStateText, lastCommandText, sinceOf, stateClass, stateText, summaryWarnings, tokensCountText, type CamsAdminView, type CommandsView, type TokensView } from '../lib/cams-admin';
  import { hostOf } from '../lib/long-value';
  import Icon from './Icon.svelte';

  // The Status page's short cams-admin card (#203): the connection, the
  // commands and the managed tokens in a few lines; everything else, and every
  // action, is on the cams-admin page.
  let view = $state<CamsAdminView | null>(null);
  let cmds = $state<CommandsView | null>(null);
  let tokens = $state<TokensView | null>(null);
  let now = $state(Date.now());

  const load = async () => {
    try {
      view = await api<CamsAdminView>('GET', '/control/admin');
      cmds = await api<CommandsView>('GET', '/control/admin/commands');
      tokens = await api<TokensView>('GET', '/control/admin/tokens');
    } catch {
      // the next tick tries again
    }
    now = Date.now();
  };
  onMount(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  });
  const since = $derived(view ? sinceOf(view) : null);
  const warnings = $derived(view ? summaryWarnings(view, cmds, tokens) : []);
  const parts = (s: string) => s.split(' · ');
</script>

<div class="card" data-testid="card-cams-admin">
  <div class="head">
    <h3>cams-admin</h3>
    <a href="#/cams-admin" class="details" data-testid="cams-admin-details-link">Details →</a>
  </div>
  {#if view}
    <dl>
      <dt>State</dt>
      <dd><span class={stateClass(view.state)} data-testid="summary-cams-admin-state">{stateText(view.state)}</span>{#if since}{" "}<span class="muted nw" data-testid="summary-cams-admin-since">· {view.state === 'connected' ? `for ${agoText(since, now).replace(' ago', '')}` : agoText(since, now)}</span>{/if}</dd>
      {#if view.url}<dt>Host</dt><dd><span class="ell" title={view.url} data-testid="summary-cams-admin-host">{hostOf(view.url)}</span></dd>{/if}
      {#if view.account}<dt>Account</dt><dd><span class="ell" data-testid="summary-cams-admin-account">{view.account}</span></dd>{/if}
      {#if cmds}
        <dt>Commands</dt><dd class={cmds.enabled && !cmds.paused ? '' : 'bad'} data-testid="summary-cams-admin-commands">{commandsStateText(cmds)}</dd>
        <dt>Allowed</dt><dd data-testid="summary-cams-admin-allowed">{allowedText(cmds)}</dd>
        <dt>Last command</dt><dd data-testid="summary-cams-admin-last">{#each parts(lastCommandText(cmds.recent ?? [], now)) as p, i (i)}{#if i}{' · '}{/if}<span class="nw">{p}</span>{/each}</dd>
      {/if}
      {#if tokens}<dt>Managed tokens</dt><dd data-testid="summary-cams-admin-tokens">{tokensCountText(tokens, now)}</dd>{/if}
    </dl>
    {#each warnings as w (w)}<p class="warn" data-testid="summary-cams-admin-warning"><Icon name="alert" size={14} /><span>{w}</span></p>{/each}
  {:else}
    <p class="muted">Loading…</p>
  {/if}
</div>

<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; gap: 8px; align-content: start; min-width: 0; }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  h3 { margin: 0; font-size: 16px; }
  .details { font-size: 13px; color: var(--accent); text-decoration: none; white-space: nowrap; }
  .details:hover { text-decoration: underline; }
  p { margin: 0; }
  dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; margin: 0; font-size: 14px; align-items: baseline; }
  dt { color: var(--muted); white-space: nowrap; }
  dd { margin: 0; font-family: var(--mono); text-align: right; min-width: 0; }
  .ell { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
  .nw { white-space: nowrap; }
  .muted { color: var(--muted); }
  .ok { color: #22c55e; }
  .bad { color: var(--danger); }
  .warn { display: flex; gap: 6px; align-items: flex-start; color: #f59e0b; font-size: 13px; }
  .warn :global(svg) { flex: none; margin-top: 2px; }
</style>
