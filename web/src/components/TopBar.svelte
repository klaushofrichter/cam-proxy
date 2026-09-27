<script lang="ts">
  import Icon from './Icon.svelte';
  import ThemeToggle from './ThemeToggle.svelte';
  import { logout } from '../lib/api';
  import { status } from '../lib/state';

  const online = $derived($status ? ($status.camera.online ? 'online' : 'offline') : '…');
</script>

<header>
  <span class="brand"><Icon name="camera" size={22} /> cam-proxy</span>
  <span class="badge {online}" title="Camera" data-testid="camera-online">camera {online}</span>
  <span class="badge {$status?.intake.onvif ?? ''}" title="Event intake">events: {$status ? `${$status.intake.source} (${$status.intake.onvif})` : '…'}</span>
  <span class="meta">{$status?.camera.model ? `${$status.camera.model} · ${$status.camera.firmware} · ${$status.version}` : ''}</span>
  <span class="spacer"></span>
  <ThemeToggle />
  <button class="logout" data-testid="logout" onclick={() => void logout()}><Icon name="logout" size={16} /> Sign out</button>
</header>

<style>
  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: var(--chrome); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .brand { display: inline-flex; gap: 8px; align-items: center; font-weight: 700; color: var(--accent); }
  .meta { color: var(--muted); font-family: var(--mono); font-size: 12px; }
  .spacer { flex: 1; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); letter-spacing: 0.02em; }
  .badge.online, .badge.subscribed { color: #22c55e; border-color: color-mix(in srgb, #22c55e 50%, var(--border)); }
  .badge.offline, .badge.down { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 50%, var(--border)); }
  .badge.connecting { color: #f59e0b; }
  .logout { display: inline-flex; gap: 6px; align-items: center; padding: 7px 12px; border-radius: 8px; border: 0; background: var(--grad); color: var(--on-grad); cursor: pointer; font-weight: 600; }
  @media (max-width: 700px) { .meta { display: none; } }
</style>
