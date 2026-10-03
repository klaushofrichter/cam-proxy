<script lang="ts">
  import { onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { loggedIn, checkSession } from './lib/api';
  import { page } from './lib/router';
  import { connect, disconnect } from './lib/state';
  import Login from './pages/Login.svelte';
  import TopBar from './components/TopBar.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import Icon from './components/Icon.svelte';
  import { PHONE_QUERY, drawerOpen } from './lib/nav';
  import Status from './pages/Status.svelte';
  import Events from './pages/Events.svelte';
  import Timeline from './pages/Timeline.svelte';
  import Clips from './pages/Clips.svelte';
  import Audit from './pages/Audit.svelte';
  import Settings from './pages/Settings.svelte';
  import Maintenance from './pages/Maintenance.svelte';

  onMount(() => void checkSession());

  // The phone drawer (like cams): Escape closes it, and so does a page change
  // (also Back) or the window growing to desktop width.
  const motion = (ms: number) => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms);
  let drawerPanelEl: HTMLDivElement | undefined = $state();
  let drawerWasOpen = false;
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && $drawerOpen) drawerOpen.set(false);
    };
    addEventListener('keydown', onKey);
    const mq = matchMedia(PHONE_QUERY);
    const onWidth = () => {
      if (!mq.matches) drawerOpen.set(false);
    };
    mq.addEventListener('change', onWidth);
    const stopPage = page.subscribe(() => drawerOpen.set(false));
    return () => {
      removeEventListener('keydown', onKey);
      mq.removeEventListener('change', onWidth);
      stopPage();
    };
  });

  // Signed out (Sign out in the drawer, an expired session): no drawer, so
  // the sign-in page scrolls and the next sign-in starts with it closed.
  $effect(() => {
    if (!$loggedIn) drawerOpen.set(false);
  });

  // Focus moves into the drawer when it opens and back to the hamburger when
  // it closes; the page behind it doesn't scroll.
  $effect(() => {
    const open = $drawerOpen;
    if (open && !drawerWasOpen) {
      drawerPanelEl?.querySelector<HTMLElement>('[data-testid^="nav-"]')?.focus();
    } else if (!open && drawerWasOpen) {
      document.querySelector<HTMLElement>('[data-testid="hamburger"]')?.focus();
    }
    document.body.style.overflow = open ? 'hidden' : '';
    drawerWasOpen = open;
  });

  $effect(() => {
    if ($loggedIn) connect();
    else disconnect();
  });
</script>

{#if $loggedIn === false}
  <Login />
{:else if $loggedIn}
  <div class="shell" data-testid="shell">
    <div class="top" inert={$drawerOpen}><TopBar /></div>
    <div class="body" inert={$drawerOpen}>
      <div class="side"><Sidebar /></div>
      <main class:locked={$drawerOpen}>
        {#if $page === 'status'}<Status />
        {:else if $page === 'events'}<Events />
        {:else if $page === 'timeline'}<Timeline />
        {:else if $page === 'clips'}<Clips />
        {:else if $page === 'audit'}<Audit />
        {:else if $page === 'settings'}<Settings />
        {:else}<Maintenance />{/if}
      </main>
    </div>
    {#if $drawerOpen}
      <button class="backdrop" data-testid="drawer-backdrop" aria-label="Close menu" transition:fade={{ duration: motion(150) }} onclick={() => drawerOpen.set(false)}></button>
      <div id="nav-drawer" class="drawer-panel" role="dialog" aria-modal="true" aria-label="Menu" bind:this={drawerPanelEl} transition:fly={{ x: -280, duration: motion(220) }}>
        <button class="close" data-testid="drawer-close" aria-label="Close menu" onclick={() => drawerOpen.set(false)}><Icon name="close" /></button>
        <Sidebar drawer />
      </div>
    {/if}
  </div>
{/if}

<style>
  .shell { display: grid; grid-template-rows: auto 1fr; height: 100vh; height: 100dvh; }
  .body { display: grid; grid-template-columns: auto 1fr; min-height: 0; }
  .side { min-height: 0; }
  main { overflow: auto; padding: 20px 24px 40px; min-width: 0; }
  main.locked { overflow: hidden; }
  .backdrop { position: fixed; inset: 0; background: var(--scrim); border: 0; z-index: 30; cursor: pointer; }
  .drawer-panel { position: fixed; top: 0; bottom: 0; left: 0; z-index: 31; background: var(--chrome); box-shadow: var(--shadow); padding-top: 48px; }
  .close { position: absolute; top: 8px; right: 10px; width: 36px; height: 36px; display: grid; place-items: center; border: 0; background: transparent; cursor: pointer; border-radius: 10px; color: var(--text); }
  .close:hover { background: var(--surface-2); }
  /* Phones (cams' breakpoint): no sidebar; the hamburger opens the drawer. */
  @media (max-width: 767px) {
    .body { grid-template-columns: 1fr; }
    .side { display: none; }
    main { padding: 12px; }
  }

</style>
