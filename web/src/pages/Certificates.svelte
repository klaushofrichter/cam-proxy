<script lang="ts">
  import { api, ApiError } from '../lib/api';
  import { status } from '../lib/state';
  import { dateText, expiresText, modeText, type TlsView } from '../lib/tls';
  import { agoText } from '../lib/format';
  import { hostOf } from '../lib/long-value';
  import LongValue from '../components/LongValue.svelte';

  // The Certificates page (#203; spec 2026-10-05-multi-camera-host-design
  // §10.4): the site CA with its fingerprint to copy into cams and its
  // download, the proxy's certificate and one card per camera with "Push now".
  // Rotating or dropping the CA stays where it is (the CLI and the control API).
  let view = $state<TlsView | null>(null);
  let failed = $state(false);
  let message = $state('');
  let busy = $state<string | null>(null);
  let now = $state(Date.now());

  const load = () =>
    void api<TlsView>('GET', '/control/tls')
      .then((v) => {
        view = v;
        failed = false;
        now = Date.now();
      })
      .catch(() => (failed = true));
  // With each status refresh, like the Status page's card.
  $effect(() => {
    if ($status) load();
  });

  const camera = (id: string) => $status?.cameras?.find((c) => c.id === id)?.camera;
  const address = (id: string) => {
    const url = camera(id)?.webUiUrl;
    return url ? hostOf(url) : null;
  };

  async function push(id: string) {
    busy = id;
    message = '';
    try {
      const r = await api<{ outcome: string; detail?: string }>('POST', `/control/cameras/${encodeURIComponent(id)}/actions/camera-cert-push`);
      message = `${id}: ${r.outcome}${r.detail ? ` (${r.detail})` : ''}`;
    } catch (e) {
      message = `${id}: ${e instanceof ApiError ? e.message : 'push failed'}`;
    }
    busy = null;
    load();
  }
</script>

<section class="page" data-testid="page-certificates">
  <div class="title"><h2>Certificates</h2><a href="#/status" class="back">← Status</a></div>
  {#if !view}
    <p class="muted">{failed ? 'The certificates could not be read.' : 'Loading…'}</p>
  {:else if !view.site}
    <div class="card"><p class="muted" data-testid="certificates-no-site">No site CA on this proxy (<span class="mono">tls.site</span> is not set): the cameras and the proxy use their own certificates.</p></div>
  {:else}
    {#each view.problems as p (p)}<p class="bad banner" data-testid="cert-problem">{p}</p>{/each}
    {#if message}<p class="msg" data-testid="cert-message">{message}</p>{/if}

    <div class="pair">
    <div class="card" data-testid="cert-ca">
      <h3>Site CA</h3>
      <dl>
        <dt>Site</dt><dd class="mono">{view.site}</dd>
        <dt>Valid until</dt><dd class="mono"><span class="nw">{dateText(view.caNotAfter)}</span>{#if view.caNotAfter}{" "}<span class="muted nw">· {expiresText(view.caNotAfter, now)}</span>{/if}</dd>
        <dt>Fingerprint</dt>
        <dd class="fpbox">{#if view.caFingerprint}<LongValue value={view.caFingerprint} kind="fingerprint" copy label="the CA fingerprint" testid="ca-fingerprint" />{:else}—{/if}</dd>
      </dl>
      <p class="small">cams pins this fingerprint (<span class="mono">caFingerprint</span>).</p>
      <div class="actions">
        <a class="button" href="/tls/ca.pem" download="cam-proxy-site-ca.pem" data-testid="ca-download">Download the CA</a>
      </div>
      <p class="small">Install the CA on your devices to open the cameras' and the proxy's pages without a warning; it can only vouch for <span class="mono">*.{view.site}.internal</span> and this host's addresses.</p>
    </div>

    <div class="card" data-testid="cert-proxy-card">
      <h3>This proxy</h3>
      {#if view.proxy}
        <dl data-testid="cert-proxy">
          <dt>Name</dt><dd><LongValue value={view.proxy.servername} kind="text" /></dd>
          <dt>Fingerprint</dt><dd><LongValue value={view.proxy.fingerprint} kind="id" copy label="the proxy's fingerprint" testid="cert-proxy-fingerprint" /></dd>
          <dt>Not after</dt><dd class="mono"><span class="nw">{dateText(view.proxy.notAfter)}</span>{" "}<span class="muted nw">· {expiresText(view.proxy.notAfter, now)}</span></dd>
        </dl>
      {:else}
        <p class="muted" data-testid="cert-proxy">No certificate of its own yet.</p>
      {/if}
    </div>
    </div>

    <h3 class="sub">Cameras</h3>
    <div class="cams">
      {#each view.cameras as c (c.id)}
        {@const name = camera(c.id)?.name ?? c.id}
        <div class="card cam" data-testid="cert-row-{c.id}">
          <div class="camhead">
            <h4 title={c.id}>{name}</h4>
            <button onclick={() => void push(c.id)} disabled={busy !== null || c.mode === 'none' || c.mode === 'public'} data-testid="cert-push-{c.id}">{busy === c.id ? 'Pushing…' : 'Push now'}</button>
          </div>
          <dl>
            {#if name !== c.id}<dt>Id</dt><dd class="mono">{c.id}</dd>{/if}
            {#if address(c.id)}<dt>Address</dt><dd><LongValue value={address(c.id)!} kind="text" /></dd>{/if}
            {#if c.servername}<dt>Server name</dt><dd><LongValue value={c.servername} kind="text" /></dd>{/if}
            <dt>Mode</dt><dd class="mono" data-testid="cert-mode-{c.id}">{modeText(c.mode)}{c.mode === 'none' ? ': no certificate' : ''}</dd>
            {#if c.fingerprint}<dt>Serves</dt><dd><LongValue value={c.fingerprint} kind="id" copy label="{c.id}'s fingerprint" testid="cert-fingerprint-{c.id}" /></dd>{/if}
            {#if c.notAfter !== null}<dt>Not after</dt><dd class="mono"><span class="nw">{dateText(c.notAfter)}</span>{" "}<span class="muted nw">· {expiresText(c.notAfter, now)}</span></dd>{/if}
            <dt>Last push</dt><dd class="mono" class:bad={c.lastPush?.outcome === 'failed' || c.lastPush?.outcome === 'refused'}>{#if c.lastPush}<span class="nw">{c.lastPush.outcome}</span> <span class="nw">{agoText(c.lastPush.at, now)}</span>{:else}—{/if}</dd>
          </dl>
          {#if c.problem}<p class="bad" data-testid="cert-camera-problem-{c.id}">{c.problem}</p>{/if}
        </div>
      {:else}
        <p class="muted">No cameras.</p>
      {/each}
    </div>
  {/if}
</section>

<style>
  /* Full width like Maintenance; on wide screens the CA and the proxy side by side. */
  .page { display: grid; gap: 12px; min-width: 0; }
  .pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 12px; align-items: start; min-width: 0; }
  .title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  h2 { margin: 0; font-size: 20px; }
  h3 { margin: 0; font-size: 16px; }
  h3.sub { margin-top: 4px; }
  h4 { margin: 0; font-size: 15px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .back { font-size: 13px; color: var(--accent); text-decoration: none; white-space: nowrap; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; gap: 8px; align-content: start; min-width: 0; }
  .cams { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: 12px; align-items: start; }
  .camhead { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  p { margin: 0; }
  dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; margin: 0; font-size: 14px; align-items: baseline; }
  dt { color: var(--muted); white-space: nowrap; }
  dd { margin: 0; min-width: 0; text-align: right; }
  /* The CA fingerprint on its own line under its label: groups of four, at most eight to a line. */
  .fpbox { grid-column: 1 / -1; text-align: left; }
  .fpbox :global(.fp) { display: inline-block; max-width: 48ch; }
  .mono { font-family: var(--mono); }
  .nw { white-space: nowrap; }
  .muted { color: var(--muted); }
  .small { font-size: 13px; color: var(--muted); }
  .msg { color: var(--accent); }
  .bad { color: var(--danger); }
  .banner { font-weight: 600; }
  .actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  button, .button { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); font-size: 14px; text-decoration: none; white-space: nowrap; }
  button:hover, .button:hover { border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
