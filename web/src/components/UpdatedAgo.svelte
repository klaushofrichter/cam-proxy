<script lang="ts">
  import { updatedAt } from '../lib/state';
  // "updated N s ago": in the top bar on desktop, in the drawer footer on phones.
  let { testid = 'updated' }: { testid?: string } = $props();
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });
  const ago = $derived($updatedAt === null ? '…' : now - $updatedAt < 2000 ? 'just now' : `${Math.round((now - $updatedAt) / 1000)} s ago`);
</script>

<span data-testid={testid} title="When the status last arrived (it updates every 5 s)">updated {ago}</span>
