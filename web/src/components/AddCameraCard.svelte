<script lang="ts">
  import { api, ApiError } from '../lib/api';
  import { newCameraProblem } from '../lib/camera-settings';

  // Add a camera (spec 2026-10-05-multi-camera-host-design §6.3): it goes into
  // overrides.json and starts at once. Its password is CAMPROXY_CAMERA_<ID>_PASSWORD
  // (or the shared CAMPROXY_CAMERA_PASSWORD) in the environment: never set here.
  let { existing, onadded }: { existing: string[]; onadded: (view: Record<string, unknown>) => void } = $props();
  let id = $state('');
  let name = $state('');
  let host = $state('');
  let protocol = $state<'https' | 'http'>('https');
  let user = $state('proxy');
  let message = $state('');
  let touched = $state(false);
  const problem = $derived(newCameraProblem({ id: id.trim(), host }, existing));

  async function add() {
    touched = true;
    if (problem) return;
    message = '';
    const cam = id.trim();
    try {
      const view = await api<Record<string, unknown>>('PUT', '/control/config', { cameras: { [cam]: { host: host.trim(), protocol, user: user.trim() || 'proxy', ...(name.trim() ? { name: name.trim() } : {}) } } });
      message = `Camera ${cam} added; it starts now`;
      id = name = host = '';
      touched = false;
      onadded(view);
    } catch (e) {
      message = e instanceof ApiError ? e.message : 'not added';
    }
  }
</script>

<div class="card" data-testid="add-camera">
  <h3>Add a camera</h3>
  <p class="muted small">The camera starts at once and is kept in the data folder's overrides (cameras in config.json are changed there). Its password comes from the environment: CAMPROXY_CAMERA_&lt;ID&gt;_PASSWORD, or CAMPROXY_CAMERA_PASSWORD for all.</p>
  <form class="grid" onsubmit={(e) => { e.preventDefault(); void add(); }}>
    <label>Id <input bind:value={id} placeholder="cam6" autocomplete="off" data-testid="add-camera-id" /></label>
    <label>Name <input bind:value={name} placeholder="(the id)" autocomplete="off" data-testid="add-camera-name" /></label>
    <label>Address <input bind:value={host} placeholder="192.168.60.16" autocomplete="off" data-testid="add-camera-host" /></label>
    <label>Protocol
      <select bind:value={protocol} data-testid="add-camera-protocol"><option value="https">https</option><option value="http">http</option></select>
    </label>
    <label>User <input bind:value={user} autocomplete="off" data-testid="add-camera-user" /></label>
    <div class="row"><button type="submit" data-testid="add-camera-save">Add</button></div>
  </form>
  {#if touched && problem}<p class="field-error" data-testid="add-camera-problem">{problem}</p>{/if}
  {#if message}<p class="msg" role="status" data-testid="add-camera-message">{message}</p>{/if}
</div>

<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
  h3 { margin: 0 0 6px; font-size: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; align-items: end; }
  label { display: grid; gap: 4px; font-size: 13px; }
  input, select { padding: 4px 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; }
  button { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); }
  button:hover { border-color: var(--accent); }
  .muted { color: var(--muted); margin: 0 0 8px; }
  .small { font-size: 13px; }
  .msg { margin: 8px 0 0; color: var(--accent); }
  .field-error { margin: 8px 0 0; font-size: 12px; color: #ef4444; }
</style>
