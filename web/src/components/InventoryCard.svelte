<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { gapRows, progressText, stillsLines, stillsNotes, type InventoryState, type StillsReport } from '../lib/inventory';

  // The inventories (spec 2026-10-02-inventory-design): start one, follow its
  // progress (polled every second while it runs), cancel it, and show the
  // newest stills report. One run at a time per proxy.
  let inv = $state<InventoryState | null>(null);
  let report = $state<StillsReport | null>(null);
  let message = $state('');
  let starting = $state(false);
  let cancelling = $state(false);
  const busy = $derived(!!inv?.running);

  async function load() {
    const s = await api<InventoryState>('GET', '/control/inventory');
    inv = s;
    const last = s.runs.stills?.[0];
    if (last && last.runId !== report?.runId) report = await api<StillsReport>('GET', `/control/inventory/runs/${encodeURIComponent(last.runId)}`);
  }
  const reload = () => load().catch(() => (message = 'Could not load the inventory.'));
  onMount(() => void reload());
  $effect(() => {
    if (!busy) return;
    const t = setInterval(() => void reload(), 1000);
    return () => clearInterval(t);
  });

  async function start() {
    if (starting || busy) return;
    starting = true;
    message = '';
    try {
      await api('POST', '/control/actions/inventory', { kind: 'stills' });
    } catch (e) {
      message = `Inventory: ${e instanceof ApiError ? e.message : 'failed'}`;
    }
    starting = false;
    cancelling = false;
    await reload();
  }
  async function cancel() {
    cancelling = true;
    try {
      await api('POST', '/control/actions/inventory-cancel');
    } catch (e) {
      message = `Cancel: ${e instanceof ApiError ? e.message : 'failed'}`;
    }
    await reload();
    if (!inv?.running) cancelling = false;
  }
</script>

<div class="card" data-testid="inventory">
  <h3>Inventory</h3>
  <p class="small">Checks the local stills against what the store should hold for the retention window; it never contacts the camera. One run at a time.</p>
  <div class="buttons">
    <button onclick={() => void start()} disabled={starting || busy} data-testid="inventory-stills">Check stills</button>
    {#if busy}<button onclick={() => void cancel()} disabled={cancelling} data-testid="inventory-cancel">{cancelling ? 'Cancelling…' : 'Cancel'}</button>{/if}
  </div>
  {#if inv?.running}<p class="busy" role="status" data-testid="inventory-progress">{progressText(inv.running)}</p>{/if}
  {#if message}<p class="bad" role="alert" data-testid="inventory-message">{message}</p>{/if}
  {#if report}
    <div class="result" data-testid="inventory-result">
      <p class="line">{report.message}</p>
      <p class="small">{new Date(report.startedAt).toLocaleString()}, took {(report.tookMs / 1000).toFixed(1)} s</p>
      <ul>
        {#each stillsLines(report) as l, i (i)}<li>{l}</li>{/each}
      </ul>
      {#each stillsNotes(report) as n, i (i)}<p class="small" data-testid="inventory-note">{n}</p>{/each}
      {#if report.top.length}
        <table data-testid="inventory-gaps">
          <thead><tr><th>from</th><th>to</th><th>length</th><th>cause</th></tr></thead>
          <tbody>
            {#each gapRows(report) as g, i (i)}<tr><td class="mono">{g.from}</td><td class="mono">{g.to}</td><td>{g.length}</td><td>{g.why}</td></tr>{/each}
          </tbody>
        </table>
      {/if}
    </div>
  {/if}
</div>

<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; gap: 8px; }
  h3 { margin: 0; font-size: 16px; }
  p { margin: 0; }
  ul { margin: 0; padding-left: 18px; }
  .result { display: grid; gap: 6px; }
  .line { font-weight: 600; }
  .small { font-size: 13px; color: var(--muted); }
  .busy { color: var(--accent); font-weight: 600; }
  .bad { color: var(--danger); }
  .mono { font-family: var(--mono); }
  .buttons { display: flex; flex-wrap: wrap; gap: 8px; }
  button { padding: 7px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); }
  button:hover { border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: default; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--border); }
</style>
