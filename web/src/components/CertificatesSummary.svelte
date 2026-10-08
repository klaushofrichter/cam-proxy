<script lang="ts">
  import { certRows, certWarnings, dateText, type TlsView } from '../lib/tls';
  import Icon from './Icon.svelte';

  // The Status page's short Certificates card (#203): the site, the CA's end
  // and one line per camera; the fingerprints, downloads and "Push now" are on
  // the Certificates page.
  let { view, names }: { view: TlsView; names: Record<string, string | undefined> } = $props();
  const now = $derived(Date.now());
  const rows = $derived(certRows(view, names, now));
  const warnings = $derived(certWarnings(view));
</script>

<div class="card" data-testid="card-certificates">
  <div class="head">
    <h3>Certificates</h3>
    <a href="#/certificates" class="details" data-testid="certificates-details-link">Details →</a>
  </div>
  <dl>
    <dt>Site</dt><dd><span class="ell" data-testid="summary-cert-site">{view.site}</span></dd>
    <dt>CA valid until</dt><dd data-testid="summary-cert-ca-until">{dateText(view.caNotAfter)}</dd>
  </dl>
  {#if rows.length}
    <ul class="cams">
      {#each rows as r (r.id)}
        <li data-testid="summary-cert-row-{r.id}">
          <span class="name" title={r.id}>{r.name}</span>
          <span class="line" class:bad={r.bad}><span class="nw">{r.mode}</span>{#if r.expires}{' · '}<span class="nw">{r.expires}</span>{/if}{#if r.push}{' · '}<span class="nw">{r.push}</span>{/if}</span>
        </li>
      {/each}
    </ul>
  {/if}
  {#each warnings as w (w)}<p class="warn" data-testid="summary-cert-warning"><Icon name="alert" size={14} /><span>{w}</span></p>{/each}
</div>

<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; gap: 8px; align-content: start; min-width: 0; }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  h3 { margin: 0; font-size: 16px; }
  .details { font-size: 13px; color: var(--accent); text-decoration: none; white-space: nowrap; }
  .details:hover { text-decoration: underline; }
  p { margin: 0; }
  dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; margin: 0; font-size: 14px; align-items: baseline; }
  dt { color: var(--muted); white-space: nowrap; }
  dd { margin: 0; font-family: var(--mono); text-align: right; min-width: 0; }
  .ell { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
  .cams { list-style: none; margin: 0; padding: 8px 0 0; border-top: 1px solid var(--border); display: grid; gap: 6px; font-size: 13px; }
  .cams li { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr); gap: 2px 12px; align-items: baseline; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 14ch; }
  .line { font-family: var(--mono); text-align: right; color: var(--muted); }
  .nw { white-space: nowrap; }
  .bad { color: var(--danger); }
  .warn { display: flex; gap: 6px; align-items: flex-start; color: #f59e0b; font-size: 13px; }
  .warn :global(svg) { flex: none; margin-top: 2px; }
</style>
