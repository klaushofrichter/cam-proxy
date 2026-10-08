<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { agoText } from '../lib/format';
  import { canEnroll, sinceOf, stateClass, stateText, type CamsAdminView } from '../lib/cams-admin';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import CamsAdminCommands from '../components/CamsAdminCommands.svelte';
  import LongValue from '../components/LongValue.svelte';

  // The cams-admin page (#203; spec 2026-10-06-cams-admin-phase1-design
  // §9.2): the connection's state, what this proxy is enrolled as, and Enroll /
  // Reconnect / Unenroll; then the allowed commands, recent commands, changes
  // and managed tokens. The code field is a password field and is cleared
  // after every try; the code is never shown or stored.
  let view = $state<CamsAdminView | null>(null);
  let url = $state('');
  let code = $state('');
  let busy = $state(false);
  let message = $state('');
  let asking = $state(false);
  let now = $state(Date.now());

  const load = async () => {
    try {
      view = await api<CamsAdminView>('GET', '/control/admin');
      if (!url && view.url) url = view.url;
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
  const errText = (e: unknown, fallback: string) => (e instanceof ApiError && typeof e.body === 'object' && e.body && 'message' in e.body ? String((e.body as { message: unknown }).message) : fallback);

  async function enroll(ev: Event) {
    ev.preventDefault();
    busy = true;
    message = '';
    try {
      view = await api<CamsAdminView>('POST', '/control/admin/enroll', { url: url.trim(), code });
      message = `Enrolled as ${view.proxyId} (account ${view.account})`;
    } catch (e) {
      message = errText(e, 'Enrollment failed');
    } finally {
      code = '';
      busy = false;
    }
  }
  async function reconnect() {
    busy = true;
    message = '';
    try {
      view = await api<CamsAdminView>('POST', '/control/admin/reconnect');
      message = 'Reconnecting';
    } catch (e) {
      message = errText(e, 'Not reconnected');
    } finally {
      busy = false;
    }
  }
  async function unenroll() {
    asking = false;
    busy = true;
    message = '';
    try {
      view = await api<CamsAdminView>('POST', '/control/admin/unenroll');
      message = 'Unenrolled: the key file is deleted';
    } catch (e) {
      message = errText(e, 'Not unenrolled');
    } finally {
      busy = false;
    }
  }
  const active = $derived(!!view && ['connecting', 'connected', 'backoff', 'rejected', 'incompatible'].includes(view.state));
</script>

<section class="page" data-testid="page-cams-admin">
<div class="title"><h2>Cams-Admin</h2><a href="#/status" class="back">← Status</a></div>
<div class="card" data-testid="cams-admin-connection">
  <h3>Connection</h3>
  {#if view}
    <dl>
      <dt>State</dt><dd><span class={stateClass(view.state)} data-testid="cams-admin-state">{stateText(view.state)}</span>{#if sinceOf(view)}{" "}<span class="muted nw" data-testid="cams-admin-since">· {view.state === 'connected' ? 'since ' : ''}{agoText(sinceOf(view), now)}</span>{/if}</dd>
      {#if view.url}<dt>URL</dt><dd><LongValue value={view.url} kind="text" copy link label="the cams-admin URL" testid="cams-admin-url" /></dd>{/if}
      {#if view.account}<dt>Account</dt><dd><LongValue value={view.account} kind="text" testid="cams-admin-account" /></dd>{/if}
      {#if view.proxyId}<dt>Proxy id</dt><dd><LongValue value={view.proxyId} kind="id" copy label="the proxy id" testid="cams-admin-proxy-id" /></dd>{/if}
      {#if view.fingerprint}<dt>Key fingerprint</dt><dd class="fpbox" title="cams-admin shows the same on the proxy's page"><LongValue value={view.fingerprint} kind="fingerprint" copy label="the key fingerprint" testid="cams-admin-fingerprint" /></dd>{/if}
      {#if view.url}<dt>Last heartbeat</dt><dd class="nw" data-testid="cams-admin-heartbeat">{agoText(view.lastHeartbeatAt, now)}{view.truncated ? ' (truncated)' : ''}</dd>{/if}
      {#if view.retryInMs !== null && view.state !== 'connected'}<dt>Next try</dt><dd class="nw">in {Math.ceil(view.retryInMs / 1000)} s</dd>{/if}
      {#if view.lastError}<dt>Last error</dt><dd class="wrap bad" data-testid="cams-admin-error">{view.lastError}{#if view.lastErrorAt} <span class="nw">({agoText(view.lastErrorAt, now)})</span>{/if}</dd>{/if}
    </dl>
    {#if canEnroll(view.state)}
      <form onsubmit={enroll} class="enroll">
        <label>cams-admin URL <input type="url" bind:value={url} placeholder="https://cams-admin.example" required data-testid="cams-admin-url-input" /></label>
        <label>Enrollment code <input type="password" bind:value={code} autocomplete="off" placeholder="CAE1-…" required data-testid="cams-admin-code-input" /></label>
        <button type="submit" disabled={busy || !url || !code} data-testid="cams-admin-enroll">Enroll</button>
      </form>
    {/if}
    <div class="actions">
      {#if active}<button onclick={() => void reconnect()} disabled={busy} data-testid="cams-admin-reconnect">Reconnect</button>{/if}
      {#if view.proxyId || view.state !== 'off'}<button onclick={() => (asking = true)} disabled={busy} data-testid="cams-admin-unenroll">Unenroll</button>{/if}
    </div>
    {#if message}<p class="msg" data-testid="cams-admin-message">{message}</p>{/if}
    <p class="small">The proxy reports its health summary to cams-admin over one outbound connection; cams-admin can only send the commands allowed below.</p>
  {:else}
    <p class="small">Loading…</p>
  {/if}
</div>
{#if view}<CamsAdminCommands />{/if}
</section>
{#if asking}
  <ConfirmDialog title="Unenroll from cams-admin" message="The proxy says goodbye (cams-admin revokes its key), deletes its key file and clears camsAdmin.url. Enrolling again needs a new code from cams-admin." confirmLabel="Unenroll" oncancel={() => (asking = false)} onconfirm={() => void unenroll()} />
{/if}

<style>
  /* Full width like Maintenance; the allowed commands use the width in two columns (CamsAdminCommands). */
  .page { display: grid; gap: 12px; min-width: 0; }
  .title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  h2 { margin: 0; font-size: 20px; }
  .back { font-size: 13px; color: var(--accent); text-decoration: none; white-space: nowrap; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; gap: 8px; align-content: start; min-width: 0; }
  h3 { margin: 0; font-size: 16px; }
  p { margin: 0; }
  dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; margin: 0; font-size: 14px; align-items: baseline; }
  dt { color: var(--muted); white-space: nowrap; } dd { margin: 0; font-family: var(--mono); text-align: right; min-width: 0; }
  /* The key fingerprint on its own line under its label: groups of four, at most eight to a line. */
  .fpbox { grid-column: 1 / -1; text-align: left; }
  .fpbox :global(.fp) { display: inline-block; max-width: 48ch; }
  .nw { white-space: nowrap; }
  .muted { color: var(--muted); }
  .wrap { white-space: normal; overflow-wrap: anywhere; }
  .enroll { display: grid; gap: 8px; max-width: 480px; }
  label { display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
  input { padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font-family: var(--mono); min-width: 0; }
  .actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .small { font-size: 13px; color: var(--muted); }
  .msg { color: var(--accent); }
  .ok { color: #22c55e; }
  .bad { color: var(--danger); }
  button { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); justify-self: start; }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
