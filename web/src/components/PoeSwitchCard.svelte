<script lang="ts">
  import { actionPath, blockOf, powerPath, selectedCamera } from '../lib/cameras';
  import { api, ApiError } from '../lib/api';
  import { refresh, refreshTick, status } from '../lib/state';
  import { poeLine, powerLine, type PortReading, type PowerView } from '../lib/maintenance';
  import { lockedWhy, rights } from '../lib/rights';
  import LockedNote from './LockedNote.svelte';

  // The camera's power as cams-admin sent it (camera.power.set; spec
  // 2026-11-07-poe-switches-design, "Camera power"): cams-admin holds the
  // record and finds the camera's switch port; nothing to set here. The
  // switch from the old settings (poeSwitch.*) still shows with its read on
  // request (never polled: the switch has one web session).
  const sw = $derived(blockOf($status, $selectedCamera)?.camera.poeSwitch ?? null);
  const powerAt = $derived(powerPath($status, $selectedCamera));
  let power = $state<PowerView | null>(null);
  // Read when the camera changes and with the top bar's Refresh.
  $effect(() => {
    const path = powerAt;
    if (!path || $refreshTick < 0) return;
    api<PowerView>('GET', path).then((v) => (power = v), () => (power = null));
  });
  let message = $state('');
  const locked = $derived(lockedWhy($rights, 'local')); // issue #227
  let reading = $state(false);
  async function read() {
    reading = true;
    try {
      const r = await api<PortReading>('POST', actionPath($status, $selectedCamera, 'poe-switch-read'));
      message = `Port ${r.port} (index ${r.index}): PoE ${r.poe ? 'on' : 'off'}, ${r.watts} W, link ${r.link === null ? 'unknown' : r.link ? 'up' : 'down'}`;
    } catch (e) {
      message = e instanceof ApiError ? e.message : 'not read';
    }
    reading = false;
    void refresh();
  }
</script>

{#if powerAt}
  <div class="card" data-testid="poe-switch-settings">
    <h3>Power</h3>
    <p class="line" data-testid="camera-power-line">{powerLine(power?.power ?? null)}</p>
    <p class="small">From cams-admin, which finds the camera's switch port and runs its power-cycles.{power?.power ? '' : ' cams-admin has not sent it yet.'}</p>
    {#if sw?.configured}
      <p class="small" data-testid="poe-switch-line">Switch from the old settings: {poeLine(sw)}</p>
      {#if sw.last}<p class="small">Switch {sw.last.sn ?? '—'}{sw.last.firmware ? `, firmware ${sw.last.firmware}` : ''}; port {sw.last.port} is internal index {sw.last.index}.</p>{/if}
      <div><button onclick={() => void read()} disabled={reading || sw.busy || !!locked} data-testid="poe-switch-read">Read the switch now</button></div>
      <LockedNote why={locked} testid="poe-switch-locked" />
    {/if}
    {#if message}<p class="msg" data-testid="poe-switch-message">{message}</p>{/if}
  </div>
{/if}

<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; gap: 8px; }
  h3 { margin: 0; font-size: 16px; }
  p { margin: 0; }
  .line { font-weight: 600; }
  .small { font-size: 13px; color: var(--muted); }
  .msg { color: var(--accent); }
  button { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); }
  button:hover { border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
