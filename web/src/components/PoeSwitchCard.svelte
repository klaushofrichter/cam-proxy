<script lang="ts">
  import { powerPath, selectedCamera } from '../lib/cameras';
  import { api } from '../lib/api';
  import { refreshTick, status } from '../lib/state';
  import { powerLine, type PowerView } from '../lib/maintenance';

  // The camera's power as cams-admin sent it (camera.power.set; spec
  // 2026-11-07-poe-switches-design, "Camera power"): cams-admin holds the
  // record and finds the camera's switch port; nothing to set here.
  const powerAt = $derived(powerPath($status, $selectedCamera));
  let power = $state<PowerView | null>(null);
  // Read when the camera changes and with the top bar's Refresh.
  $effect(() => {
    const path = powerAt;
    if (!path || $refreshTick < 0) return;
    api<PowerView>('GET', path).then((v) => (power = v), () => (power = null));
  });
</script>

{#if powerAt}
  <div class="card" data-testid="poe-switch-settings">
    <h3>Power</h3>
    <p class="line" data-testid="camera-power-line">{powerLine(power?.power ?? null)}</p>
    <p class="small">From cams-admin, which finds the camera's switch port and runs its power-cycles.{power?.power ? '' : ' cams-admin has not sent it yet.'}</p>
  </div>
{/if}

<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; gap: 8px; }
  h3 { margin: 0; font-size: 16px; }
  p { margin: 0; }
  .line { font-weight: 600; }
  .small { font-size: 13px; color: var(--muted); }
</style>
