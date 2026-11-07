<script lang="ts">
  import Icon from './Icon.svelte';

  // A small (i) next to a label: the text shows as a tooltip on hover and
  // keyboard focus, and stays open on a click or tap (touch screens have no hover).
  let { text, label, testid }: { text: string; label: string; testid?: string } = $props();
  let open = $state(false);
  const id = `help-${Math.random().toString(36).slice(2, 9)}`;
</script>

<span class="help">
  <button type="button" class="tip" aria-label={`About ${label}`} aria-expanded={open} aria-describedby={id} data-testid={testid}
    onclick={(e) => { e.preventDefault(); open = !open; }} onblur={() => (open = false)} onkeydown={(e) => e.key === 'Escape' && (open = false)}>
    <Icon name="about" size={15} />
  </button>
  <span role="tooltip" {id} class="bubble" class:open data-testid={testid ? `${testid}-text` : undefined}>{text}</span>
</span>

<style>
  .help { position: relative; display: inline-flex; align-items: center; }
  .tip { display: inline-flex; padding: 0; border: 0; background: none; color: var(--muted); cursor: help; }
  .tip:hover, .tip:focus-visible { color: var(--accent); }
  .bubble { display: none; position: absolute; left: 0; top: calc(100% + 6px); z-index: 20; width: max-content; max-width: min(340px, 80vw);
    padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text);
    font-size: 13px; line-height: 1.4; font-weight: normal; white-space: normal; box-shadow: 0 4px 14px rgb(0 0 0 / 0.25); }
  .bubble.open, .tip:hover + .bubble, .tip:focus-visible + .bubble { display: block; }
</style>
