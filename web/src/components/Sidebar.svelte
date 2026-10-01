<script lang="ts">
  import Icon from './Icon.svelte';
  import { page, go, type Page } from '../lib/router';
  import type { IconName } from '../lib/icons';
  const items: Array<{ id: Page; label: string; icon: IconName }> = [
    { id: 'status', label: 'Status', icon: 'about' },
    { id: 'events', label: 'Events', icon: 'events' },
    { id: 'timeline', label: 'Timeline', icon: 'history' },
    { id: 'clips', label: 'Clips', icon: 'play' },
    { id: 'audit', label: 'Audit', icon: 'audit' },
    { id: 'settings', label: 'Settings', icon: 'settings' },
    { id: 'maintenance', label: 'Maintenance', icon: 'bolt' },
  ];
</script>

<nav>
  {#each items as item (item.id)}
    <button class:active={$page === item.id} data-testid="nav-{item.id}" onclick={() => go(item.id)} aria-current={$page === item.id ? 'page' : undefined}>
      <Icon name={item.icon} size={18} /> <span>{item.label}</span>
    </button>
  {/each}
</nav>

<style>
  nav { display: grid; align-content: start; gap: 4px; padding: 12px 8px; background: var(--chrome); border-right: 1px solid var(--border); min-width: 170px; }
  button { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border: 0; border-radius: 8px; background: none; cursor: pointer; text-align: left; color: var(--muted); }
  button:hover { background: var(--surface-2); color: var(--text); }
  button.active { background: color-mix(in srgb, var(--accent) 16%, var(--surface-2)); color: var(--text); }
  @media (max-width: 700px) { nav { min-width: 0; } span { display: none; } }
</style>
