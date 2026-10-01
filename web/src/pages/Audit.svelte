<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { apiLines } from '../lib/api';
  import { ACTIONS, auditQuery, outcomeClass, who } from '../lib/audit';
  import { refreshTick } from '../lib/state';

  type Rec = Record<string, any>;
  const PAGE = 50;
  let records = $state<Rec[]>([]);
  let hasMore = $state(false);
  let next = $state<string | null>(null);
  let stack = $state<(string | undefined)[]>([]); // the `before` cursors of the pages above
  let before = $state<string | undefined>(undefined);
  let action = $state('');
  let outcome = $state('');
  let open = $state<string | null>(null);
  let message = $state('');

  async function load() {
    message = '';
    try {
      const r = await apiLines<Rec>(`/control/audit?${auditQuery({ limit: PAGE, before, action, outcome })}`);
      records = r.records;
      hasMore = r.hasMore;
      next = r.next;
    } catch {
      message = 'Could not load the audit log.';
    }
  }
  function newest() { stack = []; before = undefined; open = null; void load(); }
  function older() { if (!hasMore || !next) return; stack = [...stack, before]; before = next; open = null; void load(); }
  function newer() { if (!stack.length) return; before = stack.at(-1); stack = stack.slice(0, -1); open = null; void load(); }
  onMount(() => void load());
  $effect(() => { if ($refreshTick) untrack(() => void load()); });
  const time = (iso: string) => new Date(iso).toLocaleString();
</script>

<section>
  <div class="head">
    <h2>Audit</h2>
    <select bind:value={action} onchange={newest} data-testid="audit-filter-action" aria-label="Action">
      <option value="">All actions</option>
      {#each ACTIONS as a (a)}<option value={a}>{a}</option>{/each}
    </select>
    <select bind:value={outcome} onchange={newest} data-testid="audit-filter-outcome" aria-label="Outcome">
      <option value="">Any outcome</option><option value="success">success</option><option value="failure">failure</option><option value="unknown">unknown</option>
    </select>
    <span class="spacer"></span>
    <button onclick={newest} disabled={!stack.length} data-testid="audit-newest">Newest</button>
    <button onclick={newer} disabled={!stack.length} data-testid="audit-newer">◀ Newer</button>
    <button onclick={older} disabled={!hasMore} data-testid="audit-older">Older ▶</button>
  </div>
  <p class="muted small">Who did what on this proxy, newest first, 50 per page. Kept for retention.auditDays days (Settings).</p>
  {#if message}<p class="muted">{message}</p>{/if}
  <div class="card">
    <table data-testid="audit-table">
      <thead><tr><th>time</th><th>action</th><th></th><th>who</th><th>summary</th></tr></thead>
      <tbody>
        {#each records as r (r.cam_proxy?.cursor)}
          {@const id = r.cam_proxy?.cursor}
          <tr class="row" data-testid="audit-row" data-action={r.event?.action} tabindex="0" aria-expanded={open === id}
            onclick={() => (open = open === id ? null : id)} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open = open === id ? null : id; } }}>
            <td class="mono">{time(r['@timestamp'])}</td>
            <td>{r.event?.action}</td>
            <td><span class="dot {outcomeClass(r)}" title={r.event?.outcome}></span></td>
            <td>{who(r)}</td>
            <td>{r.message}</td>
          </tr>
          {#if open === id}
            <tr><td colspan="5"><pre data-testid="audit-row-json">{JSON.stringify(r, null, 2)}</pre></td></tr>
          {/if}
        {:else}
          <tr><td colspan="5" class="muted" data-testid="audit-empty">No audit records yet.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<style>
  section { display: grid; gap: 12px; }
  .head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  h2 { margin: 0; font-size: 20px; }
  .spacer { flex: 1; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 12px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  .row { cursor: pointer; }
  .row:hover, .row:focus-visible { background: var(--surface-2); outline: none; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--muted); }
  .dot.ok { background: #22c55e; } .dot.bad { background: #ef4444; }
  pre { margin: 0; font-size: 12px; white-space: pre-wrap; word-break: break-word; font-family: var(--mono); }
  .mono { font-family: var(--mono); white-space: nowrap; }
  .muted { color: var(--muted); margin: 0; }
  .small { font-size: 13px; }
  select, button { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
