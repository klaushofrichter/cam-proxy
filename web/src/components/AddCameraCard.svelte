<script lang="ts">
  import { api, ApiError } from '../lib/api';
  import { newCameraProblem } from '../lib/camera-settings';
  import { addCameraBody, passwordError, retryMinutes, trustConfirmText } from '../lib/onboarding';
  import { lockedWhy, rights } from '../lib/rights';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import LockedNote from './LockedNote.svelte';

  // Add a camera (spec 2026-10-30-camera-onboarding-design §4.3): check it
  // (camera-probe: its ports and the certificate it serves), confirm that
  // certificate, then add it with its password in one call (POST
  // /control/cameras): the proxy logs in over exactly that certificate before
  // anything is stored. Also on a single-camera proxy (it writes CAMERA_HOST;
  // no restart). The local admin's only (issue #227). The password field is
  // cleared after every answer and never kept anywhere else.
  let { existing, prefill = '', onadded }: { existing: string[]; prefill?: string; onadded: (view: Record<string, unknown>) => void } = $props();
  let id = $state('');
  let name = $state('');
  let host = $state('');
  let protocol = $state<'https' | 'http'>('https');
  let user = $state('admin');
  let password = $state('');
  // FTP clip uploads: off until asked for (the passive range needs 10 ports per camera with FTP).
  let ftp = $state(false);
  let fingerprint = $state<string | null>(null);
  let probed = $state<{ fingerprint: string | null; ports: Record<string, boolean> } | null>(null);
  let confirming = $state(false);
  let busy = $state(false);
  let message = $state('');
  let touched = $state(false);
  $effect(() => {
    if (prefill) {
      host = prefill;
      probed = null;
      fingerprint = null;
    }
  });
  const problem = $derived(id.trim() ? newCameraProblem({ id: id.trim(), host }, existing) : newCameraProblem({ id: 'x', host }, []));
  const locked = $derived(lockedWhy($rights, 'local'));
  const needsTrust = $derived(protocol === 'https' && !fingerprint);

  async function check() {
    touched = true;
    if (problem || busy) return;
    busy = true;
    message = '';
    fingerprint = null;
    try {
      const r = await api<{ certificate: { fingerprint: string } | null; ports: Record<string, boolean> }>('POST', '/control/actions/camera-probe', { host: host.trim(), protocol });
      probed = { fingerprint: r.certificate?.fingerprint ?? null, ports: r.ports };
      if (protocol === 'https' && !r.certificate) message = 'The camera serves no certificate on HTTPS: check the address, or use http.';
      else if (protocol === 'https') confirming = true;
      else message = 'The camera answers. Enter its password and add it.';
    } catch (e) {
      message = `Not checked: ${e instanceof ApiError ? e.message : 'failed'}`;
    }
    busy = false;
  }

  async function add() {
    touched = true;
    if (problem || busy || !password || needsTrust) return;
    busy = true;
    message = '';
    const body = addCameraBody({ id, name, host, protocol, user, password, fingerprint, ftp });
    password = '';
    try {
      const r = await api<{ onboarding: { camera: string; ready: boolean } }>('POST', '/control/cameras', body);
      message = `Camera ${r.onboarding.camera} added; it starts now.`;
      id = name = host = '';
      probed = null;
      fingerprint = null;
      touched = false;
      onadded(r as unknown as Record<string, unknown>);
    } catch (e) {
      const b = e instanceof ApiError ? (e.body as { error?: string; detail?: string; line?: string } | null) : null;
      const known = ['camera_refused', 'camera_offline', 'too_many_attempts', 'fingerprint_mismatch'];
      message = b?.error && known.includes(b.error) ? passwordError(b.error, { retryAfterS: retryMinutes(b.detail) }) : `Not added: ${e instanceof ApiError ? e.message : 'failed'}${b?.line ? ` (add ${b.line} by hand)` : ''}`;
      if (b?.error === 'fingerprint_mismatch') fingerprint = null;
    }
    busy = false;
  }
</script>

<div class="card" data-testid="add-camera">
  <h3>Add a camera</h3>
  <p class="muted small">Check the camera first: its certificate is confirmed here, then the proxy logs in with the password you enter (it keeps it only on this proxy, never shown again) and starts the camera at once.</p>
  <form class="grid" onsubmit={(e) => { e.preventDefault(); void add(); }}>
    <label>Id <input bind:value={id} placeholder="cam6" autocomplete="off" data-testid="add-camera-id" /></label>
    <label>Name <input bind:value={name} placeholder="(the camera's)" autocomplete="off" data-testid="add-camera-name" /></label>
    <label>Address <input bind:value={host} oninput={() => ((probed = null), (fingerprint = null))} placeholder="192.0.2.16" autocomplete="off" data-testid="add-camera-host" /></label>
    <label>Protocol
      <select bind:value={protocol} onchange={() => ((probed = null), (fingerprint = null))} data-testid="add-camera-protocol"><option value="https">https</option><option value="http">http</option></select>
    </label>
    <label>User <input bind:value={user} autocomplete="off" data-testid="add-camera-user" /></label>
    <label>Password <input type="password" bind:value={password} autocomplete="off" data-testid="add-camera-password" /></label>
    <label class="check"><input type="checkbox" bind:checked={ftp} data-testid="add-camera-ftp" /> Clip uploads (FTP)</label>
    <div class="row">
      <button type="button" onclick={() => void check()} disabled={!!locked || busy} data-testid="add-camera-check">Check camera</button>
      <button type="submit" disabled={!!locked || busy || !password || needsTrust} title={locked ?? (needsTrust ? 'Check the camera and confirm its certificate first' : undefined)} data-testid="add-camera-save">Add</button>
    </div>
  </form>
  {#if fingerprint}<p class="small" data-testid="add-camera-fingerprint">Certificate confirmed: <span class="mono">{fingerprint}</span></p>{/if}
  <LockedNote why={locked} testid="add-camera-locked" />
  {#if touched && problem}<p class="field-error" data-testid="add-camera-problem">{problem}</p>{/if}
  {#if message}<p class="msg" role="status" data-testid="add-camera-message">{message}</p>{/if}
</div>

{#if confirming && probed?.fingerprint}
  {@const fp = probed.fingerprint}
  <ConfirmDialog title="Trust this camera's certificate" message={trustConfirmText(name.trim() || host.trim(), fp)} confirmLabel="Trust" oncancel={() => (confirming = false)} onconfirm={() => ((fingerprint = fp), (confirming = false), (message = 'Certificate confirmed. Enter the password and add the camera.'))} />
{/if}

<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
  h3 { margin: 0 0 6px; font-size: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; align-items: end; }
  label { display: grid; gap: 4px; font-size: 13px; }
  label.check { display: flex; align-items: center; gap: 6px; }
  input, select { padding: 4px 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; }
  .row { display: flex; gap: 6px; }
  button { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); }
  button:hover { border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: default; }
  .muted { color: var(--muted); margin: 0 0 8px; }
  .small { font-size: 13px; }
  .mono { font-family: var(--mono); overflow-wrap: anywhere; }
  .msg { margin: 8px 0 0; color: var(--accent); }
  .field-error { margin: 8px 0 0; font-size: 12px; color: #ef4444; }
</style>
