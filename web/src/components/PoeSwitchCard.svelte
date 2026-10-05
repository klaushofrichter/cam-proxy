<script lang="ts">
  import { api, ApiError } from '../lib/api';
  import { refresh, status } from '../lib/state';
  import { poeLine, type PortReading } from '../lib/maintenance';

  // The camera's PoE switch (#85): what is configured, the last reading, and
  // a read on request (never polled: the switch has one web session, and
  // each read takes it for a moment). The settings are poeSwitch.* (and the camera's cameras.<id>.poeSwitch.port) in
  // the camera group; the password is CAMPROXY_POE_SWITCH_PASSWORD.
  const sw = $derived($status?.camera.poeSwitch ?? null);
  let message = $state('');
  let reading = $state(false);
  async function read() {
    reading = true;
    try {
      const r = await api<PortReading>('POST', '/control/actions/poe-switch-read');
      message = `Port ${r.port} (index ${r.index}): PoE ${r.poe ? 'on' : 'off'}, ${r.watts} W, link ${r.link === null ? 'unknown' : r.link ? 'up' : 'down'}`;
    } catch (e) {
      message = e instanceof ApiError ? e.message : 'not read';
    }
    reading = false;
    void refresh();
  }
</script>

{#if sw}
  <div class="card" data-testid="poe-switch-settings">
    <h3>PoE switch</h3>
    <p class="line" data-testid="poe-switch-line">{poeLine(sw)}</p>
    {#if sw.last}<p class="small">Switch {sw.last.sn ?? '—'}{sw.last.firmware ? `, firmware ${sw.last.firmware}` : ''}; port {sw.last.port} is internal index {sw.last.index}.</p>{/if}
    <p class="small">Model, host and the off time are <span class="mono">poeSwitch.*</span> below, the port <span class="mono">cameras.&lt;id&gt;.poeSwitch.port</span>; they apply at once. The password is the secret <span class="mono">CAMPROXY_POE_SWITCH_PASSWORD</span> ({sw.passwordSet ? 'set' : 'not set'}). A read or a power-cycle only works while nobody is logged in to the switch's web UI.</p>
    {#if sw.configured}
      <div><button onclick={() => void read()} disabled={reading || sw.busy} data-testid="poe-switch-read">Read the switch now</button></div>
    {/if}
    {#if message}<p class="msg" data-testid="poe-switch-message">{message}</p>{/if}
  </div>
{/if}

<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; gap: 8px; }
  h3 { margin: 0; font-size: 16px; }
  p { margin: 0; }
  .line { font-weight: 600; }
  .small { font-size: 13px; color: var(--muted); }
  .mono { font-family: var(--mono); }
  .msg { color: var(--accent); }
  button { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); }
  button:hover { border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
