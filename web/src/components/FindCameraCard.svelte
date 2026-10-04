<script lang="ts">
  import { onMount } from 'svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { api, ApiError } from '../lib/api';
  import { deviceLabel, foundText, handLine, notAvailableText, useAddressMessage, writtenText, type FindResult, type FoundDevice } from '../lib/find-camera';
  import { restartWatch, RESTART_GIVE_UP_MS, type Health } from '../lib/maintenance';

  // Find camera (spec 2026-10-04-pi-config-design §3, §4): an ONVIF
  // WS-Discovery probe from the proxy (on the Pi: the LAN), then "Use this
  // address" writes CAMERA_HOST into the .env file and restarts the proxy.
  let result = $state<FindResult | null>(null);
  let searching = $state(false);
  let message = $state('');
  let line = $state(''); // the .env line to add by hand
  let asking = $state<FoundDevice | null>(null);
  let restarting = $state<'waiting' | 'gone' | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;
  onMount(() => () => clearInterval(timer));

  async function find() {
    searching = true;
    message = line = '';
    try {
      result = await api<FindResult>('POST', '/control/actions/find-camera');
      message = foundText(result.devices.length, result.tookMs);
    } catch (e) {
      message = e instanceof ApiError && e.status === 429 ? 'Searched too often: try again in a minute.' : `Not searched: ${e instanceof ApiError ? e.message : 'failed'}`;
    }
    searching = false;
  }

  function ask(d: FoundDevice) {
    line = '';
    if (result && !result.envFile.writable) {
      message = notAvailableText(result.envFile.reason);
      line = handLine(d.address);
      return;
    }
    asking = d;
  }

  const health = async (): Promise<Health | null> => {
    try {
      const r = await fetch('/health', { cache: 'no-store' });
      return r.ok ? ((await r.json()) as Health) : null;
    } catch {
      return null;
    }
  };

  async function use(d: FoundDevice) {
    asking = null;
    const before = await health();
    try {
      const r = await api<{ host: string; previous: string | null; backup: string }>('POST', '/control/actions/camera-address', { host: d.address });
      message = writtenText(r);
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { error?: string; detail?: string; line?: string } | null) : null;
      if (body?.error === 'not_available') {
        message = notAvailableText(body.detail);
        line = body.line ?? handLine(d.address);
      } else message = `Not written: ${e instanceof ApiError ? e.message : 'failed'}`;
      return;
    }
    // The new address applies in a new process: the restart-proxy action.
    restarting = 'waiting';
    const postedAt = Date.now();
    try {
      await api('POST', '/control/actions/restart-proxy');
    } catch (e) {
      restarting = null;
      message += ` The restart failed (${e instanceof ApiError ? e.message : 'failed'}): use "Restart proxy" on the Maintenance page.`;
      return;
    }
    const isNew = restartWatch(before, postedAt);
    const t0 = Date.now();
    timer = setInterval(async () => {
      if (isNew(await health())) {
        clearInterval(timer);
        location.reload();
      } else if (Date.now() - t0 > RESTART_GIVE_UP_MS) {
        clearInterval(timer);
        restarting = 'gone';
      }
    }, 1000);
  }
</script>

<div class="card" data-testid="find-camera-card">
  <h3>Find camera</h3>
  <p class="small">Asks the LAN for ONVIF cameras (WS-Discovery, about 3 s; no login). "Use this address" writes <span class="mono">CAMERA_HOST</span> into the proxy's .env file and restarts the proxy.</p>
  <div><button onclick={() => void find()} disabled={searching || restarting === 'waiting'} data-testid="find-camera-button">{searching ? 'Searching…' : 'Find camera'}</button></div>
  {#if result && result.devices.length}
    <table>
      <tbody>
        {#each result.devices as d (d.endpoint)}
          <tr data-testid="find-camera-device">
            <td class="mono">{d.address}</td>
            <td>{deviceLabel(d)}</td>
            <td>{#if d.current}<span class="badge current" data-testid="find-camera-current">this camera</span>{/if}</td>
            <td class="actions">
              {#if !d.current}<button onclick={() => ask(d)} disabled={restarting === 'waiting'} data-testid="find-camera-use">Use this address</button>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
  {#if message}<p class="msg" data-testid="find-camera-message">{message}</p>{/if}
  {#if line}<pre class="mono line" data-testid="find-camera-line">{line}</pre>{/if}
  {#if restarting === 'waiting'}
    <p class="busy" data-testid="find-camera-restart">Restarting… the page reloads when the proxy is back.</p>
  {:else if restarting === 'gone'}
    <p class="bad" data-testid="find-camera-restart">The proxy did not come back. Is it running under a supervisor (compose)?</p>
  {/if}
</div>

{#if asking}
  {@const d = asking}
  <ConfirmDialog title="Use this camera address" message={useAddressMessage(d.address, result?.envFile.path)} confirmLabel="Use this address" oncancel={() => (asking = null)} onconfirm={() => void use(d)} />
{/if}

<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; gap: 8px; }
  h3 { margin: 0; font-size: 16px; }
  p { margin: 0; }
  .small { font-size: 13px; color: var(--muted); }
  .mono { font-family: var(--mono); }
  .msg { color: var(--accent); }
  .busy { color: var(--accent); font-weight: 600; }
  .bad { color: var(--danger); }
  .line { margin: 0; padding: 6px 8px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; user-select: all; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  td { padding: 4px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  .actions { text-align: right; white-space: nowrap; }
  .badge { font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--accent); color: var(--accent); }
  button { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); }
  button:hover { border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
