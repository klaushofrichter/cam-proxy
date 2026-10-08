<script lang="ts">
  import Icon from './Icon.svelte';
  import { fingerprintChunks, hostOf, shortId } from '../lib/long-value';

  // One way to show a long value (#203), never broken mid-token:
  // - id: shortened in the middle (prx_01J9…9F5X), the full value as title;
  // - fingerprint: its algorithm, then groups of four that wrap only between groups;
  // - url: the host, the full URL as title;
  // - text: as it is on one line, an ellipsis where it doesn't fit.
  // `copy` adds a button that copies the full value.
  let {
    value,
    kind = 'id',
    copy = false,
    label = 'value',
    testid,
  }: { value: string; kind?: 'id' | 'fingerprint' | 'url' | 'text'; copy?: boolean; label?: string; testid?: string } = $props();

  let state = $state<'' | 'copied' | 'failed'>('');
  async function doCopy() {
    try {
      await navigator.clipboard.writeText(value);
      state = 'copied';
    } catch {
      state = 'failed';
    }
    setTimeout(() => (state = ''), 2000);
  }
  const fp = $derived(kind === 'fingerprint' ? fingerprintChunks(value) : null);
  const shown = $derived(kind === 'id' ? shortId(value) : kind === 'url' ? hostOf(value) : value);
</script>

<span class="lv {kind}" data-full={value}>
  {#if fp}
    <span class="fp" title={value} data-testid={testid}>{#if fp.algo}<span class="algo">{fp.algo}:</span>{' '}{/if}{#each fp.groups as g, i (i)}<span class="g">{g}</span>{' '}{/each}</span>
  {:else}
    <span class="v" title={value} data-testid={testid}>{shown}</span>
  {/if}
  {#if copy}
    <button type="button" class="copy" class:ok={state === 'copied'} onclick={() => void doCopy()} aria-label="Copy {label}" title={state === 'failed' ? 'Copy failed: select the value and copy it by hand' : `Copy ${label}`} data-testid={testid ? `${testid}-copy` : undefined}>
      {#if state === 'copied'}Copied{:else if state === 'failed'}Failed{:else}<Icon name="copy" size={14} />{/if}
    </button>
  {/if}
</span>

<style>
  .lv { display: inline-flex; align-items: baseline; gap: 6px; max-width: 100%; min-width: 0; vertical-align: bottom; font-family: var(--mono); }
  .v { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lv.fingerprint { display: inline-flex; align-items: flex-start; }
  /* Groups wrap only at the spaces between them; overflow-wrap only here, as a last resort. */
  .fp { min-width: 0; white-space: normal; overflow-wrap: anywhere; line-height: 1.45; }
  .g, .algo { white-space: nowrap; }
  .algo { color: var(--muted); }
  .copy { flex: none; display: inline-grid; place-items: center; min-width: 26px; height: 22px; padding: 0 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); color: var(--muted); cursor: pointer; font: 12px var(--font); }
  .copy:hover { border-color: var(--accent); color: var(--text); }
  .copy.ok { color: #22c55e; }
</style>
