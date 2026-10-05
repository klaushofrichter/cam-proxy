<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { api, apiLines } from '../lib/api';
  import { ACTIONS, actionsParam, auditQuery, filterLabel, isAll, outcomeClass, retentionLine, toggleAction, toggleAll, who } from '../lib/audit';
  import { refreshTick } from '../lib/state';

  type Rec = Record<string, any>;
  const PAGE = 50;
  let records = $state<Rec[]>([]);
  let hasMore = $state(false);
  let next = $state<string | null>(null);
  let stack = $state<(string | undefined)[]>([]); // the `before` cursors of the pages above
  let before = $state<string | undefined>(undefined);
  let selected = $state<string[]>([...ACTIONS]); // the action filter; all = no filter
  let summary = $state<{ retentionDays: number; records: number } | null>(null);
  let outcome = $state('');
  let open = $state<string | null>(null);
  let message = $state('');

  // `seq` drops a late answer for an old filter or page; `loading` stops a
  // double click on Older/Newer from pushing the same cursor twice.
  let seq = 0;
  let loading = $state(false);
  async function load() {
    const my = ++seq;
    message = '';
    void loadSummary();
    // No action selected: nothing to show, nothing to ask.
    if (actionsParam(selected) === null) {
      records = [];
      hasMore = false;
      next = null;
      loading = false;
      return;
    }
    loading = true;
    try {
      const r = await apiLines<Rec>(`/control/audit?${auditQuery({ limit: PAGE, before, actions: selected, outcome })}`);
      if (my !== seq) return;
      records = r.records;
      hasMore = r.hasMore;
      next = r.next;
    } catch {
      if (my !== seq) return;
      records = [];
      hasMore = false;
      next = null;
      message = 'Could not load the audit log.';
    } finally {
      if (my === seq) loading = false;
    }
  }
  // How long records are kept and how many are (all actions, not the filter).
  async function loadSummary() {
    try {
      summary = await api<{ retentionDays: number; records: number }>('GET', '/control/audit/summary');
    } catch {
      /* the line falls back to the setting's name */
    }
  }
  function newest() { stack = []; before = undefined; open = null; void load(); }
  function older() { if (loading || !hasMore || !next) return; stack = [...stack, before]; before = next; open = null; void load(); }
  function newer() { if (loading || !stack.length) return; before = stack.at(-1); stack = stack.slice(0, -1); open = null; void load(); }
  onMount(() => void load());
  $effect(() => { if ($refreshTick) untrack(() => void load()); });
  const time = (iso: string) => new Date(iso).toLocaleString();

  // The action filter: a button opening a list of checkboxes. Space toggles,
  // the arrow keys move, Esc (or a click outside) closes it.
  let menuOpen = $state(false);
  let filterEl = $state<HTMLDivElement>();
  let filterButton = $state<HTMLButtonElement>();
  const none = $derived(selected.length === 0);
  function choose(next: string[]) { selected = next; newest(); }
  function openMenu() {
    menuOpen = !menuOpen;
    if (menuOpen) void tick().then(() => filterEl?.querySelector<HTMLInputElement>('input')?.focus());
  }
  function closeMenu(refocus: boolean) {
    menuOpen = false;
    if (refocus) filterButton?.focus();
  }
  function menuKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const boxes = [...(filterEl?.querySelectorAll<HTMLInputElement>('input') ?? [])];
    const i = boxes.indexOf(document.activeElement as HTMLInputElement);
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? boxes.length - 1 : e.key === 'ArrowDown' ? Math.min(boxes.length - 1, i + 1) : Math.max(0, i - 1);
    boxes[n]?.focus();
    e.preventDefault();
  }
</script>

<svelte:window onclick={(e) => { if (menuOpen && filterEl && !filterEl.contains(e.target as Node)) closeMenu(false); }} />

<section>
  <div class="head">
    <h2>Audit</h2>
    <div class="filter" bind:this={filterEl} onfocusout={(e) => { if (menuOpen && !filterEl?.contains(e.relatedTarget as Node | null) && e.relatedTarget) closeMenu(false); }}>
      <button bind:this={filterButton} class="filter-button" onclick={openMenu} aria-haspopup="true" aria-expanded={menuOpen} aria-controls="audit-actions-menu" data-testid="audit-filter-action"><span class="sr">Actions: </span>{filterLabel(selected)} <span aria-hidden="true">▾</span></button>
      {#if menuOpen}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div id="audit-actions-menu" class="menu" role="group" aria-label="Actions to show" onkeydown={menuKey} data-testid="audit-actions-menu">
          <label class="all"><input type="checkbox" checked={isAll(selected)} indeterminate={!none && !isAll(selected)} onchange={() => choose(toggleAll(selected))} data-testid="audit-action-all" /> All actions</label>
          {#each ACTIONS as a (a)}
            <label><input type="checkbox" checked={selected.includes(a)} onchange={() => choose(toggleAction(selected, a))} data-testid="audit-action-{a}" /> {a}</label>
          {/each}
        </div>
      {/if}
    </div>
    <select bind:value={outcome} onchange={(e) => { outcome = e.currentTarget.value; newest(); }} data-testid="audit-filter-outcome" aria-label="Outcome">
      <option value="">Any outcome</option><option value="success">success</option><option value="failure">failure</option><option value="unknown">unknown</option>
    </select>
    <span class="spacer"></span>
    <button onclick={newest} disabled={loading || !stack.length} data-testid="audit-newest">Newest</button>
    <button onclick={newer} disabled={loading || !stack.length} data-testid="audit-newer">◀ Newer</button>
    <button onclick={older} disabled={loading || !hasMore} data-testid="audit-older">Older ▶</button>
  </div>
  <p class="muted small" data-testid="audit-retention">Who did what on this proxy, newest first, 50 per page. {retentionLine(summary)}</p>
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
          {#if none}
            <tr><td colspan="5" class="muted" data-testid="audit-none">No actions selected: choose actions in the filter (All actions selects them all).</td></tr>
          {:else}
            <tr><td colspan="5" class="muted" data-testid="audit-empty">No audit records yet.</td></tr>
          {/if}
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
  .filter { position: relative; }
  .filter-button { min-width: 150px; text-align: left; }
  .menu { position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; min-width: 220px; max-height: min(60vh, 420px); overflow-y: auto; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 6px; box-shadow: 0 8px 24px rgb(0 0 0 / 0.25); display: grid; }
  .menu label { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px; font-size: 14px; cursor: pointer; white-space: nowrap; }
  .menu label:hover, .menu label:focus-within { background: var(--surface-2); }
  .menu label.all { font-weight: 600; border-bottom: 1px solid var(--border); border-radius: 6px 6px 0 0; margin-bottom: 4px; position: sticky; top: -6px; background: var(--surface); z-index: 1; }
  .menu label.all:hover, .menu label.all:focus-within { background: var(--surface-2); }
  .menu input { accent-color: var(--accent); margin: 0; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
