<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import type { UiObject, UiSummaryEntry } from '../lib/analytics';

  // The analysis of one event (spec 2026-09-30-analytics-design): the image
  // with its boxes, the objects, the camera's event, and the raw answer.
  let { camId, event, onclose }: { camId: string; event: { id: number; kind: string; start: number; end: number | null }; onclose: () => void } = $props();
  interface Full { provider: string; status: string; reason: string | null; stillTs: number | null; requestedAt: number; tookMs: number | null; objects: UiObject[]; summary?: UiSummaryEntry[]; raw: unknown }
  let a = $state<Full | null>(null);
  let failed = $state(false);
  let showAll = $state(false);
  // The summary's entries by default; every object when asked (or when an older record has no summary).
  const boxes = $derived(
    a ? (showAll || !a.summary ? a.objects.map((o) => ({ label: o.name, score: o.score, box: o.box })) : a.summary.map((e) => ({ label: e.subtype.charAt(0).toUpperCase() + e.subtype.slice(1), score: e.score, box: e.box }))) : [],
  );
  let dialog: HTMLDivElement;
  const base = $derived(`/api/cameras/${encodeURIComponent(camId)}/events/${event.id}`);
  const fmt = (ts: number | null) => (ts === null ? 'now' : new Date(ts).toLocaleTimeString());
  // An object without coordinates arrives as a zero-area box: not drawn.
  const drawn = (o: { box?: { x0: number; y0: number; x1: number; y1: number } }) => (o.box && o.box.x1 > o.box.x0 && o.box.y1 > o.box.y0 ? o.box : null);
  onMount(() => {
    // Focus goes back to what opened the modal when it closes.
    const opener = document.activeElement as HTMLElement | null;
    dialog.focus();
    api<Full>('GET', `${base}/analysis`).then((r) => (a = r), () => (failed = true));
    return () => opener?.focus?.();
  });
  function onkey(e: KeyboardEvent) {
    if (e.key === 'Tab') {
      // Keep focus inside the modal.
      const f = [...dialog.querySelectorAll<HTMLElement>('button, summary, input, [tabindex="0"]')];
      if (!f.length) return;
      const i = f.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i + 1) % f.length;
      f[next].focus();
      e.preventDefault();
    }
  }
</script>

<!-- Esc closes it wherever the focus is. -->
<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div class="modal" role="dialog" aria-modal="true" aria-label="Analysis" tabindex="-1" bind:this={dialog} onkeydown={onkey} data-testid="analysis-modal">
    <div class="head">
      <h3>✦ Analysis · {event.kind} {fmt(event.start)}–{fmt(event.end)}</h3>
      <button onclick={onclose} aria-label="Close" data-testid="analysis-close">✕</button>
    </div>
    {#if failed}<p class="muted">Could not load the analysis.</p>{:else if !a}<p class="muted" data-testid="analysis-loading">Loading…</p>{/if}
    {#if a}
      {#if a.status === 'ok'}
        <div class="figure">
          <img src={`${base}/analysis.jpg`} alt="The analysed still" data-testid="analysis-image" />
          <svg viewBox="0 0 1 1" preserveAspectRatio="none" data-testid="analysis-boxes">
            {#each boxes as o, i (i)}
              {@const b = drawn(o)}
              {#if b}<rect x={b.x0} y={b.y0} width={b.x1 - b.x0} height={b.y1 - b.y0} vector-effect="non-scaling-stroke" />{/if}
            {/each}
          </svg>
          {#each boxes as o, i (i)}
            {@const b = drawn(o)}
            {#if b}<span class="label" style={`left:${b.x0 * 100}%;top:${b.y0 * 100}%`}>{o.label} {o.score.toFixed(2)}</span>{/if}
          {/each}
        </div>
        {#if a.summary}
          <label class="small"><input type="checkbox" bind:checked={showAll} data-testid="analysis-show-all" /> Show all objects</label>
        {/if}
        <table data-testid="analysis-objects">
          <thead><tr><th>object</th><th>score</th></tr></thead>
          <tbody>{#each boxes as o, i (i)}<tr><td>{o.label}</td><td>{o.score.toFixed(2)}</td></tr>{:else}<tr><td colspan="2" class="muted">{showAll || !a?.summary ? 'Nothing found.' : 'Nothing relevant.'}</td></tr>{/each}</tbody>
        </table>
      {:else}
        <p data-testid="analysis-reason">Not analysed: {a.reason ?? a.status}.</p>
      {/if}
      <p class="muted small" data-testid="analysis-meta">{a.provider} · {a.status} · {new Date(a.requestedAt).toLocaleString()}{a.tookMs !== null ? ` · ${(a.tookMs / 1000).toFixed(1)} s` : ''}{a.stillTs !== null ? ` · still ${new Date(a.stillTs).toLocaleTimeString()}` : ''}</p>
      {#if a.raw !== null}<details><summary>Raw answer</summary><pre>{JSON.stringify(a.raw, null, 2)}</pre></details>{/if}
    {/if}
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgb(0 0 0 / 0.5); display: grid; place-items: center; z-index: 50; padding: 16px; }
  .modal { background: var(--surface); border: 1px solid #a855f7; border-radius: var(--radius); padding: 16px; width: min(960px, 100%); max-height: 90vh; overflow: auto; display: grid; gap: 10px; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  h3 { margin: 0; font-size: 16px; }
  .figure { position: relative; line-height: 0; }
  .figure img { width: 100%; border-radius: 6px; background: #111; }
  .figure svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  rect { fill: none; stroke: #a855f7; stroke-width: 3; }
  .label { position: absolute; transform: translateY(-100%); background: #a855f7; color: #fff; font-size: 12px; line-height: 1.4; padding: 0 4px; border-radius: 3px; white-space: nowrap; }
  table { border-collapse: collapse; font-size: 13px; }
  td, th { padding: 3px 10px 3px 0; text-align: left; }
  pre { font-size: 12px; overflow: auto; max-height: 300px; }
  .muted { color: var(--muted); margin: 0; }
  .small { font-size: 13px; }
  button { padding: 4px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; }
</style>
