<script lang="ts">
  import { status } from '../lib/state';
  import { cameraIds, pickCamera, selectedCamera } from '../lib/cameras';
  const ids = $derived(cameraIds($status));
  const current = $derived(pickCamera(ids, $selectedCamera));
</script>

{#if ids.length > 1}
  <label class="picker">
    <span class="long">Camera</span>
    <select data-testid="camera-picker" value={current} onchange={(e) => selectedCamera.set((e.currentTarget as HTMLSelectElement).value)}>
      {#each $status?.cameras ?? [] as c (c.id)}
        <option value={c.id}>{c.camera.name ?? c.id}{c.camera.online ? '' : ' (offline)'}</option>
      {/each}
    </select>
  </label>
{/if}

<style>
  .picker { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: var(--muted); }
  select { font: inherit; padding: 2px 6px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); }
</style>
