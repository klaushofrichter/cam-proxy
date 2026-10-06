<script lang="ts">
  import { status, stats } from '../lib/state';
  import { pausedText, usageLine, usageRows } from '../lib/analytics';
  import { agoText, daysUntilFullText, mbText } from '../lib/format';
  import { cameraStateText, poeLine } from '../lib/maintenance';
  import { cacheFillText, recordingsClass, recordingsLastText } from '../lib/recordings';
  import { cameraFtpText, clipTime, ftpAlerts } from '../lib/ftp';
  import { api, ApiError } from '../lib/api';
  import { refresh } from '../lib/state';
  import Icon from '../components/Icon.svelte';
  import { cameraUploadClass, lastClipClass, diskText, healthHeadline, itemOf, loadText, memoryText, piCardTitle, problemOf, uptimeText } from '../lib/health';
  import { archiveRows } from '../lib/archive';
  import { storageRows } from '../lib/camera-settings';
  import { cameraIds } from '../lib/cameras';
  import { actionPath, blockOf, selectedCamera } from '../lib/cameras';

  const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
  const mb = mbText;
  const ago = (ts?: number | null) => agoText(ts);

  // The health summary decides the red marks it shares with the cards below
  // (spec 2026-10-03-health-summary-design A3).
  const health = $derived($status?.health);
  // The selected camera's block (several cameras), else the only one's
  // (spec 2026-10-05-multi-camera-host-design §16 P1: read-only per camera).
  // Non-null wherever $status is.
  const cs = $derived(blockOf($status, $selectedCamera)!);
  const camHealth = $derived(health?.cameras?.find((c) => c.camera.id === cs?.id));
  // The camera items of the selected camera; the host items as they are.
  const bad = (id: string) => (['camera', 'stream', 'events', 'ftp'].includes(id) && camHealth ? !!camHealth.items.find((i) => i.id === id)?.problem : problemOf(health, id));
  const hostItem = (id: string) => itemOf(health, id);

  // #93: the camera's FTP upload off, elsewhere, or no clips while events happen.
  const alerts = $derived($status ? ftpAlerts({ enabled: cs.ftp.enabled, publicHost: cs.ftp.publicHost, camera: cs.ftp.camera ?? null, stalled: cs.ftp.stalled ?? null }) : []);
  let fixing = $state(false);
  let fixResult = $state('');
  async function pointFtpHere() {
    if (fixing) return;
    fixing = true;
    fixResult = '';
    try {
      await api('POST', actionPath($status, $selectedCamera, 'camera-ftp-setup'));
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
      {#if health}
        <div class="card health" data-testid="card-health">
          <div class="health-head">
            <h3>Health</h3>
            <span class="headline {health.ok ? 'ok' : 'bad'}" data-testid="health-headline">{#if !health.ok}<Icon name="alert" size={16} />{/if}{healthHeadline(health)}</span>
          </div>
          <dl class="health-items">
            {#each health.items as it (it.id)}
              <div class="hitem" class:problem={it.problem} data-testid="health-item-{it.id}" data-problem={it.problem}>
                <dt>{it.label}</dt><dd class={it.problem ? 'bad' : ''}>{it.text}</dd>
              </div>
            {/each}
          </dl>
        </div>
      {/if}
      <div class="card" data-testid="card-camera">
        <h3>Camera</h3>
        <dl>
          <dt>Name</dt><dd data-testid="camera-name" title={cs.camera.nameSource === 'config' ? 'not read from the camera yet: the configured name' : 'stored on the camera'}>{cs.camera.name ?? '—'}{#if cs.camera.nameSource === 'config'} <span class="muted">(configured)</span>{/if}</dd>
          <dt>State</dt><dd class={cs.camera.reboot?.phase === 'rebooting' || cs.camera.reboot?.phase === 'power-cycling' ? 'warn' : (health ? bad('camera') : !cs.camera.online) ? 'bad' : 'ok'} data-testid="camera-state">{cameraStateText(cs.camera)}</dd>
          <dt>Since</dt><dd>{ago(cs.camera.since)}</dd>
          <dt>Model</dt><dd>{#if cs.camera.model && cs.camera.webUiUrl}<a href={cs.camera.webUiUrl} target="_blank" rel="noopener noreferrer" title="The camera's own web page">{cs.camera.model}</a>{:else}{cs.camera.model ?? '—'}{/if}</dd>
          <dt>Firmware</dt><dd>{cs.camera.firmware ?? '—'}</dd>
          <dt>Clock offset</dt><dd>{cs.camera.clockOffsetMs === undefined ? '—' : `${(cs.camera.clockOffsetMs / 1000).toFixed(1)} s`}</dd>
          {#if cs.camera.poeSwitch && cs.camera.poeSwitch.model !== 'none'}<dt>PoE switch</dt><dd data-testid="camera-poe">{poeLine(cs.camera.poeSwitch)}</dd>{/if}
          {#if cs.camera.error}<dt>Last error</dt><dd class="bad">{cs.camera.error}</dd>{/if}
        </dl>
      </div>
      <div class="card" data-testid="card-intake">
        <h3>Events</h3>
        <dl>
          <dt>ONVIF</dt><dd class={(health ? bad('events') : cs.intake.onvif !== 'subscribed') ? 'bad' : 'ok'} data-testid="onvif-state">{cs.intake.onvif}</dd>
          <dt>Source</dt><dd>{cs.intake.source}</dd>
          <dt>Re-subscriptions</dt><dd>{cs.intake.resubscribes}</dd>
          {#if cs.intake.lastError}<dt>Last error</dt><dd class="bad">{cs.intake.lastError}</dd>{/if}
          {#each Object.entries(cs.id && $stats.events.byCamera ? ($stats.events.byCamera[cs.id] ?? {}) : $stats.events.stored) as [kind, n] (kind)}<dt>{kind} events</dt><dd>{n}</dd>{/each}
        </dl>
      </div>
      {#each ($status.analytics ?? []).filter((a) => a.enabled) as a (a.id)}
        <div class="card" data-testid={`card-analytics-${a.id}`}>
          <h3>Analytics · {a.name}</h3>
          <dl>
            {#each usageRows(a) as r (r.key)}<dt>{r.label}</dt><dd data-testid={`analytics-usage-${r.key}`}>{r.text}</dd>{:else}<dt>Usage</dt><dd data-testid="analytics-usage">{usageLine(a)}</dd>{/each}
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
          <dt>Stream</dt><dd class={(health ? bad('stream') : !cs.stream.up) ? 'bad' : cs.stream.up ? 'ok' : ''} data-testid="stream-state">{cs.stream.enabled ? (cs.stream.up ? 'up' : 'down') : 'off'}</dd>
          <dt>go2rtc</dt><dd class={cs.stream.go2rtcUp ? 'ok' : 'bad'}>{cs.stream.go2rtcUp ? 'running' : 'stopped'}</dd>
          <dt>Last still</dt><dd>{ago(cs.stream.lastFrameTs)}</dd>
          <dt>Still minutes</dt><dd>{$stats.disk.stills.files}</dd>
          <dt>Preview minutes</dt><dd>{Math.round($stats.disk.previews.files / 2)}</dd>
        </dl>
      </div>
      <div class="card" data-testid="card-ftp">
        <h3>Clips (FTP)</h3>
        <dl>
          <dt>Server</dt><dd class={cs.ftp.listening ? 'ok' : cs.ftp.enabled ? 'bad' : ''} data-testid="ftp-state">{cs.ftp.enabled ? (cs.ftp.listening ? `listening on ${cs.ftp.port}${cs.ftp.tls ? ' (FTPS)' : ''}` : 'not listening') : 'off'}</dd>
          {#if cs.ftp.enabled && !cs.ftp.passwordSet}<dt>Password</dt><dd class="bad">CAMPROXY_FTP_PASSWORD not set</dd>{/if}
          <dt>Camera connects to</dt><dd>{cs.ftp.publicHost ?? '— (ftp.publicHost)'}</dd>
          {#if cs.ftp.camera}
            <dt>Camera upload</dt><dd class={cameraUploadClass(health, cs.ftp.camera.state)} data-testid="camera-ftp-state">{cameraFtpText(cs.ftp.camera)}</dd>
            <dt>Checked</dt><dd title={cs.ftp.camera.error ? `last read failed: ${cs.ftp.camera.error}` : undefined}>{ago(cs.ftp.camera.checkedAt)}</dd>
          {/if}
          <dt>Last upload</dt><dd>{ago(cs.ftp.lastUpload)}</dd>
          <dt>Last clip</dt><dd class={lastClipClass(health, cs.ftp.stalled?.stalled === true)} data-testid="ftp-last-clip" title={cs.ftp.lastClip ? clipTime(cs.ftp.lastClip) : undefined}>{ago(cs.ftp.lastClip)}</dd>
          <dt>Clips stored</dt><dd>{cs.ftp.clips}</dd>
          <dt>Failures</dt><dd class={cs.ftp.failures ? 'bad' : ''}>{cs.ftp.failures}</dd>
        </dl>
        {#if alerts.length}
          <div class="alerts">
            {#each alerts as a (a.kind)}<p class="alert {a.level}" data-testid="ftp-alert" data-kind={a.kind} role={a.level === 'info' ? 'note' : 'alert'}><Icon name={a.level === 'info' ? 'about' : 'alert'} size={16} /><span>{a.text}</span></p>{/each}
            <button onclick={() => void pointFtpHere()} disabled={fixing} data-testid="ftp-alert-fix">Point the camera's FTP here</button>
            {#if fixResult}<p class="bad small" data-testid="ftp-fix-result">{fixResult}</p>{/if}
          </div>
        {/if}
      </div>
      {#if cs.recordings}
        <div class="card" data-testid="card-recordings">
          <h3>Recordings (SD card)</h3>
          <dl>
            <dt>Last download</dt><dd class={recordingsClass(cs.recordings.last)} data-testid="recordings-last" title={cs.recordings.last ? `${cs.recordings.last.result}, ${clipTime(cs.recordings.last.at)}` : undefined}>{recordingsLastText(cs.recordings.last)}</dd>
            <dt>Cache</dt><dd data-testid="recordings-cache">{cacheFillText(cs.recordings.cache)}</dd>
            <dt>Files cached</dt><dd>{cs.recordings.cache.files}</dd>
          </dl>
        </div>
      {/if}
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
          {#if health?.disk}<dt>Disk used</dt><dd class={bad('disk') ? 'bad' : ''} data-testid="storage-disk" title={`a problem from ${health.thresholds.diskPercent} % (health.diskPercent)`}>{health.disk.usedPercent.toFixed(1)} %</dd>{/if}
          <dt>Days until full</dt><dd data-testid="days-until-full">{daysUntilFullText($stats.storage.daysUntilFull)}</dd>
          <dt>Writing</dt><dd class={(health ? bad('storage') : $stats.storage.paused) ? 'bad' : 'ok'} data-testid="storage-writing">{$stats.storage.paused ? 'paused (disk full)' : 'on'}</dd>
          {#each storageRows($stats.cameras, cameraIds($status)) as row (row.id)}<dt>{row.id}</dt><dd class="small" data-testid="storage-camera-{row.id}">{row.text}</dd>{/each}
          <dt>Last cleanup</dt><dd>{ago($status.retention.lastRun)}</dd>
        </dl>
      </div>
      {#if $status.archive}
        <!-- Spec 2026-10-05-archive-design §6: clips kept apart from retention. -->
        <div class="card" data-testid="card-archive">
          <h3>Archive</h3>
          <dl>
            {#each archiveRows($status.archive) as r (r.key)}<dt>{r.label}</dt><dd class={r.bad ? 'bad' : ''} title={r.title} data-testid={`archive-${r.key}`}>{r.text}</dd>{/each}
          </dl>
        </div>
      {/if}
      {#if health?.host}
        <div class="card" data-testid="card-pi">
          <h3>{piCardTitle(health.platform)}</h3>
          <dl>
            {#if health.platform.model}<dt>Model</dt><dd class="wrap" data-testid="pi-model">{health.platform.model}</dd>{/if}
            {#if hostItem('cpuTemp')}<dt>CPU temperature</dt><dd class={bad('cpuTemp') ? 'bad' : ''} data-testid="pi-temp" title={`a problem from ${health.thresholds.tempC} °C (health.tempC)`}>{hostItem('cpuTemp')?.text}</dd>{/if}
            {#if hostItem('underVoltage')}<dt>Under-voltage</dt><dd class={bad('underVoltage') ? 'bad' : ''} data-testid="pi-voltage">{hostItem('underVoltage')?.text}</dd>{/if}
            {#if health.host.memory}<dt>Memory</dt><dd>{memoryText(health.host.memory)}</dd>{/if}
            {#if health.host.uptimeS !== null}<dt>Uptime</dt><dd>{uptimeText(health.host.uptimeS)}</dd>{/if}
            {#if health.host.load}<dt>Load</dt><dd>{loadText(health.host.load)}</dd>{/if}
            {#if health.disk}<dt>Disk</dt><dd class={bad('disk') ? 'bad' : ''} data-testid="pi-disk">{diskText(health.disk)}</dd>{/if}
          </dl>
        </div>
      {/if}
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
  .ok { color: #22c55e; } .bad { color: var(--danger); } .warn { color: #f59e0b; } .info { color: var(--muted); }
  .muted { color: var(--muted); }
  .health { grid-column: 1 / -1; }
  .health-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
  .health-head h3 { margin: 0; }
  .headline { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 14px; }
  .headline :global(svg) { flex: none; }
  .health-items { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 4px 24px; }
  .hitem { display: grid; grid-template-columns: 1fr auto; gap: 12px; padding: 2px 0; }
  .hitem.problem dt { color: var(--danger); }
  .wrap { white-space: normal; overflow-wrap: anywhere; }
  .small { font-size: 13px; margin: 0 0 8px; }
  .alerts { display: grid; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); justify-items: start; }
  .alert { display: flex; gap: 8px; align-items: flex-start; margin: 0; font-size: 14px; }
  .alert :global(svg) { flex: none; margin-top: 2px; }
  button { padding: 7px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); }
  button:hover { border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
