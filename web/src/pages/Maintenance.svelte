<script lang="ts">
  import { onMount } from 'svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import InventoryCard from '../components/InventoryCard.svelte';
  import { api, ApiError } from '../lib/api';
  import { MB, mbText } from '../lib/format';
  import { REPAIR_MAX_BYTES, REPAIR_MAX_CLIPS } from '../lib/inventory';
  import { powerCycleDisabled, powerCycleFailText, powerWhyText, powerCycleMessage, powerResultText, readHealth, rebootEndText, waitForNewProxy, type PowerView } from '../lib/maintenance';
  import { refresh, refreshTick, status } from '../lib/state';
  import { clearMatches, clearMessage } from '../lib/archive';
  import { actionPath, blockOf, powerPath, selectedCamera } from '../lib/cameras';
  import { lockedWhy, rights } from '../lib/rights';
  import LockedNote from '../components/LockedNote.svelte';
  // The actions that act on a camera: the picked one when there are several.
  const camName = $derived(blockOf($status, $selectedCamera)?.camera.name ?? blockOf($status, $selectedCamera)?.id ?? '');
  const CAMERA_ACTIONS = ['camera-test', 'onvif-resubscribe', 'camera-ftp-setup', 'camera-ftp-test', 'camera-ftp-off', 'restart'];

  let result = $state('');
  // Issue #227: a cams-admin sign-in runs none of these unless the proxy's
  // allow-list unlocks the restarts (ui.restart); the reason shows once.
  const locked = $derived(lockedWhy($rights, 'local'));
  const restartLocked = $derived(lockedWhy($rights, 'restart'));
  let log = $state<Array<Record<string, unknown>>>([]);
  const loadLog = async () => (log = (await api<Array<Record<string, unknown>>>('GET', '/control/log?limit=200')).reverse());
  onMount(() => void loadLog());
  // The log follows along by itself (every 10 s), and with the top bar's Refresh.
  $effect(() => {
    if ($refreshTick) void loadLog();
  });
  $effect(() => {
    const t = setInterval(() => document.visibilityState !== 'hidden' && void loadLog(), 10_000);
    return () => clearInterval(t);
  });

  async function run(label: string, name: string, body?: unknown) {
    try {
      const r = await api<unknown>('POST', CAMERA_ACTIONS.includes(name) ? actionPath($status, $selectedCamera, name) : `/control/actions/${name}`, body);
      result = `${label}: ${r === null ? 'started' : JSON.stringify(r)}`;
    } catch (e) {
      result = `${label}: ${e instanceof ApiError ? e.message : 'failed'}`;
    }
    void refresh();
    void loadLog();
  }

  // The camera reboot (#83), the power-cycle (#85) and the proxy restart
  // (#71) ask first, in one shared dialog; Cancel or Esc sends nothing.
  // The camera's power as cams-admin sent it, the open request and cams-admin's
  // last answer (spec 2026-11-07-poe-switches-design, "Asking from a proxy").
  let power = $state<PowerView | null>(null);
  const powerAt = $derived(powerPath($status, $selectedCamera));
  const loadPower = async () => {
    const path = powerAt;
    if (!path) return;
    try {
      power = await api<PowerView>('GET', path);
    } catch {
      power = null;
    }
  };
  // Read when the camera changes and with the top bar's Refresh.
  $effect(() => {
    if (powerAt && $refreshTick >= 0) void loadPower();
  });
  const DIALOGS = $derived({
    'camera-reboot': {
      title: 'Reboot the camera',
      message: 'Reboot the camera? It is offline for about a minute: no live video, stills, events or uploads meanwhile. Note: on 2026-10-01 recording downloads stopped working right after an API reboot.',
      confirmLabel: 'Reboot camera',
    },
    'camera-powercycle': {
      title: 'Power-cycle the camera',
      message: powerCycleMessage(power?.power ?? null),
      confirmLabel: 'Ask cams-admin',
    },
    'inventory-repair': {
      title: 'Retrieve missing clips',
      message: `Retrieve ${offer.count} clips (${mbText(offer.bytes)}) from the camera? They are fetched from its SD card over Baichuan one at a time, after any viewer's download, and added to the Clips page marked "from camera". At most ${REPAIR_MAX_CLIPS} clips or ${REPAIR_MAX_BYTES / MB} MB per run.`,
      confirmLabel: 'Retrieve clips',
    },
    'inventory-duplicates': {
      title: 'Remove duplicate clips',
      message: `Remove ${duplicates.count} clips (${mbText(duplicates.bytes)}) fetched from the camera? Each is a recording the proxy also has as an FTP clip: the FTP copy stays, which starts a few seconds later, so those first seconds go with the fetched clip. A pair is left alone unless the FTP copy is a readable video that reaches the recording's end. This can't be undone: the inventory won't offer the recording again, because the FTP copy holds it.`,
      confirmLabel: 'Remove clips',
    },
    'inventory-recover': {
      title: 'Add missing events',
      message: `Add ${recoverText} from the camera's SD recordings? Each one gets the kind, start and end of its recordings (pre- and post-record included) and is marked "recovered" on the Events page and the Timeline; cams sees it marked too. No SSE message is sent and it is never analysed. At most 1000 per run; existing events are not changed.`,
      confirmLabel: 'Add events',
    },
    'archive-clear': {
      title: 'Clear the Archive',
      message: clearMessage(archiveNow),
      confirmLabel: 'Clear the Archive',
    },
    'restart-proxy': {
      title: 'Restart the proxy',
      message: 'Restart the proxy? Live streams and uploads in progress are interrupted; the proxy is back in a few seconds. You sign in again afterwards.',
      confirmLabel: 'Restart proxy',
    },
  });
  let asking = $state<'camera-reboot' | 'camera-powercycle' | 'restart-proxy' | 'inventory-repair' | 'inventory-duplicates' | 'inventory-recover' | 'archive-clear' | null>(null);
  // Clear the Archive (spec 2026-10-05-archive-design §6, ruling 14): the
  // count when the dialog opened goes into the message and must be typed;
  // the proxy refuses it when the Archive changed meanwhile.
  let archiveNow = $state({ count: 0, bytes: 0 });
  const archive = $derived($status?.archive ?? null);
  function askClear() {
    if (!archive) return;
    archiveNow = { count: archive.count, bytes: archive.bytes };
    asking = 'archive-clear';
  }
  async function clearArchive() {
    asking = null;
    await run('Clear the Archive', 'archive-clear', { count: archiveNow.count });
  }
  // The Inventory box's repair (#74): its dry-run numbers go into the message.
  // A search that ends asks by itself (auto), but never over another open dialog.
  let inventory = $state<{ fetchLost: () => void; addMissing: () => void; removeDuplicates: () => void } | undefined>();
  let offer = $state({ count: 0, bytes: 0 });
  let duplicates = $state({ count: 0, bytes: 0 });
  // The events repair (#75): the check's count goes into the message.
  let recoverText = $state('');

  // The camera reboot: "Rebooting…" and the camera's state while the proxy
  // waits for it, then how long it was away.
  let rebootAsked = $state(false);
  const reboot = $derived(blockOf($status, $selectedCamera)?.camera.reboot ?? null);
  // A reboot or power-cycle on its way: set before the first await, so a
  // second confirm can't send another (#78 review).
  let sending = $state(false);
  const cameraBusy = $derived(sending || reboot?.phase === 'rebooting' || reboot?.phase === 'power-cycling');
  function addMissing() {
    asking = null;
    inventory?.addMissing();
  }
  function fetchLost() {
    asking = null;
    inventory?.fetchLost();
  }
  function removeDuplicates() {
    asking = null;
    inventory?.removeDuplicates();
  }
  // One camera action at a time: `send` returns the result line, `failed`
  // the line for an error; then the status and the log are read again.
  async function cameraAction(send: () => Promise<string>, failed: (e: unknown) => string) {
    if (sending) return;
    sending = true;
    try {
      result = await send();
    } catch (e) {
      result = failed(e);
    }
    sending = false;
    void refresh();
    void loadLog();
  }
  const failedText = (label: string) => (e: unknown) => `${label}: ${e instanceof ApiError ? e.message : 'failed'}`;
  async function rebootCamera() {
    asking = null;
    await cameraAction(async () => {
      const r = await api<{ confirmed: boolean }>('POST', actionPath($status, $selectedCamera, 'camera-reboot'));
      rebootAsked = true;
      return `Camera reboot: ${r.confirmed ? 'the camera confirmed it' : 'the camera went down before answering'}`;
    }, failedText('Camera reboot'));
  }

  // The power-cycle through cams-admin: the request is answered at once
  // (202 {requestId}); "asked cams-admin…" until cams-admin's result arrives,
  // then the reboot's states as cams-admin cuts and restores the PoE.
  let askedId = $state<string | null>(null);
  async function powerCycleCamera() {
    asking = null;
    await cameraAction(async () => {
      const r = await api<{ requestId: string }>('POST', actionPath($status, $selectedCamera, 'camera-powercycle'));
      askedId = r.requestId;
      rebootAsked = true;
      void loadPower();
      return 'Camera power-cycle: asked cams-admin…';
    }, (e) => (e instanceof ApiError && e.body && typeof e.body === 'object' ? powerCycleFailText(e.body as { error: string }) : 'Camera power-cycle: failed'));
  }
  // cams-admin's answer to this page's request.
  $effect(() => {
    const r = power?.result;
    // The answer, or the proxy's "no answer within 5 minutes"; without cams-admin the request just ends.
    if (askedId && r && r.requestId === askedId) {
      result = powerResultText(r);
      askedId = null;
    } else if (askedId && power && !power.asked && !power.canRequest) {
      askedId = null;
    }
  });
  const waiting = $derived(!!power?.asked);

  // Faster status updates while the camera reboots or is power-cycled, or cams-admin has not answered yet.
  $effect(() => {
    if (reboot?.phase !== 'rebooting' && reboot?.phase !== 'power-cycling' && !waiting && !askedId) return;
    const t = setInterval(() => {
      void refresh();
      void loadPower();
    }, 2000);
    return () => clearInterval(t);
  });

  // The proxy restart: "Restarting…", then /health until a new process
  // answers (another start time or version), then a reload.
  let restarting = $state<'waiting' | 'gone' | null>(null);
  let stopRestartWait: (() => void) | undefined;
  async function restartProxy() {
    asking = null;
    // Busy before the first await: the dialog can't be confirmed twice (#78 review).
    if (restarting === 'waiting') return;
    restarting = 'waiting';
    // The start time to compare with: one more try if the first read fails.
    const before = (await readHealth()) ?? (await readHealth());
    const postedAt = Date.now();
    try {
      await api('POST', '/control/actions/restart-proxy');
    } catch (e) {
      restarting = null;
      result = `Restart proxy: ${e instanceof ApiError ? e.message : 'failed'}`;
      return;
    }
    stopRestartWait = waitForNewProxy(before, postedAt, () => location.reload(), () => (restarting = 'gone'));
  }
  onMount(() => () => stopRestartWait?.());
</script>

<section>
  <h2>Maintenance</h2>
  <LockedNote why={locked && restartLocked ? locked : locked ? `${locked} Only the restarts are allowed here.` : null} testid="maintenance-locked" />
  {#if result}<p class="msg mono" data-testid="action-result">{result}</p>{/if}
  <!-- The camera picked in the top bar (Klaus 2026-11-06: say which actions are the camera's). -->
  <h3 class="section" data-testid="maintenance-camera-section">Camera: {camName}</h3>
  <div class="card">
    <div class="buttons">
      <button onclick={() => void run('Camera test', 'camera-test')} disabled={!!locked} data-testid="action-camera-test">Test the camera</button>
      <button onclick={() => void run('ONVIF', 'onvif-resubscribe')} disabled={!!locked} data-testid="action-resubscribe">Re-subscribe ONVIF</button>
      <button onclick={() => void run('Restart', 'restart')} disabled={!!restartLocked} data-testid="action-restart">Restart camera side</button>
      <button class="danger" onclick={() => (asking = 'camera-reboot')} disabled={cameraBusy || !!locked} data-testid="action-camera-reboot">Reboot camera</button>
      <button class="danger" onclick={() => (asking = 'camera-powercycle')} disabled={powerCycleDisabled(power, cameraBusy || !!locked)} title={power?.why ?? undefined} data-testid="action-camera-powercycle">Power-cycle (through cams-admin)</button>
    </div>
    <div class="buttons">
      <button onclick={() => void run('Camera FTP setup', 'camera-ftp-setup')} disabled={!!locked} data-testid="action-ftp-setup">Point the camera's FTP here</button>
      <button onclick={() => void run('Camera FTP test', 'camera-ftp-test')} disabled={!!locked} data-testid="action-ftp-test">Test the camera's FTP</button>
      <button onclick={() => void run('Camera FTP off', 'camera-ftp-off')} disabled={!!locked} data-testid="action-ftp-off">Turn the camera's FTP off</button>
    </div>
    {#if power?.why && !locked}<p class="small" data-testid="powercycle-why">{powerWhyText(power.why)}</p>{/if}
    {#if waiting && reboot?.phase !== 'power-cycling' && reboot?.phase !== 'rebooting'}
      <p class="busy" data-testid="reboot-state">Asked cams-admin… it checks the camera's switch port first.</p>
    {:else if reboot?.phase === 'power-cycling'}
      <p class="busy" data-testid="reboot-state">Power-cycling… cams-admin cut the camera's PoE; it comes back on in a few seconds.</p>
    {:else if reboot?.phase === 'rebooting'}
      <p class="busy" data-testid="reboot-state">Rebooting… the camera is {blockOf($status, $selectedCamera)?.camera.online ? 'still answering' : 'offline'}{blockOf($status, $selectedCamera)?.camera.error ? ` (${blockOf($status, $selectedCamera)?.camera.error})` : ''}.</p>
    {:else if rebootAsked && reboot?.phase === 'back'}
      <p class="msg" data-testid="reboot-state">The camera is back after {reboot.downSec} s.</p>
    {:else if rebootAsked && reboot?.phase === 'not-back'}
      <p class="bad" data-testid="reboot-state">{rebootEndText(reboot)}</p>
    {/if}
  </div>
  <InventoryCard bind:this={inventory} onrepair={(o, auto) => { if (auto && asking) return; offer = o; asking = 'inventory-repair'; }} onrecover={(o, auto) => { if (auto && asking) return; recoverText = o.text; asking = 'inventory-recover'; }} onremove={(o) => { duplicates = o; asking = 'inventory-duplicates'; }} />
  <h3 class="section" data-testid="maintenance-proxy-section">Proxy</h3>
  <div class="card">
    <div class="buttons">
      <button onclick={() => void run('Retention preview', 'retention-run', { dryRun: true })} disabled={!!locked} data-testid="action-retention-dry">Preview retention</button>
      <button onclick={() => void run('Retention', 'retention-run', {})} disabled={!!locked} data-testid="action-retention">Run retention now</button>
      <button class="danger" onclick={() => (asking = 'restart-proxy')} disabled={restarting === 'waiting' || !!restartLocked} data-testid="action-restart-proxy">Restart proxy</button>
      <button class="danger" onclick={askClear} disabled={!archive?.count || !!locked} data-testid="action-archive-clear" title="Deletes every clip in the Archive (asks for the number of clips)">Clear the Archive…</button>
    </div>
    {#if restarting === 'waiting'}
      <p class="busy" data-testid="restart-state">Restarting… the page reloads when the proxy is back.</p>
    {:else if restarting === 'gone'}
      <p class="bad" data-testid="restart-state">The proxy did not come back. Is it running under a supervisor (compose, the cluster)?</p>
    {/if}
  </div>
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
  <ConfirmDialog title={dlg.title} message={dlg.message} confirmLabel={dlg.confirmLabel} typed={asking === 'archive-clear' ? { label: 'Number of clips', matches: (v) => clearMatches(v, archiveNow.count) } : undefined} oncancel={() => (asking = null)} onconfirm={() => void (asking === 'archive-clear' ? clearArchive() : asking === 'inventory-repair' ? fetchLost() : asking === 'inventory-duplicates' ? removeDuplicates() : asking === 'inventory-recover' ? addMissing() : asking === 'camera-reboot' ? rebootCamera() : asking === 'camera-powercycle' ? powerCycleCamera() : restartProxy())} />
{/if}

<style>
  section { display: grid; gap: 12px; }
  h2 { margin: 0; font-size: 20px; }
  h3.section { margin: 8px 0 0; font-size: 17px; }
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
