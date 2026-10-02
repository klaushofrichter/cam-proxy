<script lang="ts">
  import { status, stats } from '../lib/state';
  import { pausedText, usageLine } from '../lib/analytics';
  import { daysUntilFullText } from '../lib/format';
  import { cameraStateText, poeLine } from '../lib/maintenance';
  import { cameraFtpText, clipTime, ftpAlerts } from '../lib/ftp';
  import { api, ApiError } from '../lib/api';
  import { refresh } from '../lib/state';
  import Icon from '../components/Icon.svelte';

  const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
  const mb = (b: number) => `${(b / 1024 ** 2).toFixed(1)} MB`;
  const ago = (ts?: number | null) => {
    if (!ts) return '—';
    const s = Math.round((Date.now() - ts) / 1000);
    return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
  };

  // #93: the camera's FTP upload off, elsewhere, or no clips while events happen.
  const alerts = $derived($status ? ftpAlerts({ enabled: $status.ftp.enabled, publicHost: $status.ftp.publicHost, camera: $status.ftp.camera ?? null, stalled: $status.ftp.stalled ?? null }) : []);
  const camFtpClass = (s?: string) => (s === 'on' ? 'ok' : s === 'off' || s === 'elsewhere' ? 'bad' : '');
  let fixing = $state(false);
  let fixResult = $state('');
  async function pointFtpHere() {
    if (fixing) return;
    fixing = true;
    fixResult = '';
    try {
      await api('POST', '/control/actions/camera-ftp-setup');
    } catch (e) {
      fixResult = `Camera FTP setup: ${e instanceof ApiError ? e.message : 'failed'}`;
    }
    fixing = false;
    void refresh();
  }
</script>

<section>
  <h2>Status</h2>
  {#if $status && $stats}
    <div class="grid">
      <div class="card" data-testid="card-camera">
        <h3>Camera</h3>
        <dl>
          <dt>State</dt><dd class={$status.camera.reboot?.phase === 'rebooting' || $status.camera.reboot?.phase === 'power-cycling' ? 'warn' : $status.camera.online ? 'ok' : 'bad'} data-testid="camera-state">{cameraStateText($status.camera)}</dd>
          <dt>Since</dt><dd>{ago($status.camera.since)}</dd>
          <dt>Model</dt><dd>{#if $status.camera.model && $status.camera.webUiUrl}<a href={$status.camera.webUiUrl} target="_blank" rel="noopener noreferrer" title="The camera's own web page">{$status.camera.model}</a>{:else}{$status.camera.model ?? '—'}{/if}</dd>
          <dt>Firmware</dt><dd>{$status.camera.firmware ?? '—'}</dd>
          <dt>Clock offset</dt><dd>{$status.camera.clockOffsetMs === undefined ? '—' : `${($status.camera.clockOffsetMs / 1000).toFixed(1)} s`}</dd>
          {#if $status.camera.poeSwitch && $status.camera.poeSwitch.model !== 'none'}<dt>PoE switch</dt><dd data-testid="camera-poe">{poeLine($status.camera.poeSwitch)}</dd>{/if}
          {#if $status.camera.error}<dt>Last error</dt><dd class="bad">{$status.camera.error}</dd>{/if}
        </dl>
      </div>
      <div class="card" data-testid="card-intake">
        <h3>Events</h3>
        <dl>
          <dt>ONVIF</dt><dd class={$status.intake.onvif === 'subscribed' ? 'ok' : 'bad'} data-testid="onvif-state">{$status.intake.onvif}</dd>
          <dt>Source</dt><dd>{$status.intake.source}</dd>
          <dt>Re-subscriptions</dt><dd>{$status.intake.resubscribes}</dd>
          {#if $status.intake.lastError}<dt>Last error</dt><dd class="bad">{$status.intake.lastError}</dd>{/if}
          {#each Object.entries($stats.events.stored) as [kind, n] (kind)}<dt>{kind} events</dt><dd>{n}</dd>{/each}
        </dl>
      </div>
      {#each ($status.analytics ?? []).filter((a) => a.enabled) as a (a.id)}
        <div class="card" data-testid={`card-analytics-${a.id}`}>
          <h3>Analytics · {a.name}</h3>
          <dl>
            <dt>Usage</dt><dd data-testid="analytics-usage">{usageLine(a)}</dd>
            {#if a.paused}<dt>Paused</dt><dd class="bad">{pausedText(a.paused)}</dd>{/if}
            {#if a.lastError}<dt>Last error</dt><dd class="bad">{a.lastError}</dd>{/if}
          </dl>
        </div>
      {:else}
        {#if $status.analytics}<div class="card" data-testid="card-analytics"><h3>Analytics</h3><p class="muted">not enabled</p></div>{/if}
      {/each}
      {#if $status.analyticsUnmapped?.length}
        <div class="card" data-testid="card-analytics-unmapped">
          <h3>Analytics · objects seen, not mapped</h3>
          <p class="muted small">Candidates for the class table (<a href="https://github.com/klaushofrichter/cam-proxy/blob/main/docs/analytics-classes.md" target="_blank" rel="noopener">docs/analytics-classes.md</a>).</p>
          <dl>
            {#each $status.analyticsUnmapped as u (u.mid || `name:${u.name.toLowerCase()}`)}<dt>{u.name}{u.mid ? ` · ${u.mid}` : ''}</dt><dd>{u.count}</dd>{/each}
          </dl>
        </div>
      {/if}
      <div class="card" data-testid="card-stream">
        <h3>Stills</h3>
        <dl>
          <dt>Stream</dt><dd class={$status.stream.up ? 'ok' : 'bad'} data-testid="stream-state">{$status.stream.enabled ? ($status.stream.up ? 'up' : 'down') : 'off'}</dd>
          <dt>go2rtc</dt><dd class={$status.stream.go2rtcUp ? 'ok' : 'bad'}>{$status.stream.go2rtcUp ? 'running' : 'stopped'}</dd>
          <dt>Last still</dt><dd>{ago($status.stream.lastFrameTs)}</dd>
          <dt>Still minutes</dt><dd>{$stats.disk.stills.files}</dd>
          <dt>Preview minutes</dt><dd>{Math.round($stats.disk.previews.files / 2)}</dd>
        </dl>
      </div>
      <div class="card" data-testid="card-ftp">
        <h3>Clips (FTP)</h3>
        <dl>
          <dt>Server</dt><dd class={$status.ftp.listening ? 'ok' : $status.ftp.enabled ? 'bad' : ''} data-testid="ftp-state">{$status.ftp.enabled ? ($status.ftp.listening ? `listening on ${$status.ftp.port}${$status.ftp.tls ? ' (FTPS)' : ''}` : 'not listening') : 'off'}</dd>
          {#if $status.ftp.enabled && !$status.ftp.passwordSet}<dt>Password</dt><dd class="bad">CAMPROXY_FTP_PASSWORD not set</dd>{/if}
          <dt>Camera connects to</dt><dd>{$status.ftp.publicHost ?? '— (ftp.publicHost)'}</dd>
          {#if $status.ftp.camera}
            <dt>Camera upload</dt><dd class={camFtpClass($status.ftp.camera.state)} data-testid="camera-ftp-state">{cameraFtpText($status.ftp.camera)}</dd>
            <dt>Checked</dt><dd title={$status.ftp.camera.error ? `last read failed: ${$status.ftp.camera.error}` : undefined}>{ago($status.ftp.camera.checkedAt)}</dd>
          {/if}
          <dt>Last upload</dt><dd>{ago($status.ftp.lastUpload)}</dd>
          <dt>Last clip</dt><dd class={$status.ftp.stalled?.stalled ? 'bad' : ''} title={$status.ftp.lastClip ? clipTime($status.ftp.lastClip) : undefined}>{ago($status.ftp.lastClip)}</dd>
          <dt>Clips stored</dt><dd>{$status.ftp.clips}</dd>
          <dt>Failures</dt><dd class={$status.ftp.failures ? 'bad' : ''}>{$status.ftp.failures}</dd>
        </dl>
        {#if alerts.length}
          <div class="alerts">
            {#each alerts as a (a.kind)}<p class="bad alert" data-testid="ftp-alert" data-kind={a.kind} role="alert"><Icon name="alert" size={16} /><span>{a.text}</span></p>{/each}
            <button onclick={() => void pointFtpHere()} disabled={fixing} data-testid="ftp-alert-fix">Point the camera's FTP here</button>
            {#if fixResult}<p class="bad small" data-testid="ftp-fix-result">{fixResult}</p>{/if}
          </div>
        {/if}
      </div>
      <div class="card" data-testid="card-storage">
        <h3>Storage</h3>
        <dl>
          <dt>Stills</dt><dd>{gb($stats.disk.stills.bytes)}</dd>
          <dt>Previews</dt><dd>{mb($stats.disk.previews.bytes)}</dd>
          <dt>Clips</dt><dd>{gb($stats.disk.clips.bytes)}</dd>
          <dt>Catalog</dt><dd>{mb($stats.disk.catalog.bytes)}</dd>
          <dt>Audit log</dt><dd>{mb($stats.disk.audit.bytes)}</dd>
          <dt>Used / budget</dt><dd>{gb($stats.storage.used)} / {gb($stats.storage.budget)}</dd>
          <dt>Disk free</dt><dd>{gb($stats.disk.free)} of {gb($stats.disk.size)}</dd>
          <dt>Days until full</dt><dd data-testid="days-until-full">{daysUntilFullText($stats.storage.daysUntilFull)}</dd>
          <dt>Writing</dt><dd class={$stats.storage.paused ? 'bad' : 'ok'}>{$stats.storage.paused ? 'paused (disk full)' : 'on'}</dd>
          <dt>Last cleanup</dt><dd>{ago($status.retention.lastRun)}</dd>
        </dl>
      </div>
      <div class="card">
        <h3>Stream</h3>
        <dl>
          <dt>SSE clients</dt><dd>{$status.sse.clients}</dd>
          <dt>Stream log rows</dt><dd>{$stats.stream.rows}</dd>
          <dt>Last id</dt><dd>{$stats.stream.lastId}</dd>
          <dt>Version</dt><dd>{$status.version}</dd>
        </dl>
      </div>
    </div>
  {:else}
    <p class="muted">Loading…</p>
  {/if}
</section>

<style>
  section { display: grid; gap: 12px; }
  h2 { margin: 0; font-size: 20px; }
  h3 { margin: 0 0 8px; font-size: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; margin: 0; font-size: 14px; }
  dt { color: var(--muted); } dd { margin: 0; font-family: var(--mono); text-align: right; }
  .ok { color: #22c55e; } .bad { color: var(--danger); } .warn { color: #f59e0b; }
  .muted { color: var(--muted); }
  .small { font-size: 13px; margin: 0 0 8px; }
  .alerts { display: grid; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); justify-items: start; }
  .alert { display: flex; gap: 8px; align-items: flex-start; margin: 0; font-size: 14px; }
  .alert :global(svg) { flex: none; margin-top: 2px; }
  button { padding: 7px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); }
  button:hover { border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
