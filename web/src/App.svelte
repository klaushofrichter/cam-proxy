<script lang="ts">
  import { onMount } from 'svelte';
  import { loggedIn, checkSession } from './lib/api';
  import { page } from './lib/router';
  import { connect, disconnect } from './lib/state';
  import Login from './pages/Login.svelte';
  import TopBar from './components/TopBar.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import Status from './pages/Status.svelte';
  import Events from './pages/Events.svelte';
  import Timeline from './pages/Timeline.svelte';
  import Clips from './pages/Clips.svelte';
  import Settings from './pages/Settings.svelte';
  import Maintenance from './pages/Maintenance.svelte';

  onMount(() => void checkSession());

  $effect(() => {
    if ($loggedIn) connect();
    else disconnect();
  });
</script>

{#if $loggedIn === false}
  <Login />
{:else if $loggedIn}
  <div class="shell" data-testid="shell">
    <TopBar />
    <div class="body">
      <Sidebar />
      <main>
        {#if $page === 'status'}<Status />
        {:else if $page === 'events'}<Events />
        {:else if $page === 'timeline'}<Timeline />
        {:else if $page === 'clips'}<Clips />
        {:else if $page === 'settings'}<Settings />
        {:else}<Maintenance />{/if}
      </main>
    </div>
  </div>
{/if}

<style>
  .shell { display: grid; grid-template-rows: auto 1fr; height: 100vh; }
  .body { display: grid; grid-template-columns: auto 1fr; min-height: 0; }
  main { overflow: auto; padding: 20px 24px 40px; }
  @media (max-width: 700px) { main { padding: 12px; } }
</style>
