<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import { feed, refreshTick, status } from '../lib/state';

  interface Ev { id: number; kind: string; source: string; start: number; end: number | null; endReason: string | null }
  let events = $state<Ev[]>([]);
  const time = (ts: number | null) => (ts ? new Date(ts).toLocaleTimeString() : '…');
  const load = async () => {
    try {
      const cams = await api<Array<{ id: string }>>('GET', '/api/cameras');
      if (!cams[0]) return;
      events = await api<Ev[]>('GET', `/api/cameras/${encodeURIComponent(cams[0].id)}/events?limit=100`);
    } catch {
      // keep the last list
    }
  };
  onMount(() => void load());
  $effect(() => {
    if ($feed.length || $refreshTick) void load();
  });
</script>

<section>
  <h2>Events</h2>
  <div class="card">
    <h3>Live stream</h3>
    <p class="muted small">Camera events and status changes as they arrive (SSE, resumes after a drop). {$status ? `ONVIF: ${$status.intake.onvif}` : ''}</p>
    <div class="log">
      <table>
        <thead><tr><th>id</th><th>time</th><th>type</th><th>detail</th></tr></thead>
        <tbody data-testid="feed">
          {#each $feed as f (f.id)}
            <tr data-testid="feed-row">
              <td class="mono">{f.id}</td>
              <td>{new Date(f.at).toLocaleTimeString()}</td>
              <td>{f.type}</td>
              <td class="mono">{f.type === 'camera-event' ? `${f.data.kind} ${f.data.phase} (${f.data.source})` : JSON.stringify(f.data)}</td>
            </tr>
          {:else}
            <tr><td colspan="4" class="muted">Nothing yet.</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
  <div class="card">
    <h3>Last 100 events</h3>
    <table>
      <thead><tr><th>kind</th><th>start</th><th>end</th><th>source</th></tr></thead>
      <tbody data-testid="events">
        {#each events as e (e.id)}
          <tr><td>{e.kind}</td><td>{time(e.start)}</td><td>{time(e.end)}{e.endReason && e.endReason !== 'state' ? ` (${e.endReason})` : ''}</td><td>{e.source}</td></tr>
        {:else}
          <tr><td colspan="4" class="muted">No events stored.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<style>
  section { display: grid; gap: 12px; }
  h2 { margin: 0; font-size: 20px; }
  h3 { margin: 0 0 6px; font-size: 16px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; gap: 8px; }
  .log { max-height: 360px; overflow: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--muted); font-weight: 600; position: sticky; top: 0; background: var(--surface); }
  td, th { padding: 4px 8px; border-bottom: 1px solid var(--border); }
  .mono { font-family: var(--mono); }
  .muted { color: var(--muted); margin: 0; }
  .small { font-size: 13px; }
</style>
