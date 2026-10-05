<script lang="ts">
  import { onMount } from 'svelte';

  // An in-page confirmation (not window.confirm) for the Maintenance page's
  // camera reboot and proxy restart (#71, #83). Focus starts on Cancel, stays
  // inside the dialog, and goes back to the opener; Esc, Cancel and a click
  // on the backdrop send nothing. `typed` (Clear the Archive): the confirm
  // button works only once the text field matches; focus starts there.
  let { title, message, confirmLabel, onconfirm, oncancel, typed }: { title: string; message: string; confirmLabel: string; onconfirm: () => void; oncancel: () => void; typed?: { label: string; matches: (v: string) => boolean } } = $props();
  let dialog: HTMLDivElement;
  let cancelButton: HTMLButtonElement;
  let input = $state<HTMLInputElement>();
  let value = $state('');
  const ready = $derived(!typed || typed.matches(value));
  onMount(() => {
    const opener = document.activeElement as HTMLElement | null;
    (input ?? cancelButton).focus();
    return () => opener?.focus?.();
  });
  function confirm() {
    if (ready) onconfirm();
  }
  function onkey(e: KeyboardEvent) {
    if (e.key !== 'Tab') return;
    const f = [...dialog.querySelectorAll<HTMLElement>('input, button:not(:disabled)')];
    const i = f.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i + 1) % f.length;
    f[next].focus();
    e.preventDefault();
  }
</script>

<!-- Esc cancels wherever the focus is. -->
<svelte:window onkeydown={(e) => e.key === 'Escape' && oncancel()} />
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => e.target === e.currentTarget && oncancel()}>
  <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message" tabindex="-1" bind:this={dialog} onkeydown={onkey} data-testid="confirm-dialog">
    <h3 id="confirm-title">{title}</h3>
    <p id="confirm-message" data-testid="confirm-message">{message}</p>
    {#if typed}
      <label class="typed">{typed.label}
        <input bind:this={input} bind:value inputmode="numeric" autocomplete="off" data-testid="confirm-typed" onkeydown={(e) => e.key === 'Enter' && confirm()} />
      </label>
    {/if}
    <div class="buttons">
      <button bind:this={cancelButton} onclick={oncancel} data-testid="confirm-cancel">Cancel</button>
      <button class="danger" onclick={confirm} disabled={!ready} data-testid="confirm-ok">{confirmLabel}</button>
    </div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgb(0 0 0 / 0.5); display: grid; place-items: center; z-index: 50; padding: 16px; }
  .modal { background: var(--surface); border: 1px solid var(--danger); border-radius: var(--radius); width: min(480px, 100%); padding: 18px; display: grid; gap: 12px; }
  h3 { margin: 0; font-size: 16px; }
  p { margin: 0; line-height: 1.5; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  button { padding: 7px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button.danger { border-color: var(--danger); background: var(--danger); color: #fff; }
  button:disabled { opacity: 0.5; cursor: default; }
  .typed { display: grid; gap: 6px; font-size: 14px; }
  .typed input { padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font-family: var(--mono); }
</style>
