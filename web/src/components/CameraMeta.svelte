<script lang="ts">
  import { status } from '../lib/state';
  // The camera's model (linked to its own web page), firmware and the proxy
  // version: in the top bar on desktop, in the drawer footer on phones.
  let { testid = 'camera-model' }: { testid?: string } = $props();
</script>

{#if $status?.camera.model}
  {#if $status.camera.webUiUrl}<a href={$status.camera.webUiUrl} target="_blank" rel="noopener noreferrer" title="The camera's own web page" data-testid={testid}>{$status.camera.model}</a>{:else}<span data-testid={testid}>{$status.camera.model}</span>{/if}
  · {$status.camera.firmware} · {$status.version}
{/if}

<style>
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
