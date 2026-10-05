<script lang="ts">
  import { status } from '../lib/state';
  import { blockOf, selectedCamera } from '../lib/cameras';
  // The camera's model (linked to its own web page), firmware and the proxy
  // version: in the top bar on desktop, in the drawer footer on phones.
  let { testid = 'camera-model' }: { testid?: string } = $props();
  // The selected camera's (several cameras), else the only one's.
  const cam = $derived(blockOf($status, $selectedCamera)?.camera);
</script>

{#if $status && cam?.model}
  {#if cam.webUiUrl}<a href={cam.webUiUrl} target="_blank" rel="noopener noreferrer" title="The camera's own web page" data-testid={testid}>{cam.model}</a>{:else}<span data-testid={testid}>{cam.model}</span>{/if}
  · {cam.firmware} · {$status.version}
{/if}

<style>
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
