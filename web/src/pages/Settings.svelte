<script lang="ts">
  import { refresh, refreshTick, status } from '../lib/state';
  import { cameraNameProblem, CAMERA_NAME_MAX, nameSaveError } from '../lib/camera-name';
  import { blockOf, cameraIds, multiCamera, pickCamera, selectedCamera } from '../lib/cameras';
  import { cameraPath, restartToApply, settingGroups } from '../lib/camera-settings';
  import AddCameraCard from '../components/AddCameraCard.svelte';
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import AnalyticsSettings from '../components/AnalyticsSettings.svelte';
  import PoeSwitchCard from '../components/PoeSwitchCard.svelte';
  import FindCameraCard from '../components/FindCameraCard.svelte';
  import { envNote, isEnvSet } from '../lib/find-camera';

  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import { byText, undoErrorText } from '../lib/cams-admin';
  import { parseSetting, resetCounts, resetLabel, resetPlan, sameBadge, type ResetTo, type SettingType } from '../lib/settings';

  // `env`: the variable that sets it (source env: read-only here).
  // `legacy`: read from a legacy `camera` object in config.json.
  interface Setting { value: unknown; source: 'default' | 'file' | 'override' | 'env'; env?: string; restart: boolean; restartScope?: 'camera' | 'host'; pending: boolean; next?: unknown; type?: SettingType; resetTo?: ResetTo; legacy?: true; by?: { cmdId: string; actor: string; at: number } }
  let view = $state<Record<string, Setting>>({});
  let drafts = $state<Record<string, string>>({});
  let message = $state('');

  // The host's settings by group, then the camera picked in the top bar
  // (spec 2026-10-05-multi-camera-host-design §6.3).
  const multi = $derived(multiCamera($status));
  const cam = $derived(pickCamera(cameraIds($status), $selectedCamera));
  const block = $derived(blockOf($status, $selectedCamera));
  const split = $derived(settingGroups(Object.keys(view).filter((p) => !p.startsWith('analytics.')), cam));
  const cards = $derived([
    ...Object.entries(split.host).map(([group, paths]) => ({ key: group, title: group, prefix: group, paths, camera: false })),
    ...(cam && split.camera.length ? [{ key: `camera-${cam}`, title: `Camera ${block?.camera.name ?? cam}${multi ? ` (${cam})` : ''}`, prefix: `cameras.${cam}`, paths: split.camera, camera: true }] : []),
  ]);
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
  // A setting cams-admin set (migration P3): Undo that whole change (every
  // path it set), as on the Status page's cams-admin card.
  let undoing = $state<{ path: string; cmdId: string; actor: string } | null>(null);
  async function undo(u: { path: string; cmdId: string }) {
    undoing = null;
    try {
      await api('POST', `/control/admin/changes/${u.cmdId}/undo`);
      message = `cams-admin's change ${u.cmdId} undone`;
    } catch (e) {
      message = undoErrorText(e);
    }
    await load();
    void refresh();
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
  // The host-wide restart: every camera side, every pending setting.
  async function restart() {
    message = await restartToApply(api);
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
      const r = await api<{ name: string }>('PUT', cameraPath(cam, multi, 'name'), { name: nameDraft });
      nameDraft = undefined;
      message = `Camera name saved on the camera: ${r.name}`;
      void refresh();
    } catch (e) {
      nameError = e instanceof ApiError ? nameSaveError(e.status, e.body) : 'Not saved';
    } finally {
      nameSaving = false;
    }
  }

  // A camera added here (overrides.json) can be removed here; its files stay
  // until retention removes them (Ruling P2-6).
  let removing = $state<string | null>(null);
  async function removeCamera(id: string) {
    removing = null;
    try {
      view = await api('DELETE', `/control/config/${encodeURIComponent(`cameras.${id}`)}`);
      message = `Camera ${id} removed; its stills, clips and events stay until retention removes them`;
      void refresh();
    } catch (e) {
      message = e instanceof ApiError ? e.message : 'not removed';
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
  {#each cards as card (card.key)}
    <div class="card" data-testid="settings-card-{card.key}">
      <div class="card-head"><h3 class:camera={card.camera}>{card.title}</h3>{#if card.camera && block?.source === 'added'}<button class="danger" onclick={() => (removing = cam)} data-testid="remove-camera">Remove camera</button>{/if}</div>
      <table>
        <tbody>
          {#each card.paths as p (p)}
            {@const s = view[p]}
            {@const same = s.source === 'override' ? sameBadge(p, s.resetTo) : null}
            {#if /^cameras\.[^.]+\.name$/.test(p)}
            <tr data-testid="setting-camera-name">
              <td><label for="camera-name">Camera name (stored on the camera)</label></td>
              <td>
                <input id="camera-name" value={nameDraft ?? block?.camera.name ?? ''} maxlength={CAMERA_NAME_MAX + 8} oninput={(e) => ((nameDraft = e.currentTarget.value), (nameError = ''))} onkeydown={(e) => e.key === 'Enter' && void saveName()} aria-invalid={!!nameProblem} data-testid="input-camera-name" />
                {#if nameProblem}<div class="field-error" data-testid="camera-name-problem">{nameProblem}</div>{/if}
                {#if nameError}<div class="field-error" data-testid="camera-name-error">{nameError}</div>{/if}
              </td>
              <td>{#if block?.camera.nameSource === 'config'}<span class="badge" title="the camera was not read yet: the name from config.json">not read yet</span>{/if}</td>
              <td class="actions">
                {#if nameDraft !== undefined}<button onclick={() => void saveName()} disabled={!!nameProblem || nameSaving} data-testid="save-camera-name">Save</button>{/if}
              </td>
            </tr>
            {:else}
            <tr data-testid="setting-{p}">
              <td class="mono">{p.slice(card.prefix.length + 1)}</td>
              <td>
                <input value={drafts[p] ?? shown(s.value)} oninput={(e) => (drafts[p] = e.currentTarget.value)} data-testid="input-{p}" disabled={(typeof s.value === 'object' && s.value !== null) || isEnvSet(s)} readonly={isEnvSet(s)} title={isEnvSet(s) ? envNote(s) : undefined} />
                {#if isEnvSet(s)}<div class="env-note" data-testid="env-note-{p}">{envNote(s)}</div>{/if}
              </td>
              <td><span class="badge {s.source}" class:same={!!same} data-testid="source-{p}" title={same?.title}>{same ? same.text : s.legacy ? 'config.json (legacy camera)' : s.source}</span>{#if s.restart}<span class="badge restart" title={s.restartScope === 'camera' ? "applies after this camera's restart (Maintenance → Restart camera side) or Restart to apply" : 'applies after Restart to apply (every camera side)'}>restart</span>{/if}{#if s.pending}<span class="badge pending">next: {shown(s.next)}</span>{/if}{#if s.by}<span class="badge by" data-testid="by-{p}">{byText(s.by)}</span> <button class="link" onclick={() => (undoing = { path: p, cmdId: s.by!.cmdId, actor: s.by!.actor })} data-testid="undo-{p}">Undo</button>{/if}</td>
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
  <AddCameraCard existing={cameraIds($status)} onadded={(v) => ((view = v as Record<string, Setting>), void refresh())} />
</section>
{#if removing}
  <ConfirmDialog title="Remove camera {removing}" message="The proxy stops this camera at once. Its stills, clips and events stay until retention removes them." confirmLabel="Remove camera" oncancel={() => (removing = null)} onconfirm={() => void removeCamera(removing!)} />
{/if}
{#if undoing}
  <ConfirmDialog title="Undo cams-admin's change" message="{undoing.path} and every other setting that change ({undoing.cmdId}, on behalf of {undoing.actor}) made go back to what they were before. A setting changed here since is left alone, and nothing is undone then." confirmLabel="Undo" oncancel={() => (undoing = null)} onconfirm={() => void undo(undoing!)} />
{/if}
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
  h3.camera { text-transform: none; }
  .card-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
  button.danger { border-color: #ef4444; color: #ef4444; }
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
  .badge.by { color: var(--accent); border-style: dotted; }
  button.link { border: none; background: none; padding: 0; color: var(--accent); cursor: pointer; text-decoration: underline; font-size: 12px; }
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
