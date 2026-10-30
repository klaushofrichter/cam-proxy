<script lang="ts">
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { api, ApiError } from '../lib/api';
  import { passwordError, trustConfirmText } from '../lib/onboarding';

  // Trust this camera's certificate (spec 2026-10-30-camera-onboarding-design
  // §4.4): the fingerprint the proxy measured, never typed; pinned only when
  // the camera still serves it.
  let { cam, name, fingerprint, onclose, ondone }: { cam: string; name: string; fingerprint: string; onclose: () => void; ondone: (message: string) => void } = $props();

  async function pin() {
    // Read before closing: the props are gone once the dialog is.
    const [c, n, fp, done] = [cam, name, fingerprint, ondone];
    onclose();
    try {
      await api('POST', `/control/cameras/${encodeURIComponent(c)}/actions/camera-trust-pin`, { fingerprint: fp });
      done(`Certificate of ${n} trusted.`);
    } catch (e) {
      const b = e instanceof ApiError ? (e.body as { error?: string } | null) : null;
      done(b?.error === 'fingerprint_mismatch' ? passwordError('fingerprint_mismatch') : `Not trusted: ${e instanceof ApiError ? e.message : 'failed'}`);
    }
  }
</script>

<ConfirmDialog title="Trust this camera's certificate" message={trustConfirmText(name, fingerprint)} confirmLabel="Trust" oncancel={onclose} onconfirm={() => void pin()} />
