<script lang="ts">
  // Issue #227: one line saying why the controls next to it are off.
  let { why, testid = 'locked-note' }: { why: string | null; testid?: string } = $props();
</script>

{#if why}<p class="locked" data-testid={testid}>{why}</p>{/if}

<style>
  .locked { margin: 0; font-size: 13px; color: var(--muted); }
</style>
