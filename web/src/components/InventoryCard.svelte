<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { clipsLines, gapRows, mb, progressText, repairLines, repairOffer, repairRows, stillsLines, stillsNotes, type ClipsReport, type InventoryState, type RepairReport, type StillsReport } from '../lib/inventory';

  // The inventories (spec 2026-10-02-inventory-design): start one, follow its
  // progress (polled every second while it runs), cancel it, and show the
  // newest report of each kind and the newest clips repair. One run at a
  // time per proxy. The repair is offered under a compare with the camera
  // (its dry run) less than an hour old.
  // The repair is confirmed by the Maintenance page's shared dialog (onrepair
  // hands it the dry-run numbers); fetchLost() runs after the confirm.
  let { onrepair }: { onrepair: (offer: { count: number; bytes: number }) => void } = $props();
  let inv = $state<InventoryState | null>(null)
  let stills = $state<StillsReport | null>(null);
  let clips = $state<ClipsReport | null>(null);
  let repair = $state<RepairReport | null>(null);
  let message = $state('');
  let starting = $state(false);
  let cancelling = $state(false);
  let now = $state(Date.now());
  const busy = $derived(!!inv?.running);
  const offer = $derived(repairOffer(clips, now));

  const fetchReport = <T,>(runId: string) => api<T>('GET', `/control/inventory/runs/${encodeURIComponent(runId)}`);
  async function load() {
    const s = await api<InventoryState>('GET', '/control/inventory');
    inv = s;
    now = Date.now();
    const st = s.runs.stills?.[0];
    if (st && st.runId !== stills?.runId) stills = await fetchReport<StillsReport>(st.runId);
    const cl = s.runs.clips?.[0];
    if (cl && cl.runId !== clips?.runId) clips = await fetchReport<ClipsReport>(cl.runId);
    const rp = s.repairs?.clips?.[0];
    if (rp && rp.runId !== repair?.runId) repair = await fetchReport<RepairReport>(rp.runId);
  }
  const reload = () => load().catch(() => (message = 'Could not load the inventory.'));
  onMount(() => {
    void reload();
    // The offer's one hour runs out while the page stays open.
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });
  $effect(() => {
    if (!busy) return;
    const t = setInterval(() => void reload(), 1000);
    return () => clearInterval(t);
  });

  async function post(path: string, body: object, label: string) {
    if (starting || busy) return;
    starting = true;
    message = '';
    try {
      await api('POST', path, body);
    } catch (e) {
      message = `${label}: ${e instanceof ApiError ? e.message : 'failed'}`;
    }
    starting = false;
    cancelling = false;
    await reload();
  }
  const start = (kind: string, camera = false) => post('/control/actions/inventory', camera ? { kind, camera } : { kind }, 'Inventory');
  export const fetchLost = () => clips && post('/control/actions/inventory-repair', { kind: 'clips', runId: clips.runId }, 'Repair');
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
  <p class="small">Checks the local stills and clips against what the store should hold for the retention window. "Compare clips with the camera" also reads the camera's SD card list, and a repair fetches lost clips from it. One run at a time.</p>
  <div class="buttons">
    <button onclick={() => void start('stills')} disabled={starting || busy} data-testid="inventory-stills">Check stills</button>
    <button onclick={() => void start('clips')} disabled={starting || busy} data-testid="inventory-clips">Check clips</button>
    <button onclick={() => void start('clips', true)} disabled={starting || busy} data-testid="inventory-clips-camera">Compare clips with the camera</button>
    {#if busy}<button onclick={() => void cancel()} disabled={cancelling} data-testid="inventory-cancel">{cancelling ? 'Cancelling…' : 'Cancel'}</button>{/if}
  </div>
  {#if inv?.running}<p class="busy" role="status" data-testid="inventory-progress">{progressText(inv.running)}</p>{/if}
  {#if message}<p class="bad" role="alert" data-testid="inventory-message">{message}</p>{/if}
  {#if stills}
    <div class="result" data-testid="inventory-result">
      <p class="line">{stills.message}</p>
      <p class="small">{new Date(stills.startedAt).toLocaleString()}, took {(stills.tookMs / 1000).toFixed(1)} s</p>
      <ul>
        {#each stillsLines(stills) as l, i (i)}<li>{l}</li>{/each}
      </ul>
      {#each stillsNotes(stills) as n, i (i)}<p class="small" data-testid="inventory-note">{n}</p>{/each}
      {#if stills.top.length}
        <table data-testid="inventory-gaps">
          <thead><tr><th>from</th><th>to</th><th>length</th><th>cause</th></tr></thead>
          <tbody>
            {#each gapRows(stills) as g, i (i)}<tr><td class="mono">{g.from}</td><td class="mono">{g.to}</td><td>{g.length}</td><td>{g.why}</td></tr>{/each}
          </tbody>
        </table>
      {/if}
    </div>
  {/if}
  {#if clips}
    <div class="result" data-testid="inventory-clips-result">
      <p class="line">{clips.message}</p>
      <p class="small">{new Date(clips.startedAt).toLocaleString()}, took {(clips.tookMs / 1000).toFixed(1)} s</p>
      <ul>
        {#each clipsLines(clips) as l, i (i)}<li>{l}</li>{/each}
      </ul>
      {#each clips.window?.notes ?? [] as n, i (i)}<p class="small">{n}</p>{/each}
      {#if clips.top.length}
        <table data-testid="inventory-clips-days">
          <thead><tr><th>camera day</th><th>recordings</th><th>missing here</th><th>gone from camera</th></tr></thead>
          <tbody>
            {#each clips.top as d (d.date)}<tr><td class="mono">{d.date}</td><td>{d.state === 'unknown' ? 'unknown' : d.recordings}</td><td>{d.missingLocally}</td><td>{d.goneFromCamera}</td></tr>{/each}
          </tbody>
        </table>
      {/if}
      {#if !offer && clips.outcome === 'ok' && clips.options?.camera && clips.counts.missingLocally}
        <p class="small" data-testid="inventory-repair-stale">Compare again first: a repair needs a compare less than an hour old.</p>
      {/if}
      {#if offer}
        <div class="buttons">
          <button onclick={() => onrepair(offer)} disabled={starting || busy} data-testid="inventory-repair">Fetch {offer.count} lost clips ({mb(offer.bytes)})</button>
        </div>
        <p class="small">Fetches them from the camera's SD card over Baichuan, one at a time, after any viewer's download; at most 50 clips or 200 MB per run.</p>
      {/if}
    </div>
  {/if}
  {#if repair}
    <div class="result" data-testid="inventory-repair-result">
      <p class="line">{repair.message}</p>
      <p class="small">{new Date(repair.startedAt).toLocaleString()}, took {(repair.tookMs / 1000).toFixed(1)} s</p>
      <ul>
        {#each repairLines(repair) as l, i (i)}<li>{l}</li>{/each}
      </ul>
      {#if repair.top.length}
        <table>
          <thead><tr><th>recording</th><th>failure</th></tr></thead>
          <tbody>
            {#each repairRows(repair) as f, i (i)}<tr><td class="mono">{f.at}</td><td>{f.error}</td></tr>{/each}
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
