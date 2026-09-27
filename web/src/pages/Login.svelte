<script lang="ts">
  import { login } from '../lib/api';
  let token = $state('');
  let error = $state('');
  let busy = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = '';
    const ok = await login(token).catch(() => false);
    token = ''; // never kept once sent
    busy = false;
    if (!ok) error = 'That token was not accepted.';
  }
</script>

<div class="wrap">
  <form class="card" onsubmit={submit}>
    <h1>cam-proxy</h1>
    <p class="muted">The gateway next to the camera. Sign in with the admin token (<code>CAMPROXY_ADMIN_TOKEN</code>).</p>
    <label>
      Admin token
      <input data-testid="token-input" type="password" autocomplete="off" bind:value={token} required />
    </label>
    {#if error}<p class="err" data-testid="login-error" role="alert">{error}</p>{/if}
    <button data-testid="login-submit" disabled={busy}>Sign in</button>
    <p class="muted small">The token is exchanged for a session cookie and not stored in this browser.</p>
  </form>
</div>

<style>
  .wrap { min-height: 100vh; display: grid; place-items: center; padding: 16px; }
  .card { width: min(420px, 100%); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 28px; box-shadow: var(--shadow); display: grid; gap: 14px; }
  h1 { margin: 0; font-size: 22px; background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent; }
  label { display: grid; gap: 6px; font-weight: 600; }
  input { padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; }
  button { padding: 10px; border: 0; border-radius: 8px; background: var(--grad); color: var(--on-grad); font-weight: 600; cursor: pointer; }
  button:disabled { opacity: 0.6; }
  .muted { color: var(--muted); margin: 0; }
  .small { font-size: 13px; }
  .err { color: var(--danger); margin: 0; }
  code { font-family: var(--mono); font-size: 13px; }
</style>
