<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { envNameOf, passwordConfirmText, passwordError, PLAINTEXT_WARNING, retryMinutes } from '../lib/onboarding';

  // The camera's password (spec 2026-10-30-camera-onboarding-design §4.1):
  // write-only, checked with the camera before it is saved. The field is
  // cleared after every answer; the value goes nowhere else (no store, no URL).
  let { cam, name, host, plaintext = false, onclose, onsaved }: { cam: string; name: string; host: string; plaintext?: boolean; onclose: () => void; onsaved?: () => void } = $props();
  let password = $state('');
  let busy = $state(false);
  let message = $state('');
  let ok = $state(false);
  let input: HTMLInputElement;
  onMount(() => {
    const opener = document.activeElement as HTMLElement | null;
    input.focus();
    return () => opener?.focus?.();
  });

  async function save() {
    if (busy || !password) return;
    busy = true;
    const value = password;
    password = '';
    try {
      await api('PUT', `/control/cameras/${encodeURIComponent(cam)}/password`, { password: value });
      ok = true;
      message = 'Saved: the camera accepted it.';
      onsaved?.();
    } catch (e) {
      ok = false;
      const b = e instanceof ApiError ? (e.body as { error?: string; detail?: string } | null) : null;
      message = b?.error ? passwordError(b.error, { retryAfterS: retryMinutes(b.detail), envName: envNameOf(b.detail) }) : e instanceof ApiError ? e.message : 'Not saved.';
    }
    busy = false;
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="pw-title" tabindex="-1" data-testid="camera-password-dialog">
    <h3 id="pw-title">Camera password</h3>
    <p data-testid="camera-password-confirm">{passwordConfirmText(name, host)}</p>
    {#if plaintext}<p class="bad" data-testid="camera-password-plaintext">{PLAINTEXT_WARNING}</p>{/if}
    <p class="muted">The proxy logs in to the camera with it first; it is saved only on this proxy, and never shown again.</p>
    <form onsubmit={(e) => { e.preventDefault(); void save(); }}>
      <label>Password <input bind:this={input} type="password" autocomplete="off" bind:value={password} disabled={busy} data-testid="camera-password-input" /></label>
      <div class="buttons">
        <button type="button" onclick={onclose} data-testid="camera-password-cancel">{ok ? 'Close' : 'Cancel'}</button>
        <button type="submit" class="primary" disabled={busy || !password} data-testid="camera-password-save">{busy ? 'Checking…' : 'Save'}</button>
      </div>
    </form>
    {#if message}<p class={ok ? 'ok' : 'bad'} role="status" data-testid="camera-password-message">{message}</p>{/if}
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgb(0 0 0 / 0.5); display: grid; place-items: center; z-index: 50; padding: 16px; }
  .modal { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); width: min(480px, 100%); padding: 18px; display: grid; gap: 12px; }
  h3 { margin: 0; font-size: 16px; }
  p { margin: 0; line-height: 1.5; overflow-wrap: anywhere; }
  .muted { color: var(--muted); font-size: 13px; }
  form { display: grid; gap: 12px; }
  label { display: grid; gap: 6px; font-size: 14px; }
  input { padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  button { padding: 7px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; }
  button.primary { border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: default; }
  .ok { color: var(--accent); }
  .bad { color: var(--danger); }
</style>
