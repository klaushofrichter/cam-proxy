<script lang="ts">
  import { onMount } from 'svelte';

  // An in-page confirmation (not window.confirm) for the Maintenance page's
  // camera reboot and proxy restart (#71, #83). Focus starts on Cancel, stays
  // inside the dialog, and goes back to the opener; Esc, Cancel and a click
  // on the backdrop send nothing.
  let { title, message, confirmLabel, onconfirm, oncancel }: { title: string; message: string; confirmLabel: string; onconfirm: () => void; oncancel: () => void } = $props();
  let dialog: HTMLDivElement;
  let cancelButton: HTMLButtonElement;
  onMount(() => {
    const opener = document.activeElement as HTMLElement | null;
    cancelButton.focus();
    return () => opener?.focus?.();
  });
  function onkey(e: KeyboardEvent) {
    if (e.key !== 'Tab') return;
    const f = [...dialog.querySelectorAll<HTMLElement>('button')];
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
    <div class="buttons">
      <button bind:this={cancelButton} onclick={oncancel} data-testid="confirm-cancel">Cancel</button>
      <button class="danger" onclick={onconfirm} data-testid="confirm-ok">{confirmLabel}</button>
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
</style>
