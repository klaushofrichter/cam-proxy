<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import { agoText } from '../lib/format';
  import { actorLabel, changeLines, commandsBanner, entryGroups, unconfirmedText, tokenStateText, undoErrorText, widenErrorText, type ChangeItem, type CommandsView, type TokensView } from '../lib/cams-admin';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import LongValue from './LongValue.svelte';

  // Commands from cams-admin and the managed tokens (migration P2,
  // docs/cams-admin.md), on the cams-admin page (#203): off unless allowed
  // here. Any admin can narrow (untick, pause, block); adding a command,
  // resuming and unblocking need the proxy's own admin token (a session
  // signed in with it). Lists are rows that stack on narrow screens.
  let cmds = $state<CommandsView | null>(null);
  let tokens = $state<TokensView | null>(null);
  // cams-admin's settings changes (migration P3), each with Undo.
  let changes = $state<ChangeItem[]>([]);
  let undoing = $state<ChangeItem | null>(null);
  let chosen = $state<string[]>([]);
  let dirty = $state(false);
  let reason = $state('');
  let busy = $state(false);
  let message = $state('');
  let now = $state(Date.now());
  // Actors shown in full after a tap (the short form hides the middle of an id).
  let opened = $state<Record<string, boolean>>({});

  const load = async () => {
    try {
      cmds = await api<CommandsView>('GET', '/control/admin/commands');
      if (!dirty) chosen = [...cmds.allow];
      tokens = await api<TokensView>('GET', '/control/admin/tokens');
      changes = (await api<{ items: ChangeItem[] }>('GET', '/control/admin/changes')).items;
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
  async function undo(c: ChangeItem) {
    undoing = null;
    busy = true;
    message = '';
    try {
      await api('POST', `/control/admin/changes/${c.cmdId}/undo`);
      message = `Undone: ${c.paths.map((p) => p.path).join(', ')}`;
    } catch (e) {
      message = undoErrorText(e);
    } finally {
      busy = false;
      await load();
    }
  }
  const banner = $derived(cmds ? commandsBanner(cmds) : null);
  const groups = $derived(cmds ? entryGroups({ known: cmds.known, groups: cmds.groups, allow: chosen, unconfirmed: cmds.unconfirmed }) : []);
</script>

{#snippet actor(key: string, who: string)}
  {@const a = actorLabel(who)}
  {#if a.text === a.full}
    <span class="actor ell" title={a.full}>{a.text}</span>
  {:else}
    <button type="button" class="actor linkish" class:open={opened[key]} title={a.full} aria-expanded={!!opened[key]} aria-label="{opened[key] ? 'Shorten' : 'Show in full'}: {a.full}" onclick={() => (opened = { ...opened, [key]: !opened[key] })}>{opened[key] ? a.full : a.text}</button>
  {/if}
{/snippet}

{#if cmds}
  <div class="card" data-testid="cams-admin-commands">
    <h3>Allowed commands</h3>
    {#if banner}<p class="banner" data-testid="cams-admin-commands-banner">{banner}</p>{/if}
    <p class="small">Commands from cams-admin: it can only send what is ticked here; everything else is refused. Adding a command needs the proxy's own admin token.</p>
    {#each groups as g (g.key)}
      <div class="group" class:disruptive={g.key === 'disruptive'} data-testid="cams-admin-group-{g.key}">
        <h4>{g.title}</h4>
        {#if g.warning}<p class="danger small">{g.warning}</p>{/if}
        <ul class="entries">
          {#each g.entries as k (k.entry)}
            {@const implemented = (cmds.implemented ?? []).includes(k.entry)}
            <li class:later={!implemented}>
              <label>
                <input type="checkbox" checked={k.allowed} disabled={busy || !implemented} onchange={(e) => toggle(k.entry, (e.currentTarget as HTMLInputElement).checked)} data-testid="cams-admin-allow-{k.entry}" />
                <span class="mono entry">{k.entry}</span>
              </label>
              <span class="explain">{k.text}</span>
              {#if k.unconfirmed}<span class="danger explain" data-testid="cams-admin-unconfirmed-{k.entry}">{unconfirmedText}</span>{/if}
            </li>
          {/each}
        </ul>
      </div>
    {/each}
    <div class="actions">
      <button onclick={() => void save()} disabled={busy || !dirty} data-testid="cams-admin-commands-save">Save</button>
      {#if cmds.paused}
        <button onclick={() => void resume()} disabled={busy || !cmds.enabled} data-testid="cams-admin-resume">Resume</button>
      {:else}
        <span class="pause">
          <input type="text" bind:value={reason} maxlength="200" placeholder="reason (optional)" data-testid="cams-admin-pause-reason" />
          <button onclick={() => void pause()} disabled={busy} data-testid="cams-admin-pause">Pause</button>
        </span>
      {/if}
    </div>
  </div>

  <div class="card list" data-testid="cams-admin-recent">
    <h3>Recent commands</h3>
    {#if (cmds.recent ?? []).length}
      <ul class="rows recent">
        <li class="hdr" aria-hidden="true"><span>When</span><span>Command</span><span>Result</span><span>On behalf of</span></li>
        {#each cmds.recent ?? [] as c (c.cmdId)}
          <li class="row" data-testid="cams-admin-recent-row">
            <span class="time nw">{agoText(c.at, now)}</span>
            <span class="cmd mono ell" title={c.command}>{c.command}</span>
            <span class="res nw {c.status === 'ok' ? 'ok' : 'bad'}">{c.status}{c.code ? ` (${c.code})` : ''}</span>
            <span class="who">{@render actor(`r-${c.cmdId}`, c.actor)}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="small">No commands yet.</p>
    {/if}
    <a href="#/audit" class="small">Audit log (filter: admin-command)</a>
  </div>

  <div class="card list" data-testid="cams-admin-changes">
    <h3>Changes by cams-admin</h3>
    {#if changes.length}
      <ul class="rows changes">
        {#each changes as c (c.cmdId)}
          <li class="row" data-testid="cams-admin-change-{c.cmdId}">
            <span class="meta"><span class="nw">{agoText(c.at, now)}</span> · {@render actor(`c-${c.cmdId}`, c.actor)}</span>
            <span class="lines">{#each changeLines(c) as line (line)}<span class="mono line">{line}</span>{/each}</span>
            <span class="act">
              {#if c.rolledBack}
                <span class="small nw">undone{c.rolledBack.by === 'local' ? ' here' : ' by cams-admin'}</span>
              {:else if c.command !== 'config.rollback'}
                <button onclick={() => (undoing = c)} disabled={busy} data-testid="cams-admin-undo-{c.cmdId}">Undo</button>
              {/if}
            </span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="small">None. The Settings page marks a setting cams-admin set.</p>
    {/if}
  </div>

  {#if tokens}
    <div class="card list" data-testid="cams-admin-tokens">
      <h3>Managed tokens</h3>
      {#if tokens.problem}<p class="bad">{tokens.problem}</p>{/if}
      {#if tokens.items.length}
        <ul class="rows tokens">
          {#each tokens.items as t (t.id)}
            <li class="row" data-testid="cams-admin-token-{t.id}">
              <span class="label ell" title={t.label}>{t.label}</span>
              <span class="kind nw muted">{t.kind}</span>
              <span class="state nw" class:bad={t.blocked}>{tokenStateText(t, now)}</span>
              <span class="ids">
                <LongValue value={t.id} kind="id" copy label="the token id" testid="cams-admin-token-id-{t.id}" />
                <LongValue value={`${t.hashPrefix}…`} kind="text" />
              </span>
              <span class="act">
                {#if t.blocked}
                  <button onclick={() => void unblock(t.id)} disabled={busy} data-testid="cams-admin-token-unblock-{t.id}">Unblock</button>
                {:else}
                  <button onclick={() => void block(t.id)} disabled={busy} data-testid="cams-admin-token-block-{t.id}">Block</button>
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="small">No managed tokens (revision {tokens.revision}). CAMPROXY_TOKENS works as before.</p>
      {/if}
    </div>
  {/if}
  {#if message}<p class="msg toast" data-testid="cams-admin-commands-message" role="status">{message}</p>{/if}
{/if}

{#if undoing}
  <ConfirmDialog title="Undo cams-admin's change" message="These settings go back to what they were before cams-admin changed them (a setting changed here since is left alone, and nothing is undone then):" items={changeLines(undoing)} confirmLabel="Undo" oncancel={() => (undoing = null)} onconfirm={() => void undo(undoing!)} />
{/if}

<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; gap: 8px; align-content: start; min-width: 0; }
  .list { container-type: inline-size; }
  h3 { margin: 0; font-size: 16px; }
  h4 { margin: 4px 0 0; font-size: 14px; }
  p { margin: 0; }
  .group { display: grid; gap: 6px; min-width: 0; }
  .group.disruptive { border: 1px solid var(--danger); border-radius: 8px; padding: 8px 10px; }
  .danger { color: var(--danger); }
  .banner { color: var(--danger); font-weight: 600; }
  /* Several entries side by side where there is room; each explanation under its tick. */
  .entries { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 8px 20px; }
  .entries li { display: grid; gap: 2px; align-content: start; min-width: 0; }
  .entries li.later { opacity: 0.6; }
  label { display: flex; gap: 8px; align-items: center; font-size: 14px; min-width: 0; }
  .entry { overflow-wrap: anywhere; }
  .explain { font-size: 12.5px; color: var(--muted); padding-left: 26px; line-height: 1.35; }
  .explain.danger { color: var(--danger); }
  .mono { font-family: var(--mono); }
  .nw { white-space: nowrap; }
  .ell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .small { font-size: 13px; color: var(--muted); }
  .muted { color: var(--muted); }
  .msg { color: var(--accent); }
  /* The last action's result stays in view at the bottom while the page scrolls. */
  .toast { position: sticky; bottom: 8px; background: var(--surface-2); border: 1px solid var(--accent); border-radius: 8px; padding: 8px 12px; box-shadow: var(--shadow); }
  .ok { color: #22c55e; }
  .bad { color: var(--danger); }
  .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .pause { display: flex; gap: 8px; align-items: center; flex: 1 1 220px; min-width: 0; max-width: 420px; }
  .pause input { flex: 1; }
  input[type='text'] { padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); min-width: 0; }
  button { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); white-space: nowrap; }
  button:hover { border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: default; }
  .linkish { padding: 0; border: 0; background: none; font: inherit; color: inherit; cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; overflow: hidden; text-overflow: ellipsis; text-align: left; }
  .linkish.open { white-space: normal; overflow-wrap: anywhere; }
  .actor { font-family: var(--mono); font-size: 12.5px; color: var(--muted); display: inline-block; max-width: 100%; vertical-align: bottom; }

  /* Rows: stacked on narrow cards, a table where there is room. */
  .rows { list-style: none; margin: 0; padding: 0; display: grid; font-size: 13.5px; }
  .row { display: grid; gap: 2px 10px; padding: 8px 0; border-top: 1px solid var(--border); align-items: baseline; min-width: 0; }
  .row > * { min-width: 0; }
  .hdr { display: none; }

  /* Recent commands: time · command · result on one line, the actor below. */
  .recent .row { grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: 'time cmd res' 'who who who'; }
  .recent .time { grid-area: time; color: var(--muted); }
  .recent .cmd { grid-area: cmd; }
  .recent .res { grid-area: res; text-align: right; }
  .recent .who { grid-area: who; }

  /* Changes: when and who, the changed settings, Undo. */
  .changes .row { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'meta act' 'lines lines'; }
  .changes .meta { grid-area: meta; color: var(--muted); }
  .changes .lines { grid-area: lines; display: grid; gap: 2px; }
  .changes .line { overflow-wrap: anywhere; }
  .changes .act { grid-area: act; justify-self: end; }

  /* Tokens: label and kind, the state below, the id and the hash under that; Block at the side. */
  .tokens .row { grid-template-columns: minmax(0, 1fr) auto auto; grid-template-areas: 'label kind act' 'state state act' 'ids ids ids'; }
  .tokens .label { grid-area: label; font-weight: 600; }
  .tokens .kind { grid-area: kind; }
  .tokens .state { grid-area: state; }
  .tokens .ids { grid-area: ids; display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12.5px; color: var(--muted); min-width: 0; }
  .tokens .act { grid-area: act; align-self: center; }

  @container (min-width: 640px) {
    .hdr { display: grid; color: var(--muted); font-size: 12px; padding: 0 0 4px; }
    .recent .row, .recent .hdr { grid-template-columns: 6.5rem minmax(0, 1fr) 9rem minmax(0, 1.2fr); grid-template-areas: 'time cmd res who'; gap: 2px 16px; }
    .recent .res { text-align: left; }
    .changes .row { grid-template-columns: minmax(0, 16rem) minmax(0, 1fr) auto; grid-template-areas: 'meta lines act'; gap: 2px 16px; }
    .tokens .row { grid-template-columns: minmax(0, 1fr) 4rem 8rem minmax(0, 1.4fr) auto; grid-template-areas: 'label kind state ids act'; gap: 2px 16px; }
  }
</style>
