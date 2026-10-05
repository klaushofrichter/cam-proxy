<script lang="ts">
  import { refresh, refreshTick, status } from '../lib/state';
  import { cameraNameProblem, CAMERA_NAME_MAX, nameSaveError } from '../lib/camera-name';
  import { multiCamera } from '../lib/cameras';
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import AnalyticsSettings from '../components/AnalyticsSettings.svelte';
  import PoeSwitchCard from '../components/PoeSwitchCard.svelte';
  import FindCameraCard from '../components/FindCameraCard.svelte';
  import { envNote, isEnvSet } from '../lib/find-camera';

  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import { parseSetting, resetCounts, resetLabel, resetPlan, sameBadge, type ResetTo, type SettingType } from '../lib/settings';

  // `env`: the variable that sets it (source env: read-only here).
  // `legacy`: read from a legacy `camera` object in config.json.
  interface Setting { value: unknown; source: 'default' | 'file' | 'override' | 'env'; env?: string; restart: boolean; pending: boolean; next?: unknown; type?: SettingType; resetTo?: ResetTo; legacy?: true }
  let view = $state<Record<string, Setting>>({});
  let drafts = $state<Record<string, string>>({});
  let message = $state('');

  const groups = $derived(Object.keys(view).filter((p) => !p.startsWith('analytics.')).reduce<Record<string, string[]>>((g, p) => ((g[p.split('.')[0]] ??= []).push(p), g), {}));
  const load = async () => (view = await api<Record<string, Setting>>('GET', '/control/config'));
  onMount(() => void load());
  $effect(() => {
    if ($refreshTick) void load();
  });

  // A draft's text as the setting's type (numbers and booleans stay typed,
  // also for an optional setting without a value).
  const parse = (path: string, text: string): unknown => parseSetting(view[path].type, view[path].value, text);
  const nest = (path: string, v: unknown) => path.split('.').reduceRight<unknown>((acc, k) => ({ [k]: acc }), v);

  async function save(path: string) {
    try {
      view = await api('PUT', '/control/config', nest(path, parse(path, drafts[path])));
      delete drafts[path];
      // A value equal to config.json's or the default removes the override.
      const kept = view[path].source === 'override';
      message = kept ? `${path} saved${view[path].restart ? ' (applies after a restart)' : ''}` : `${path} saved: the same as the ${view[path].source === 'file' ? 'config.json value' : 'default'}, so no override is kept`;
      void refresh();
    } catch (e) {
      message = e instanceof ApiError ? e.message : 'not saved';
    }
  }
  async function reset(path: string) {
    view = await api('DELETE', `/control/config/${encodeURIComponent(path)}`);
    void refresh();
    message = `${path} is back to its ${view[path].source} value`;
  }
  // "Reset to defaults": every override at once (one request, one audit
  // record), after a confirmation that lists what changes.
  const overrides = $derived(Object.values(view).filter((s) => s.source === 'override').length);
  // `counts`: overrides that change something, and those equal to the default.
  let asking = $state<string[] | null>(null);
  let counts = $state({ changes: 0, same: 0 });
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  function askResetAll() {
    counts = resetCounts(view);
    asking = resetPlan(view);
  }
  const askMessage = $derived(counts.changes ? `${plural(counts.changes, 'setting', 'settings')} changed here go${counts.changes === 1 ? 'es' : ''} back to the value in config.json or the built-in default:` : 'Nothing changes in effect: every override equals the value in config.json or the built-in default.');
  const askLabel = $derived(counts.changes ? `Reset ${plural(counts.changes, 'setting', 'settings')}` : `Remove ${plural(counts.same, 'override', 'overrides')}`);
  async function resetAll() {
    const n = counts.changes;
    asking = null;
    try {
      view = await api('DELETE', '/control/config');
      drafts = {};
      message = n ? `${plural(n, 'setting', 'settings')} back to ${n === 1 ? 'its' : 'their'} default${Object.values(view).some((s) => s.pending) ? ' (restart to apply some)' : ''}` : `${plural(counts.same, 'override', 'overrides')} equal to the default removed`;
      void refresh();
    } catch (e) {
      message = e instanceof ApiError ? e.message : 'not reset';
    }
  }
  async function restart() {
    await api('POST', '/control/actions/restart');
    message = 'Restarting the camera side…';
    setTimeout(() => void load(), 1500);
  }
  // The camera's name is stored on the camera (camera-name design): the
  // camera.name row edits it there; the configured value is only the
  // fallback until the camera was read, set in config.json.
  let nameDraft = $state<string | undefined>(undefined);
  let nameSaving = $state(false);
  let nameError = $state('');
  const nameProblem = $derived(nameDraft === undefined ? null : cameraNameProblem(nameDraft));
  async function saveName() {
    if (nameDraft === undefined || nameProblem) return;
    nameSaving = true;
    nameError = '';
    try {
      const r = await api<{ name: string }>('PUT', '/control/camera/name', { name: nameDraft });
      nameDraft = undefined;
      message = `Camera name saved on the camera: ${r.name}`;
      void refresh();
    } catch (e) {
      nameError = e instanceof ApiError ? nameSaveError(e.status, e.body) : 'Not saved';
    } finally {
      nameSaving = false;
    }
  }

  const shown = (v: unknown) => (v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
</script>

<section>
  <div class="head">
    <h2>Settings</h2>
    <div class="head-buttons">
      {#if overrides}<button onclick={askResetAll} data-testid="reset-all">Reset to defaults</button>{/if}
      {#if Object.values(view).some((s) => s.pending)}<button onclick={() => void restart()} data-testid="restart">Restart to apply</button>{/if}
    </div>
  </div>
  <p class="muted small">From config.json, with changes made here kept as overrides in the data folder. Settings marked "set in .env" come from the environment (CAMERA_HOST, PI_ADDRESS) and win over both; change them in the .env file. Secrets are never shown or set here.</p>
  {#if message}<p class="msg" data-testid="settings-message">{message}</p>{/if}
  <AnalyticsSettings {view} onsaved={(v) => (view = v as Record<string, Setting>)} />
  <FindCameraCard />
  <PoeSwitchCard />
  {#each Object.entries(groups) as [group, paths] (group)}
    <div class="card">
      <h3>{group}</h3>
      <table>
        <tbody>
          {#each paths as p (p)}
            {@const s = view[p]}
            {@const same = s.source === 'override' ? sameBadge(p, s.resetTo) : null}
            {#if /^cameras\.[^.]+\.name$/.test(p) && !multiCamera($status)}
            <tr data-testid="setting-camera-name">
              <td><label for="camera-name">Camera name (stored on the camera)</label></td>
              <td>
                <input id="camera-name" value={nameDraft ?? $status?.camera.name ?? ''} maxlength={CAMERA_NAME_MAX + 8} oninput={(e) => ((nameDraft = e.currentTarget.value), (nameError = ''))} onkeydown={(e) => e.key === 'Enter' && void saveName()} aria-invalid={!!nameProblem} data-testid="input-camera-name" />
                {#if nameProblem}<div class="field-error" data-testid="camera-name-problem">{nameProblem}</div>{/if}
                {#if nameError}<div class="field-error" data-testid="camera-name-error">{nameError}</div>{/if}
              </td>
              <td>{#if $status?.camera.nameSource === 'config'}<span class="badge" title="the camera was not read yet: the name from config.json">not read yet</span>{/if}</td>
              <td class="actions">
                {#if nameDraft !== undefined}<button onclick={() => void saveName()} disabled={!!nameProblem || nameSaving} data-testid="save-camera-name">Save</button>{/if}
              </td>
            </tr>
            {:else}
            <tr data-testid="setting-{p}">
              <td class="mono">{p.slice(group.length + 1)}</td>
              <td>
                <input value={drafts[p] ?? shown(s.value)} oninput={(e) => (drafts[p] = e.currentTarget.value)} data-testid="input-{p}" disabled={(typeof s.value === 'object' && s.value !== null) || isEnvSet(s)} readonly={isEnvSet(s)} title={isEnvSet(s) ? envNote(s) : undefined} />
                {#if isEnvSet(s)}<div class="env-note" data-testid="env-note-{p}">{envNote(s)}</div>{/if}
              </td>
              <td><span class="badge {s.source}" class:same={!!same} data-testid="source-{p}" title={same?.title}>{same ? same.text : s.legacy ? 'config.json (legacy camera)' : s.source}</span>{#if s.restart}<span class="badge restart" title="applies after a restart">restart</span>{/if}{#if s.pending}<span class="badge pending">next: {shown(s.next)}</span>{/if}</td>
              <td class="actions">
                {#if drafts[p] !== undefined}<button onclick={() => void save(p)} data-testid="save-{p}">Save</button>{/if}
                {#if s.source === 'override' && !same}<button onclick={() => void reset(p)} data-testid="reset-{p}">{resetLabel(p, s.resetTo && { ...s.resetTo, means: undefined })}{#if s.resetTo?.means}{' '}<span class="means">({s.resetTo.means})</span>{/if}</button>{/if}
              </td>
            </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {/each}
</section>
{#if asking}
  <ConfirmDialog title="Reset to defaults" message={askMessage} items={asking} confirmLabel={askLabel} oncancel={() => (asking = null)} onconfirm={() => void resetAll()} />
{/if}

<style>
  section { display: grid; gap: 12px; }
  /* A narrow screen: the cards shrink to the page and a wide table scrolls inside its card. */
  section > :global(*) { min-width: 0; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
  .head-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
  h2 { margin: 0; font-size: 20px; }
  h3 { margin: 0 0 6px; font-size: 16px; text-transform: capitalize; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  td { padding: 4px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  input { width: 100%; min-width: 72px; max-width: 280px; padding: 4px 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; }
  .badge { font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border); margin-right: 4px; color: var(--muted); white-space: nowrap; }
  .badge.override { color: var(--accent); border-color: var(--accent); }
  /* An override equal to the default: no Reset, nothing to stand out. */
  .badge.override.same { color: var(--muted); border-color: var(--border); border-style: dashed; cursor: help; }
  .badge.env { color: var(--accent); border-style: dashed; }
  .env-note { margin-top: 4px; font-size: 12px; color: var(--muted); }
  input:disabled { opacity: 0.7; cursor: not-allowed; }
  .badge.pending { color: #f59e0b; }
  .actions { white-space: nowrap; text-align: right; }
  /* A phone: "Reset – 90 days" may take two lines rather than squeeze the field. */
  @media (max-width: 560px) {
    .actions { white-space: normal; }
    .actions button { font-size: 12px; padding: 4px 8px; min-width: 150px; }
    /* What an unset state means: its own line under "Reset – none". */
    .means { display: block; color: var(--muted); }
  }
  button { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); }
  button:hover { border-color: var(--accent); }
  .mono { font-family: var(--mono); }
  .muted { color: var(--muted); margin: 0; }
  .small { font-size: 13px; }
  .msg { margin: 0; color: var(--accent); }
  .field-error { margin-top: 4px; font-size: 12px; color: #ef4444; }
  input[aria-invalid='true'] { border-color: #ef4444; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
