<script lang="ts">
  import Icon from './Icon.svelte';
  import ThemeToggle from './ThemeToggle.svelte';
  import { logout } from '../lib/api';
  import { refreshNow, status, updatedAt } from '../lib/state';
  import { drawerOpen } from '../lib/nav';

  const online = $derived($status ? ($status.camera.online ? 'online' : 'offline') : '…');
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });
  const ago = $derived($updatedAt === null ? '…' : now - $updatedAt < 2000 ? 'just now' : `${Math.round((now - $updatedAt) / 1000)} s ago`);
</script>

<header data-testid="topbar">
  <button class="hamburger" data-testid="hamburger" aria-label="Open menu" aria-expanded={$drawerOpen} aria-controls="nav-drawer" onclick={() => drawerOpen.set(true)}>
    <Icon name="menu" />
  </button>
  <a class="brand" href="https://github.com/klaushofrichter/cam-proxy" target="_blank" rel="noopener noreferrer" title="cam-proxy on GitHub" aria-label="cam-proxy on GitHub" data-testid="brand"><Icon name="camera" size={22} /> <span class="brand-name">cam-proxy</span></a>
  <!-- On phones the pills show a dot and the state only; the rest stays for screen readers and the title. -->
  <span class="badge {online}" title="Camera {online}" data-testid="camera-online"><span class="dot"></span><span class="long">{'camera '}</span>{online}</span>
  <span class="badge {$status?.intake.onvif ?? ''}" title="Event intake: {$status ? `${$status.intake.source} (${$status.intake.onvif})` : '…'}" data-testid="events-intake"><span class="dot"></span>{#if $status}<span class="long">events: {$status.intake.source} (</span>{$status.intake.onvif}<span class="long">)</span>{:else}<span class="long">{'events: '}</span>…{/if}</span>
  {#if $status?.camera.model}
    <span class="meta">
      {#if $status.camera.webUiUrl}<a href={$status.camera.webUiUrl} target="_blank" rel="noopener noreferrer" title="The camera's own web page" data-testid="camera-model">{$status.camera.model}</a>{:else}<span data-testid="camera-model">{$status.camera.model}</span>{/if}
      · {$status.camera.firmware} · {$status.version}
    </span>
  {/if}
  <span class="spacer"></span>
  <span class="updated" data-testid="updated" title="When the status last arrived (it updates every 5 s)">updated {ago}</span>
  <button class="icon" onclick={refreshNow} title="Refresh this page" aria-label="Refresh" data-testid="refresh"><Icon name="refresh" size={16} /></button>
  <div class="desktop-only"><ThemeToggle /></div>
  <button class="logout desktop-only" data-testid="logout" onclick={() => void logout()}><Icon name="logout" size={16} /> Sign out</button>
</header>

<style>
  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: var(--chrome); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .hamburger { display: none; width: 36px; height: 36px; place-items: center; border: 0; background: transparent; cursor: pointer; border-radius: 10px; color: var(--text); flex-shrink: 0; }
  .hamburger:hover { background: var(--surface-2); }
  .dot { display: none; width: 7px; height: 7px; margin: 0 5px 1px 0; border-radius: 50%; background: currentColor; vertical-align: middle; }
  .brand { display: inline-flex; gap: 8px; align-items: center; font-weight: 700; color: var(--accent); text-decoration: none; }
  .meta { color: var(--muted); font-family: var(--mono); font-size: 12px; }
  .meta a { color: var(--accent); text-decoration: none; }
  .meta a:hover { text-decoration: underline; }
  .updated { color: var(--muted); font-size: 12px; }
  .icon { display: inline-flex; align-items: center; padding: 6px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; }
  .icon:hover { border-color: var(--accent); }
  .spacer { flex: 1; }
  .badge { white-space: nowrap; font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); letter-spacing: 0.02em; }
  .badge.online, .badge.subscribed { color: #22c55e; border-color: color-mix(in srgb, #22c55e 50%, var(--border)); }
  .badge.offline, .badge.down { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 50%, var(--border)); }
  .badge.connecting { color: #f59e0b; }
  .logout { display: inline-flex; gap: 6px; align-items: center; padding: 7px 12px; border-radius: 8px; border: 0; background: var(--grad); color: var(--on-grad); cursor: pointer; font-weight: 600; }
  /* Phones (cams' breakpoint): one row; hamburger, logo, compact pills, refresh.
     Theme and Sign out move into the drawer. */
  @media (max-width: 767px) {
    header { flex-wrap: nowrap; gap: 8px; padding: 8px 12px; }
    .hamburger { display: grid; }
    .meta, .updated, .desktop-only, .brand-name { display: none; }
    .dot { display: inline-block; }
    .badge { padding: 2px 7px; }
    .long { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  }
</style>
