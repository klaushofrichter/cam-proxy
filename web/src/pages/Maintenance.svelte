<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { refresh } from '../lib/state';

  let result = $state('');
  let log = $state<Array<Record<string, unknown>>>([]);
  const loadLog = async () => (log = (await api<Array<Record<string, unknown>>>('GET', '/control/log?limit=200')).reverse());
  onMount(() => void loadLog());

  async function run(label: string, name: string, body?: unknown) {
    try {
      const r = await api<unknown>('POST', `/control/actions/${name}`, body);
      result = `${label}: ${r === null ? 'started' : JSON.stringify(r)}`;
    } catch (e) {
      result = `${label}: ${e instanceof ApiError ? e.message : 'failed'}`;
    }
    void refresh();
    void loadLog();
  }
</script>

<section>
  <h2>Maintenance</h2>
  <div class="card">
    <div class="buttons">
      <button onclick={() => void run('Camera test', 'camera-test')} data-testid="action-camera-test">Test the camera</button>
      <button onclick={() => void run('ONVIF', 'onvif-resubscribe')} data-testid="action-resubscribe">Re-subscribe ONVIF</button>
      <button onclick={() => void run('Retention preview', 'retention-run', { dryRun: true })} data-testid="action-retention-dry">Preview retention</button>
      <button onclick={() => void run('Retention', 'retention-run', {})} data-testid="action-retention">Run retention now</button>
      <button onclick={() => void run('Restart', 'restart')} data-testid="action-restart">Restart camera side</button>
    </div>
    <div class="buttons">
      <button onclick={() => void run('Camera FTP setup', 'camera-ftp-setup')} data-testid="action-ftp-setup">Point the camera's FTP here</button>
      <button onclick={() => void run('Camera FTP test', 'camera-ftp-test')} data-testid="action-ftp-test">Test the camera's FTP</button>
      <button onclick={() => void run('Camera FTP off', 'camera-ftp-off')} data-testid="action-ftp-off">Turn the camera's FTP off</button>
    </div>
    {#if result}<p class="msg mono" data-testid="action-result">{result}</p>{/if}
  </div>
  <div class="card">
    <div class="loghead"><h3>Log</h3><button onclick={() => void loadLog()}>Refresh</button></div>
    <div class="log">
      <table>
        <tbody>
          {#each log as l, i (i)}
            <tr><td class="mono">{new Date(Number(l.time)).toLocaleTimeString()}</td><td class="lvl{l.level}">{l.level}</td><td class="mono">{l.msg}</td><td class="mono small">{JSON.stringify(Object.fromEntries(Object.entries(l).filter(([k]) => !['time', 'level', 'msg', 'pid', 'hostname'].includes(k))))}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
</section>

<style>
  section { display: grid; gap: 12px; }
  h2 { margin: 0; font-size: 20px; }
  h3 { margin: 0; font-size: 16px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; gap: 8px; }
  .buttons { display: flex; flex-wrap: wrap; gap: 8px; }
  button { padding: 7px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); }
  button:hover { border-color: var(--accent); }
  .loghead { display: flex; justify-content: space-between; align-items: center; }
  .log { max-height: 420px; overflow: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 3px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  .lvl40, .lvl50 { color: var(--danger); }
  .mono { font-family: var(--mono); }
  .small { font-size: 12px; color: var(--muted); }
  .msg { margin: 0; color: var(--accent); }
</style>
