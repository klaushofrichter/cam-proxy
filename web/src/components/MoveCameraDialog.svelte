<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { loadMoves } from '../lib/move-state';
  import { refusalText, rejectText, type MoveItem } from '../lib/moves';

  // Step 1 of moving a camera (camera-move plan Task 11): pick the target
  // among the account's online proxies (asked of cams-admin), then wait for
  // its answer. An accepted offer closes the dialog: the Settings page shows
  // the confirmation panel for it. A rejection stays here, with its reason.
  let { camera, name, address, onclose }: { camera: string; name: string; address: string; onclose: () => void } = $props();
  type Target = { proxyId: string; name: string };
  let targets = $state<Target[] | null>(null);
  let chosen = $state('');
  let step = $state<'pick' | 'asking' | 'rejected'>('pick');
  let problem = $state('');
  let rejected = $state('');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const targetName = $derived(targets?.find((t) => t.proxyId === chosen)?.name ?? '');
  const say = (e: unknown) => {
    if (e instanceof ApiError) {
      const b = e.body as { error?: string; reason?: string } | null;
      return b?.error === 'move_refused' && b.reason ? refusalText(b.reason) : e.message;
    }
    return 'Not reachable.';
  };

  onMount(() => {
    void (async () => {
      try {
        const { requestId } = await api<{ requestId: string }>('POST', '/control/moves/targets', { camera });
        for (let i = 0; i < 40 && !stopped; i++) {
          const r = await api<{ targets: Target[] | null }>('GET', `/control/moves/targets/${requestId}`);
          if (r.targets) {
            targets = r.targets;
            chosen = r.targets[0]?.proxyId ?? '';
            return;
          }
          await new Promise((res) => (timer = setTimeout(res, 1000)));
        }
        if (!stopped) problem = 'cams-admin did not answer.';
      } catch (e) {
        problem = say(e);
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  });

  async function cont() {
    problem = '';
    try {
      const { requestId } = await api<{ requestId: string }>('POST', '/control/moves', { camera, target: chosen });
      step = 'asking';
      while (!stopped) {
        await new Promise((res) => (timer = setTimeout(res, 1000)));
        if (stopped) return;
        const m: MoveItem | undefined = (await loadMoves()).find((x) => x.requestId === requestId);
        if (m?.answer && !m.answer.accept) {
          rejected = rejectText(targetName, m.answer.reason, address);
          step = 'rejected';
          return;
        }
        if (m?.answer?.accept) return onclose();
      }
    } catch (e) {
      step = 'pick';
      problem = say(e);
    }
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="move-title" data-testid="move-dialog">
    <h3 id="move-title">Move {name}</h3>
    {#if step === 'asking'}
      <p data-testid="move-asking">Asking {targetName}…</p>
    {:else if step === 'rejected'}
      <p class="bad" data-testid="move-rejected">{rejected}</p>
    {:else if problem}
      <p class="bad" data-testid="move-problem">{problem}</p>
    {:else if targets === null}
      <p class="muted">Looking for proxies…</p>
    {:else if !targets.length}
      <p class="muted" data-testid="move-no-targets">No other proxy of this account is online.</p>
    {/if}
    {#if step === 'pick' && targets?.length}
      <label>Move to
        <select bind:value={chosen} data-testid="move-target">
          {#each targets as t (t.proxyId)}<option value={t.proxyId}>{t.name}</option>{/each}
        </select>
      </label>
    {/if}
    <div class="buttons">
      <button onclick={onclose} data-testid="move-dialog-close">{step === 'rejected' ? 'Close' : 'Cancel'}</button>
      {#if step === 'pick'}<button class="primary" onclick={() => void cont()} disabled={!chosen} data-testid="move-continue">Continue</button>{/if}
    </div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgb(0 0 0 / 0.5); display: grid; place-items: center; z-index: 50; padding: 16px; }
  .modal { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); width: min(480px, 100%); padding: 18px; display: grid; gap: 12px; }
  h3 { margin: 0; font-size: 16px; }
  p { margin: 0; line-height: 1.5; }
  .bad { color: var(--danger); }
  .muted { color: var(--muted); }
  label { display: grid; gap: 6px; font-size: 14px; }
  select { padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  button { padding: 7px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; }
  button.primary { border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
