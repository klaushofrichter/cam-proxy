<script lang="ts">
  import { api, ApiError } from '../lib/api';
  import { STEP_LABELS, stepLine, trustNeeded, type OnboardingStatus, type StepName } from '../lib/onboarding';
  import CameraPasswordDialog from './CameraPasswordDialog.svelte';
  import TrustCertificateDialog from './TrustCertificateDialog.svelte';

  // One camera's onboarding status (spec 2026-10-30-camera-onboarding-design
  // §4.5): each step, why it isn't done, and the password and trust fixes
  // (both also open to a cams-admin sign-in, §10).
  let { cam, name, refreshKey }: { cam: string; name: string; refreshKey?: unknown } = $props();
  // The camera's address as it runs (the confirm line names it).
  let host = $state('');
  let st = $state<OnboardingStatus | null>(null);
  let error = $state('');
  let message = $state('');
  let pwOpen = $state(false);
  let trustFp = $state<string | null>(null);

  async function load() {
    try {
      st = await api<OnboardingStatus>('GET', `/control/cameras/${encodeURIComponent(cam)}/onboarding`);
      host = (await api<{ address?: string }>('GET', `/api/cameras/${encodeURIComponent(cam)}`).catch(() => ({ address: '' }))).address || cam;
      error = '';
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'not read';
    }
  }
  $effect(() => {
    void refreshKey;
    void cam;
    void load();
  });
  const pinFp = $derived(st ? trustNeeded(st) : null);
</script>

<div class="card" data-testid="card-onboarding">
  <div class="head">
    <h3>Onboarding</h3>
    {#if st}<span class="badge {st.ready ? 'ok' : 'bad'}" data-testid="onboarding-ready">{st.ready ? 'ready' : 'not ready'}</span>{/if}
  </div>
  {#if error}<p class="bad">{error}</p>{/if}
  {#if st}
    <ul>
      {#each Object.keys(STEP_LABELS) as n (n)}
        {@const s = st.steps[n as StepName]}
        <li class={s.ok === true ? 'ok' : s.ok === false ? 'bad' : 'muted'} data-testid="onboarding-step-{n}" data-ok={String(s.ok)}>{stepLine(n as StepName, s)}</li>
      {/each}
    </ul>
  {/if}
  <div class="buttons">
    <button onclick={() => (pwOpen = true)} data-testid="onboarding-password">Camera password</button>
    {#if pinFp}<button onclick={() => (trustFp = pinFp)} data-testid="onboarding-trust">Trust this camera's certificate</button>{/if}
  </div>
  {#if message}<p class="msg" role="status" data-testid="onboarding-message">{message}</p>{/if}
</div>

{#if pwOpen}<CameraPasswordDialog {cam} {name} {host} onclose={() => (pwOpen = false)} onsaved={() => void load()} />{/if}
{#if trustFp}
  {@const fp = trustFp}
  <TrustCertificateDialog {cam} {name} fingerprint={fp} onclose={() => (trustFp = null)} ondone={(m) => ((message = m), void load())} />
{/if}

<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; gap: 8px; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  h3 { margin: 0; font-size: 16px; }
  ul { margin: 0; padding-left: 1.1rem; font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
  .badge { font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid currentColor; }
  .ok { color: var(--accent); }
  .bad { color: var(--danger); }
  .muted { color: var(--muted); }
  .msg { margin: 0; color: var(--accent); }
  .buttons { display: flex; gap: 8px; flex-wrap: wrap; }
  button { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); }
  button:hover { border-color: var(--accent); }
</style>
