<script lang="ts">
  import Icon from './Icon.svelte';
  import ThemeToggle from './ThemeToggle.svelte';
  import { page } from '../lib/router';
  import { logout } from '../lib/api';
  import { NAV_ITEMS, drawerOpen, sidebarCollapsed } from '../lib/nav';

  // `drawer` renders the same menu inside the phone drawer, always expanded,
  // with the theme toggle and Sign out added (the top bar hides them on phones).
  let { drawer = false }: { drawer?: boolean } = $props();
  const collapsed = $derived($sidebarCollapsed && !drawer);
</script>

<nav class="sidebar" class:collapsed class:drawer data-testid={drawer ? 'drawer' : 'sidebar'} aria-label="Main">
  {#each NAV_ITEMS as item (item.id)}
    {@const active = $page === item.id}
    <!-- A plain hash link: the router follows hashchange; the drawer closes. -->
    <a
      href="#/{item.id}"
      class="item"
      class:active
      data-testid="nav-{item.id}"
      aria-current={active ? 'page' : undefined}
      title={collapsed ? item.label : undefined}
      onclick={() => drawerOpen.set(false)}
    >
      <Icon name={item.icon} size={18} />
      <span class="label">{item.label}</span>
    </a>
  {/each}
  <div class="grow"></div>
  {#if drawer}
    <div class="drawer-actions">
      <ThemeToggle />
      <button class="item" data-testid="drawer-logout" onclick={() => void logout()}><Icon name="logout" size={18} /><span class="label">Sign out</span></button>
    </div>
  {:else}
    <button
      class="item collapse"
      data-testid="sidebar-toggle"
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      aria-expanded={!collapsed}
      title={collapsed ? 'Expand' : undefined}
      onclick={() => sidebarCollapsed.update((v) => !v)}
    >
      <span class="chev" class:flipped={collapsed}><Icon name="chevron" size={18} /></span>
      <span class="label">Collapse</span>
    </button>
  {/if}
</nav>

<style>
  .sidebar {
    width: 220px; height: 100%; display: flex; flex-direction: column; gap: 4px; padding: 12px 10px;
    background: var(--chrome); border-right: 1px solid var(--border); overflow: hidden;
    transition: width 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .sidebar.collapsed { width: 64px; }
  .sidebar.drawer { width: 260px; border-right: 0; }
  .item {
    display: flex; align-items: center; gap: 12px; padding: 9px 13px; border-radius: 10px;
    color: var(--muted); text-decoration: none; white-space: nowrap; border: 0; background: transparent;
    cursor: pointer; font-size: 14.5px; text-align: left; position: relative;
    transition: background-color 0.15s ease, color 0.15s ease;
  }
  .item:hover { background: var(--surface-2); color: var(--text); }
  .item.active {
    color: var(--text);
    background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 18%, transparent), color-mix(in srgb, var(--accent-2) 10%, transparent));
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .item :global(svg) { flex-shrink: 0; }
  .label { transition: opacity 0.15s ease; }
  .collapsed .label { opacity: 0; pointer-events: none; }
  .grow { flex: 1; }
  .chev { display: inline-grid; transition: transform 0.22s ease; }
  .chev.flipped { transform: rotate(180deg); }
  .drawer-actions { display: flex; align-items: center; gap: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
  .drawer-actions .item { flex: 1; }
</style>
