<script lang="ts">
  import { api, ApiError } from '../lib/api';
  import { certLine, fingerprintGroups, type TlsView } from '../lib/tls';

  // The site CA (spec 2026-10-05-multi-camera-host-design §10.4): the CA
  // fingerprint to copy into cams, its download for browsers, the proxy's
  // certificate and one row per camera with "Push now". Only shown with a site.
  let { view, reload }: { view: TlsView; reload: () => void } = $props();
  let message = $state('');
  let busy = $state<string | null>(null);
  let copied = $state(false);
  const now = $derived(Date.now());
  const days = (t: number) => Math.floor((t - Date.now()) / 86400_000);

  async function copy() {
    if (!view.caFingerprint) return;
    try {
      await navigator.clipboard.writeText(view.caFingerprint);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      message = 'Copy failed: select the fingerprint and copy it by hand';
    }
  }

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
    reload();
  }
</script>

<div class="card" data-testid="card-certificates">
  <h3>Certificates</h3>
  <dl>
    <dt>Site</dt><dd>{view.site}</dd>
    <dt>CA fingerprint</dt>
    <dd class="wrap" data-testid="ca-fingerprint" title="cams pins this (caFingerprint)">{view.caFingerprint ? fingerprintGroups(view.caFingerprint) : '—'}</dd>
    {#if view.caNotAfter}<dt>CA valid until</dt><dd>{new Date(view.caNotAfter).toISOString().slice(0, 10)}</dd>{/if}
    <dt>Proxy</dt><dd data-testid="cert-proxy">{view.proxy ? `${view.proxy.servername}, ${days(view.proxy.notAfter)} days left` : '—'}</dd>
  </dl>
  <div class="actions">
    {#if view.caFingerprint}<button onclick={() => void copy()} data-testid="ca-fingerprint-copy">{copied ? 'Copied' : 'Copy fingerprint'}</button>{/if}
    <a href="/tls/ca.pem" download="cam-proxy-site-ca.pem" data-testid="ca-download">Download the CA</a>
  </div>
  <dl>
    {#each view.cameras as c (c.id)}
      <dt>{c.id}</dt>
      <dd data-testid="cert-row-{c.id}">
        <span class={c.problem || c.lastPush?.outcome === 'failed' || c.lastPush?.outcome === 'refused' ? 'bad' : ''}>{certLine(c, now)}</span>
        <button class="small-btn" onclick={() => void push(c.id)} disabled={busy !== null || c.mode === 'none' || c.mode === 'public'} data-testid="cert-push-{c.id}">Push now</button>
        {#if c.problem}<div class="bad wrap">{c.problem}</div>{/if}
      </dd>
    {/each}
  </dl>
  {#each view.problems as p (p)}<p class="bad" data-testid="cert-problem">{p}</p>{/each}
  {#if message}<p class="msg" data-testid="cert-message">{message}</p>{/if}
  <p class="small">Install the CA on your devices to open the cameras' and the proxy's pages without a warning; it can only vouch for <span class="mono">*.{view.site}.internal</span> and this host's addresses.</p>
</div>

<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; gap: 8px; }
  h3 { margin: 0; font-size: 16px; }
  p { margin: 0; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; font-size: 14px; }
  dt { color: var(--muted); } dd { margin: 0; font-family: var(--mono); text-align: right; }
  .wrap { white-space: normal; overflow-wrap: anywhere; }
  .actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .small { font-size: 13px; color: var(--muted); }
  .mono { font-family: var(--mono); }
  .msg { color: var(--accent); }
  .bad { color: var(--danger); }
  button { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); }
  .small-btn { padding: 2px 8px; margin-left: 8px; font-size: 12px; }
  button:hover { border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
