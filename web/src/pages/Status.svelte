<script lang="ts">
  import { status, stats } from '../lib/state';

  const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
  const mb = (b: number) => `${(b / 1024 ** 2).toFixed(1)} MB`;
  const ago = (ts?: number | null) => {
    if (!ts) return '—';
    const s = Math.round((Date.now() - ts) / 1000);
    return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
  };
</script>

<section>
  <h2>Status</h2>
  {#if $status && $stats}
    <div class="grid">
      <div class="card" data-testid="card-camera">
        <h3>Camera</h3>
        <dl>
          <dt>State</dt><dd class={$status.camera.online ? 'ok' : 'bad'}>{$status.camera.online ? 'online' : 'offline'}</dd>
          <dt>Since</dt><dd>{ago($status.camera.since)}</dd>
          <dt>Model</dt><dd>{$status.camera.model ?? '—'}</dd>
          <dt>Firmware</dt><dd>{$status.camera.firmware ?? '—'}</dd>
          <dt>Clock offset</dt><dd>{$status.camera.clockOffsetMs === undefined ? '—' : `${($status.camera.clockOffsetMs / 1000).toFixed(1)} s`}</dd>
          {#if $status.camera.error}<dt>Last error</dt><dd class="bad">{$status.camera.error}</dd>{/if}
        </dl>
      </div>
      <div class="card" data-testid="card-intake">
        <h3>Events</h3>
        <dl>
          <dt>ONVIF</dt><dd class={$status.intake.onvif === 'subscribed' ? 'ok' : 'bad'} data-testid="onvif-state">{$status.intake.onvif}</dd>
          <dt>Source</dt><dd>{$status.intake.source}</dd>
          <dt>Re-subscriptions</dt><dd>{$status.intake.resubscribes}</dd>
          {#if $status.intake.lastError}<dt>Last error</dt><dd class="bad">{$status.intake.lastError}</dd>{/if}
          {#each Object.entries($stats.events.stored) as [kind, n] (kind)}<dt>{kind} events</dt><dd>{n}</dd>{/each}
        </dl>
      </div>
      <div class="card" data-testid="card-storage">
        <h3>Storage</h3>
        <dl>
          <dt>Catalog</dt><dd>{mb($stats.disk.catalog.bytes)}</dd>
          <dt>Disk free</dt><dd>{gb($stats.disk.free)} of {gb($stats.disk.size)}</dd>
          <dt>Budget</dt><dd>{gb($stats.storage.budget)}</dd>
          <dt>Last retention</dt><dd>{ago($status.retention.lastRun)}</dd>
        </dl>
      </div>
      <div class="card">
        <h3>Stream</h3>
        <dl>
          <dt>SSE clients</dt><dd>{$status.sse.clients}</dd>
          <dt>Stream log rows</dt><dd>{$stats.stream.rows}</dd>
          <dt>Last id</dt><dd>{$stats.stream.lastId}</dd>
          <dt>Version</dt><dd>{$status.version}</dd>
        </dl>
      </div>
    </div>
  {:else}
    <p class="muted">Loading…</p>
  {/if}
</section>

<style>
  section { display: grid; gap: 12px; }
  h2 { margin: 0; font-size: 20px; }
  h3 { margin: 0 0 8px; font-size: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; margin: 0; font-size: 14px; }
  dt { color: var(--muted); } dd { margin: 0; font-family: var(--mono); text-align: right; }
  .ok { color: #22c55e; } .bad { color: var(--danger); }
  .muted { color: var(--muted); }
</style>
