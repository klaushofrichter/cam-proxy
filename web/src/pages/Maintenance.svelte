<script lang="ts">
  import { onMount } from 'svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import InventoryCard from '../components/InventoryCard.svelte';
  import { api, ApiError } from '../lib/api';
  import { poeAlert, poeOnText, powerCycleFailText, powerCycleMessage, restartWatch, RESTART_GIVE_UP_MS, type Health } from '../lib/maintenance';
  import { refresh, refreshTick, status } from '../lib/state';

  let result = $state('');
  let log = $state<Array<Record<string, unknown>>>([]);
  const loadLog = async () => (log = (await api<Array<Record<string, unknown>>>('GET', '/control/log?limit=200')).reverse());
  onMount(() => void loadLog());
  // The log follows along by itself (every 10 s), and with the top bar's Refresh.
  $effect(() => {
    if ($refreshTick) void loadLog();
  });
  $effect(() => {
    const t = setInterval(() => void loadLog(), 10_000);
    return () => clearInterval(t);
  });

  async function run(label: string, name: string, body?: unknown) {
    try {
      const r = await api<unknown>('POST', `/control/actions/${name}`, body);
      result = `${label}: ${r === null ? 'started' : JSON.stringify(r)}`;
    } catch (e) {
      result = `${label}: ${e instanceof ApiError ? e.message : 'failed'}`;
    }
    void refresh();
    void loadLog();
  }

  // The camera reboot (#83), the power-cycle (#85) and the proxy restart
  // (#71) ask first, in one shared dialog; Cancel or Esc sends nothing.
  const poe = $derived($status?.camera.poeSwitch ?? null);
  const DIALOGS = $derived({
    'camera-reboot': {
      title: 'Reboot the camera',
      message: 'Reboot the camera? It is offline for about a minute: no live video, stills, events or uploads meanwhile. Note: on 2026-10-01 recording downloads stopped working right after an API reboot.',
      confirmLabel: 'Reboot camera',
    },
    'camera-powercycle': {
      title: 'Power-cycle the camera',
      message: poe ? powerCycleMessage(poe) : '',
      confirmLabel: 'Power-cycle camera',
    },
    'inventory-repair': {
      title: 'Fetch lost clips',
      message: `Fetch ${offer.count} lost clips (${(offer.bytes / 2 ** 20).toFixed(1)} MB) from the camera's SD card over Baichuan? They are fetched one at a time, after any viewer's download, and added to the Clips page marked "from camera". At most 50 clips or 200 MB per run.`,
      confirmLabel: 'Fetch clips',
    },
    'restart-proxy': {
      title: 'Restart the proxy',
      message: 'Restart the proxy? Live streams and uploads in progress are interrupted; the proxy is back in a few seconds. You sign in again afterwards.',
      confirmLabel: 'Restart proxy',
    },
  });
  let asking = $state<'camera-reboot' | 'camera-powercycle' | 'restart-proxy' | 'inventory-repair' | null>(null);
  // The Inventory box's repair (#74): its dry-run numbers go into the message.
  let inventory = $state<{ fetchLost: () => void } | undefined>();
  let offer = $state({ count: 0, bytes: 0 });

  // The camera reboot: "Rebooting…" and the camera's state while the proxy
  // waits for it, then how long it was away.
  let rebootAsked = $state(false);
  const reboot = $derived($status?.camera.reboot ?? null);
  // A reboot or power-cycle on its way: set before the first await, so a
  // second confirm can't send another (#78 review).
  let sending = $state(false);
  const cameraBusy = $derived(sending || reboot?.phase === 'rebooting' || reboot?.phase === 'power-cycling');
  function fetchLost() {
    asking = null;
    inventory?.fetchLost();
  }
  async function rebootCamera() {
    asking = null;
    if (sending) return;
    sending = true;
    try {
      const r = await api<{ confirmed: boolean }>('POST', '/control/actions/camera-reboot');
      rebootAsked = true;
      result = `Camera reboot: ${r.confirmed ? 'the camera confirmed it' : 'the camera went down before answering'}`;
    } catch (e) {
      result = `Camera reboot: ${e instanceof ApiError ? e.message : 'failed'}`;
    }
    sending = false;
    void refresh();
    void loadLog();
  }

  // The power-cycle (#85): the answer comes once the PoE is back on (after
  // offSeconds); meanwhile "Power-cycling…", then the reboot's states.
  let cycling = $state(false);
  async function powerCycleCamera() {
    asking = null;
    if (sending) return;
    sending = true;
    cycling = true;
    void refresh();
    try {
      const r = await api<{ offAt: number; onAt: number; watts: number }>('POST', '/control/actions/camera-powercycle');
      rebootAsked = true;
      result = `Camera power-cycle: PoE back on after ${Math.round((r.onAt - r.offAt) / 1000)} s (the camera drew ${r.watts} W)`;
    } catch (e) {
      result = e instanceof ApiError && e.body && typeof e.body === 'object' ? powerCycleFailText(e.body as { error: string }, poe?.port ?? null) : 'Camera power-cycle: failed';
    }
    cycling = false;
    sending = false;
    void refresh();
    void loadLog();
  }
  // Recovery (#85 review): turn the camera's PoE on if it is off. Shown
  // whenever a switch is configured; it only ever turns PoE on, so no dialog.
  async function poeOn() {
    if (sending) return;
    sending = true;
    try {
      result = poeOnText(await api<{ port: number; wasOn: boolean; watts: number }>('POST', '/control/actions/camera-poe-on'));
    } catch (e) {
      result = `Camera PoE on: ${e instanceof ApiError ? e.message : 'failed'}`;
    }
    sending = false;
    void refresh();
    void loadLog();
  }
  const alert = $derived(poeAlert(poe));

  // Faster status updates while the camera reboots or is power-cycled.
  $effect(() => {
    if (reboot?.phase !== 'rebooting' && reboot?.phase !== 'power-cycling' && !cycling) return;
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  });

  // The proxy restart: "Restarting…", then /health until a new process
  // answers (another start time or version), then a reload.
  let restarting = $state<'waiting' | 'gone' | null>(null);
  let restartTimer: ReturnType<typeof setInterval> | undefined;
  const health = async (): Promise<Health | null> => {
    try {
      const r = await fetch('/health', { cache: 'no-store' });
      return r.ok ? ((await r.json()) as Health) : null;
    } catch {
      return null;
    }
  };
  async function restartProxy() {
    asking = null;
    // Busy before the first await: the dialog can't be confirmed twice (#78 review).
    if (restarting === 'waiting') return;
    restarting = 'waiting';
    // The start time to compare with: one more try if the first read fails.
    const before = (await health()) ?? (await health());
    const postedAt = Date.now();
    try {
      await api('POST', '/control/actions/restart-proxy');
    } catch (e) {
      restarting = null;
      result = `Restart proxy: ${e instanceof ApiError ? e.message : 'failed'}`;
      return;
    }
    const isNew = restartWatch(before, postedAt);
    const t0 = Date.now();
    restartTimer = setInterval(async () => {
      const h = await health();
      if (isNew(h)) {
        clearInterval(restartTimer);
        location.reload();
      } else if (Date.now() - t0 > RESTART_GIVE_UP_MS) {
        clearInterval(restartTimer);
        restarting = 'gone';
      }
    }, 1000);
  }
  onMount(() => () => clearInterval(restartTimer));
</script>

<section>
  <h2>Maintenance</h2>
  <div class="card">
    <div class="buttons">
      <button onclick={() => void run('Camera test', 'camera-test')} data-testid="action-camera-test">Test the camera</button>
      <button onclick={() => void run('ONVIF', 'onvif-resubscribe')} data-testid="action-resubscribe">Re-subscribe ONVIF</button>
      <button onclick={() => void run('Retention preview', 'retention-run', { dryRun: true })} data-testid="action-retention-dry">Preview retention</button>
      <button onclick={() => void run('Retention', 'retention-run', {})} data-testid="action-retention">Run retention now</button>
      <button onclick={() => void run('Restart', 'restart')} data-testid="action-restart">Restart camera side</button>
      <button class="danger" onclick={() => (asking = 'camera-reboot')} disabled={cameraBusy} data-testid="action-camera-reboot">Reboot camera</button>
      {#if poe?.configured}
        <button class="danger" onclick={() => (asking = 'camera-powercycle')} disabled={cameraBusy} data-testid="action-camera-powercycle">Power-cycle camera</button>
        <button onclick={() => void poeOn()} disabled={sending || cycling} data-testid="action-camera-poe-on" title="Turns the camera's PoE on if it is off (no power check)">Turn camera PoE on</button>
      {/if}
      <button class="danger" onclick={() => (asking = 'restart-proxy')} disabled={restarting === 'waiting'} data-testid="action-restart-proxy">Restart proxy</button>
    </div>
    <div class="buttons">
      <button onclick={() => void run('Camera FTP setup', 'camera-ftp-setup')} data-testid="action-ftp-setup">Point the camera's FTP here</button>
      <button onclick={() => void run('Camera FTP test', 'camera-ftp-test')} data-testid="action-ftp-test">Test the camera's FTP</button>
      <button onclick={() => void run('Camera FTP off', 'camera-ftp-off')} data-testid="action-ftp-off">Turn the camera's FTP off</button>
    </div>
    {#if alert}<p class="bad" data-testid="poe-alert">{alert}</p>{/if}
    {#if result}<p class="msg mono" data-testid="action-result">{result}</p>{/if}
    {#if cycling || reboot?.phase === 'power-cycling'}
      <p class="busy" data-testid="reboot-state">Power-cycling… the camera's PoE is off on {poe?.host} port {poe?.port}; it comes back on after {poe?.offSeconds} s.</p>
    {:else if reboot?.phase === 'rebooting'}
      <p class="busy" data-testid="reboot-state">Rebooting… the camera is {$status?.camera.online ? 'still answering' : 'offline'}{$status?.camera.error ? ` (${$status.camera.error})` : ''}.</p>
    {:else if rebootAsked && reboot?.phase === 'back'}
      <p class="msg" data-testid="reboot-state">The camera is back after {reboot.downSec} s.</p>
    {:else if rebootAsked && reboot?.phase === 'not-back'}
      <p class="bad" data-testid="reboot-state">The camera did not answer within 5 minutes of the {reboot.kind === 'powercycle' ? 'power-cycle' : 'reboot'}.</p>
    {/if}
    {#if restarting === 'waiting'}
      <p class="busy" data-testid="restart-state">Restarting… the page reloads when the proxy is back.</p>
    {:else if restarting === 'gone'}
      <p class="bad" data-testid="restart-state">The proxy did not come back. Is it running under a supervisor (compose, the cluster)?</p>
    {/if}
  </div>
  <InventoryCard bind:this={inventory} onrepair={(o) => { offer = o; asking = 'inventory-repair'; }} />
  <div class="card">
    <div class="loghead"><h3>Log</h3><span class="small">updates every 10 s</span></div>
    <div class="log">
      <table>
        <tbody>
          {#each log as l, i (i)}
            <tr><td class="mono">{new Date(Number(l.time)).toLocaleTimeString()}</td><td class="lvl{l.level}">{l.level}</td><td class="mono">{l.msg}</td><td class="mono small">{JSON.stringify(Object.fromEntries(Object.entries(l).filter(([k]) => !['time', 'level', 'msg', 'pid', 'hostname'].includes(k))))}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
</section>

{#if asking}
  {@const dlg = DIALOGS[asking]}
  <ConfirmDialog title={dlg.title} message={dlg.message} confirmLabel={dlg.confirmLabel} oncancel={() => (asking = null)} onconfirm={() => void (asking === 'inventory-repair' ? fetchLost() : asking === 'camera-reboot' ? rebootCamera() : asking === 'camera-powercycle' ? powerCycleCamera() : restartProxy())} />
{/if}

<style>
  section { display: grid; gap: 12px; }
  h2 { margin: 0; font-size: 20px; }
  h3 { margin: 0; font-size: 16px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; gap: 8px; }
  .buttons { display: flex; flex-wrap: wrap; gap: 8px; }
  button { padding: 7px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); }
  button:hover { border-color: var(--accent); }
  button.danger { border-color: var(--danger); }
  button:disabled { opacity: 0.5; cursor: default; }
  .busy { margin: 0; color: var(--accent); font-weight: 600; }
  .bad { margin: 0; color: var(--danger); }
  .loghead { display: flex; justify-content: space-between; align-items: center; }
  .log { max-height: 420px; overflow: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 3px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  .lvl40, .lvl50 { color: var(--danger); }
  .mono { font-family: var(--mono); }
  .small { font-size: 12px; color: var(--muted); }
  .msg { margin: 0; color: var(--accent); }
</style>
