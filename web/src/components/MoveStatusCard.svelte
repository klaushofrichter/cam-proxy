<script lang="ts">
  import { api, ApiError } from '../lib/api';
  import { loadMoves } from '../lib/move-state';
  import { OVER_BUDGET_TEXT, statusLine, type MoveItem } from '../lib/moves';
  import { lockedWhy, rights } from '../lib/rights';

  // A move in progress, for both roles (camera-move plan Task 11). Cancel
  // asks what to do with what was already copied on the target.
  let { move, name }: { move: MoveItem; name: string } = $props();
  const copying = $derived(['released', 'copying', 'copied'].includes(move.phase));
  const locked = $derived(lockedWhy($rights, 'move'));
  let asking = $state(false);
  let copied = $state<'delete' | 'age-out'>('age-out');
  let error = $state('');
  async function cancel() {
    error = '';
    try {
      await api('POST', `/control/moves/${move.id}/cancel`, { copied: copying ? copied : 'age-out' });
      asking = false;
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Not cancelled.';
    }
    await loadMoves();
  }
</script>

<div class="card" data-testid="card-move">
  <h3>Camera move</h3>
  <p class={move.phase === 'failed' ? 'bad' : ''} data-testid="move-status">{statusLine(move, name)}</p>
  {#if move.budgetExceeded}<p class="warn" data-testid="move-over-budget">{OVER_BUDGET_TEXT}</p>{/if}
  {#if error}<p class="bad small" data-testid="move-cancel-error">{error}</p>{/if}
  {#if move.id && move.phase !== 'failed'}
    {#if !asking}
      <button onclick={() => (asking = true)} disabled={!!locked} title={locked ?? undefined} data-testid="move-cancel">Cancel move…</button>
    {:else}
      <div class="ask" data-testid="move-cancel-ask">
        {#if copying}
          <label><input type="radio" name="move-copied" checked={copied === 'delete'} onchange={() => (copied = 'delete')} data-testid="move-copied-delete" /> Delete what was copied on {move.target.name}</label>
          <p class="muted small" data-testid="move-copied-hint">Only what this move copied is deleted; what {move.target.name} captured itself since the switch-over stays and ages out.</p>
          <label><input type="radio" name="move-copied" checked={copied === 'age-out'} onchange={() => (copied = 'age-out')} data-testid="move-copied-age-out" /> Let it age out there</label>
        {:else}
          <p>Stop this move?</p>
        {/if}
        <div class="buttons">
          <button onclick={() => (asking = false)} data-testid="move-cancel-back">Keep moving</button>
          <button class="danger" onclick={() => void cancel()} data-testid="move-cancel-confirm">Cancel move</button>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; gap: 8px; align-content: start; min-width: 0; }
  h3 { margin: 0; font-size: 16px; }
  p { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
  .bad { color: var(--danger); } .warn { color: #f59e0b; } .muted { color: var(--muted); } .small { font-size: 13px; }
  .ask { display: grid; gap: 6px; font-size: 14px; }
  .buttons { display: flex; gap: 8px; }
  button { padding: 7px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); justify-self: start; }
  button.danger { border-color: var(--danger); color: var(--danger); }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
