<script lang="ts">
  import { api, ApiError } from '../lib/api';
  import { loadMoves } from '../lib/move-state';
  import { localDate } from '../lib/format';
  import { autoWaitText, budgetDefault, estimateText, KIND_LABEL, kindsWithContent, limitText, planFrom, sizeText, spaceOptions, type MoveItem, type MoveKind } from '../lib/moves';

  // The one confirmation panel (camera-move spec §7): what moves, what does
  // not fit and how to cope, the time, and the end. Approving is the only approval.
  let { move, name, onclose }: { move: MoveItem; name: string; onclose: () => void } = $props();
  const summary = $derived(move.summary!);
  const space = $derived(move.answer?.space);
  const estimateS = $derived(move.answer?.estimateS ?? 0);
  const target = $derived(move.target.name);
  const options = $derived(spaceOptions(space));
  const kinds = $derived(kindsWithContent(summary));
  let transfer = $state(true);
  let leaveOut = $state<MoveKind[]>([]);
  let option = $state<'omit' | 'retention' | 'fit'>('fit');
  let budgetEdited = $state<number | null>(null);
  const minBudget = $derived(budgetDefault(estimateS));
  const budgetMin = $derived(budgetEdited ?? minBudget);
  let busy = $state(false);
  let error = $state('');
  // No transfer needs no time: the budget is the estimate.
  const built = $derived(planFrom({ transfer, leaveOut, option, budgetMin: transfer ? budgetMin : estimateS / 60, estimateS, summary, space }));
  const flat = $derived(Object.entries(move.settings ?? {}).flatMap(([k, v]) => (v !== null && typeof v === 'object' ? Object.entries(v).flatMap(([k2, v2]) => (v2 !== null && typeof v2 === 'object' ? Object.entries(v2).map(([k3, v3]) => [`${k}.${k2}.${k3}`, v3] as const) : [[`${k}.${k2}`, v2] as const])) : [[k, v] as const])));
  const proposal = $derived(Object.entries(space?.retentionProposal ?? {}));
  const toggle = (k: MoveKind) => (leaveOut = leaveOut.includes(k) ? leaveOut.filter((x) => x !== k) : [...leaveOut, k]);
  const day = (ts: number | null) => (ts ? localDate(ts) : '—');

  async function approve() {
    if (!built.plan || busy) return;
    busy = true;
    error = '';
    try {
      await api('POST', `/control/moves/${move.id}/approve`, { plan: built.plan });
      await loadMoves();
      onclose();
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Not approved.';
    }
    busy = false;
  }
  async function cancel() {
    try {
      await api('POST', `/control/moves/${move.id}/cancel`, { copied: 'age-out' });
    } catch {
      // The offer may have expired already; the list shows what is left.
    }
    await loadMoves();
    onclose();
  }
</script>

<div class="card" data-testid="move-panel">
  <h3>Move {name} to {target}</h3>
  {#if move.autoApproval?.state === 'waiting' && move.autoApproval.reason}<p class="warn small" data-testid="move-auto-wait">{autoWaitText(move.autoApproval.reason)}</p>{/if}
  <h4>Settings that move with the camera</h4>
  <dl data-testid="move-settings">
    {#each flat as [k, v] (k)}<dt>{k}</dt><dd>{String(v)}</dd>{/each}
  </dl>
  <fieldset class="row">
    <legend>Transfer content</legend>
    <label><input type="radio" name="move-transfer" checked={transfer} onchange={() => (transfer = true)} data-testid="move-transfer-yes" /> Yes</label>
    <label><input type="radio" name="move-transfer" checked={!transfer} onchange={() => (transfer = false)} data-testid="move-transfer-no" /> No</label>
  </fieldset>
  {#if transfer}
    <table data-testid="move-content">
      <thead><tr><th>Kind</th><th>Size</th><th>Files</th><th>From</th><th>To</th></tr></thead>
      <tbody>
        {#each kinds as k (k)}
          <tr data-testid="move-kind-{k}"><td>{KIND_LABEL[k]}</td><td>{sizeText(summary[k].bytes)}</td><td>{summary[k].files}</td><td>{day(summary[k].oldest)}</td><td>{day(summary[k].newest)}</td></tr>
        {/each}
      </tbody>
    </table>
    {#if space && !space.fits}
      <p class="warn" data-testid="move-short">Not everything fits on {target} ({sizeText(space.needed)} needed, {sizeText(space.available)} free).</p>
      <div class="choices">
        {#if options.includes('omit')}
          <div>
            <label><input type="radio" name="move-option" checked={option === 'omit'} onchange={() => (option = 'omit')} data-testid="move-option-omit" /> Leave out:</label>
            {#each kinds as k (k)}<label class="inline"><input type="checkbox" checked={leaveOut.includes(k)} onchange={() => toggle(k)} disabled={option !== 'omit'} data-testid="move-leave-{k}" /> {KIND_LABEL[k]}</label>{/each}
          </div>
        {/if}
        {#if options.includes('retention')}
          <div>
            <label><input type="radio" name="move-option" checked={option === 'retention'} onchange={() => (option = 'retention')} data-testid="move-option-retention" /> Raise the limits on {target}</label>
            <ul data-testid="move-limits">{#each proposal as [k, v] (k)}<li>{limitText(k, Number(v))}</li>{/each}</ul>
          </div>
        {/if}
        <div><label><input type="radio" name="move-option" checked={option === 'fit'} onchange={() => (option = 'fit')} data-testid="move-option-fit" /> Copy as much as fits, newest first</label></div>
      </div>
    {/if}
    <p data-testid="move-estimate">Estimated time: {estimateText(estimateS)}</p>
    <label class="budget">Time budget (minutes)
      <input type="number" min={minBudget} step="1" value={budgetMin} oninput={(e) => (budgetEdited = e.currentTarget.valueAsNumber)} data-testid="move-budget" />
    </label>
  {/if}
  <p class="muted small">When the move ends, this proxy deletes all of this camera's content, copied or not. Audit records stay.</p>
  {#if built.error}<p class="bad small" data-testid="move-plan-problem">{built.error}</p>{/if}
  {#if error}<p class="bad small" data-testid="move-error">{error}</p>{/if}
  <div class="buttons">
    <button onclick={() => void cancel()} data-testid="move-panel-cancel">Cancel</button>
    <button class="primary" onclick={() => void approve()} disabled={!built.plan || busy} data-testid="move-approve">Approve move</button>
  </div>
</div>

<style>
  .card { background: var(--surface); border: 1px solid var(--accent); border-radius: var(--radius); padding: 16px; display: grid; gap: 10px; overflow-x: auto; }
  h3 { margin: 0; font-size: 16px; }
  h4 { margin: 0; font-size: 14px; }
  p { margin: 0; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 0; font-size: 13px; }
  dt { color: var(--muted); font-family: var(--mono); } dd { margin: 0; font-family: var(--mono); }
  fieldset { border: none; padding: 0; margin: 0; display: flex; gap: 12px; align-items: baseline; }
  legend { float: left; padding: 0; margin-right: 12px; font-size: 14px; }
  table { border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 4px 10px 4px 0; border-bottom: 1px solid var(--border); }
  .choices { display: grid; gap: 8px; font-size: 14px; }
  .choices ul { margin: 4px 0 0; padding-left: 28px; font-family: var(--mono); font-size: 13px; }
  .inline { margin-left: 12px; }
  .warn { color: #f59e0b; }
  .bad { color: var(--danger); }
  .muted { color: var(--muted); }
  .small { font-size: 13px; }
  .budget { display: flex; gap: 8px; align-items: center; font-size: 14px; }
  .budget input { width: 90px; padding: 4px 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  button { padding: 7px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; }
  button.primary { border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
