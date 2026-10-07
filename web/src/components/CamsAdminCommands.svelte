<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import { agoText } from '../lib/format';
  import { commandsBanner, tokenStateText, widenErrorText, type CommandsView, type TokensView } from '../lib/cams-admin';

  // Commands from cams-admin and the managed tokens (migration P2,
  // docs/cams-admin.md): off unless allowed here. Any admin can narrow
  // (untick, pause, block); adding a command, resuming and unblocking need
  // the proxy's own admin token (a session signed in with it).
  let cmds = $state<CommandsView | null>(null);
  let tokens = $state<TokensView | null>(null);
  let chosen = $state<string[]>([]);
  let dirty = $state(false);
  let reason = $state('');
  let busy = $state(false);
  let message = $state('');
  let now = $state(Date.now());

  const load = async () => {
    try {
      cmds = await api<CommandsView>('GET', '/control/admin/commands');
      if (!dirty) chosen = [...cmds.allow];
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

  const toggle = (entry: string, on: boolean) => {
    chosen = on ? [...new Set([...chosen, entry])] : chosen.filter((e) => e !== entry);
    dirty = true;
  };
  async function act(fn: () => Promise<void>, ok: string, fallback: string) {
    busy = true;
    message = '';
    try {
      await fn();
      message = ok;
    } catch (e) {
      message = widenErrorText(e, fallback);
    } finally {
      busy = false;
      await load();
    }
  }
  const save = () => act(async () => { cmds = await api<CommandsView>('PUT', '/control/admin/commands', { allow: chosen }); dirty = false; }, 'Saved', 'Not saved');
  const pause = () => act(async () => { cmds = await api<CommandsView>('POST', '/control/admin/commands/pause', { reason: reason.trim() }); reason = ''; }, 'Commands paused', 'Not paused');
  const resume = () => act(async () => { cmds = await api<CommandsView>('POST', '/control/admin/commands/resume'); }, 'Commands resumed', "Resuming needs the proxy's own admin token");
  const block = (id: string) => act(async () => { tokens = await api<TokensView>('POST', `/control/admin/tokens/${id}/block`); }, `${id} blocked`, 'Not blocked');
  const unblock = (id: string) => act(async () => { tokens = await api<TokensView>('POST', `/control/admin/tokens/${id}/unblock`); }, `${id} unblocked: cams-admin's next token update brings it back`, "Unblocking needs the proxy's own admin token");
  const banner = $derived(cmds ? commandsBanner(cmds) : null);
</script>

{#if cmds}
  <section class="sub" data-testid="cams-admin-commands">
    <h4>Commands from cams-admin</h4>
    {#if banner}<p class="banner" data-testid="cams-admin-commands-banner">{banner}</p>{/if}
    <p class="small">cams-admin can only send what is ticked here; everything else is refused. Adding a command needs the proxy's own admin token.</p>
    <ul class="entries">
      {#each cmds.known ?? [] as k (k.entry)}
        {@const implemented = (cmds.implemented ?? []).includes(k.entry)}
        <li class:later={!implemented}>
          <label>
            <input type="checkbox" checked={chosen.includes(k.entry)} disabled={busy || !implemented} onchange={(e) => toggle(k.entry, (e.currentTarget as HTMLInputElement).checked)} data-testid="cams-admin-allow-{k.entry}" />
            <span class="mono">{k.entry}</span>
          </label>
          <span class="small">{k.text}</span>
        </li>
      {/each}
    </ul>
    <div class="actions">
      <button onclick={() => void save()} disabled={busy || !dirty} data-testid="cams-admin-commands-save">Save</button>
      {#if cmds.paused}
        <button onclick={() => void resume()} disabled={busy || !cmds.enabled} data-testid="cams-admin-resume">Resume</button>
      {:else}
        <input type="text" bind:value={reason} maxlength="200" placeholder="reason (optional)" data-testid="cams-admin-pause-reason" />
        <button onclick={() => void pause()} disabled={busy} data-testid="cams-admin-pause">Pause</button>
      {/if}
    </div>
    {#if message}<p class="msg" data-testid="cams-admin-commands-message">{message}</p>{/if}
  </section>

  <section class="sub" data-testid="cams-admin-recent">
    <h4>Recent commands</h4>
    {#if (cmds.recent ?? []).length}
      <table>
        <tbody>
          {#each cmds.recent ?? [] as c (c.cmdId)}
            <tr><td>{agoText(c.at, now)}</td><td class="wrap">{c.actor}</td><td class="mono">{c.command}</td><td class={c.status === 'ok' ? 'ok' : 'bad'}>{c.status}{c.code ? ` (${c.code})` : ''}</td></tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <p class="small">No commands yet.</p>
    {/if}
    <a href="#/audit" class="small">Audit log (filter: admin-command)</a>
  </section>

  {#if tokens}
    <section class="sub" data-testid="cams-admin-tokens">
      <h4>Managed tokens</h4>
      {#if tokens.problem}<p class="bad wrap">{tokens.problem}</p>{/if}
      {#if tokens.items.length}
        <table>
          <tbody>
            {#each tokens.items as t (t.id)}
              <tr>
                <td class="mono wrap">{t.id}</td><td>{t.kind}</td><td class="wrap">{t.label}</td>
                <td class={t.blocked ? 'bad' : ''}>{tokenStateText(t, now)}</td><td class="mono">{t.hashPrefix}…</td>
                <td>
                  {#if t.blocked}
                    <button onclick={() => void unblock(t.id)} disabled={busy} data-testid="cams-admin-token-unblock-{t.id}">Unblock</button>
                  {:else}
                    <button onclick={() => void block(t.id)} disabled={busy} data-testid="cams-admin-token-block-{t.id}">Block</button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="small">No managed tokens (revision {tokens.revision}). CAMPROXY_TOKENS works as before.</p>
      {/if}
    </section>
  {/if}
{/if}

<style>
  .sub { display: grid; gap: 6px; border-top: 1px solid var(--border); padding-top: 8px; }
  h4 { margin: 0; font-size: 14px; }
  p { margin: 0; }
  .banner { color: var(--danger); font-weight: 600; }
  .entries { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .entries li { display: grid; gap: 2px; }
  .entries li.later { opacity: 0.6; }
  label { display: flex; gap: 6px; align-items: center; font-size: 13px; }
  .mono { font-family: var(--mono); }
  .wrap { white-space: normal; overflow-wrap: anywhere; }
  .small { font-size: 13px; color: var(--muted); }
  .msg { color: var(--accent); }
  .ok { color: #22c55e; }
  .bad { color: var(--danger); }
  .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 2px 4px; vertical-align: top; }
  input[type='text'] { padding: 5px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); min-width: 0; }
  button { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
