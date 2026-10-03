<script lang="ts">
  import Icon from './Icon.svelte';
  import { theme, toggleTheme } from '../lib/theme';
</script>

<button class="icon-btn" data-testid="theme-toggle" onclick={() => toggleTheme()}
  aria-label={$theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} title={$theme === 'dark' ? 'Light theme' : 'Dark theme'}>
  <Icon name={$theme === 'dark' ? 'sun' : 'moon'} />
</button>

<style>
  .icon-btn { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 10px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; }
  .icon-btn:hover { background: color-mix(in srgb, var(--accent) 14%, var(--surface-2)); }
</style>
