<script lang="ts">
  import { localDate, pad2 } from '../lib/format';
  import { api } from '../lib/api';
  import { analysedSeconds, analysedStills, eventLabel, eventsInMinute, isRecovered, marksByMinute, primaryEvent, RECOVERED_NOTE, secondKinds, secondRecovered, stepMinute } from '../lib/timeline';
  import AnalysisModal from '../components/AnalysisModal.svelte';
  import { refreshTick } from '../lib/state';

  interface Minute { minute: number; cols: number; rows: number; tileW: number; tileH: number; intervalS: number; present: boolean[]; url: string }
  interface Ev { id: number; kind: string; source?: string; start: number; end: number | null; analysis?: { status: string; stillTs?: number } | null }

  let day = $state(localDate());
  let minutes = $state<Minute[]>([]);
  let events = $state<Ev[]>([]);
  let open = $state<Minute | null>(null);
  let still = $state<number | null>(null);
  let camId = $state('');
  let message = $state('');
  let shown = $state<Ev | null>(null);

  // The grid's ×n counts and analysis rings, in one pass over the events.
  const gridMarks = $derived(marksByMinute(minutes.map((m) => m.minute), events, Date.now()));
  const hours = $derived(minutes.reduce<Record<number, Minute[]>>((h, m) => ((h[new Date(m.minute).getHours()] ??= []).push(m), h), {}));
  const eventIn = (m: Minute) => primaryEvent(events.filter((e) => e.start < m.minute + 60_000 && (e.end ?? Date.now()) >= m.minute));
  const firstTile = (m: Minute) => Math.max(0, m.present.indexOf(true));
  const tileStyle = (m: Minute, i: number, scale: number) =>
    `background-image:url('${m.url}');background-size:${m.cols * m.tileW * scale}px ${m.rows * m.tileH * scale}px;` +
    `background-position:-${(i % m.cols) * m.tileW * scale}px -${Math.floor(i / m.cols) * m.tileH * scale}px;width:${m.tileW * scale}px;height:${m.tileH * scale}px`;

  // Thumbnails load their sprite only once they scroll into view (a full day
  // is up to 1440 sprites).
  function lazyStyle(node: HTMLElement, style: string) {
    let current = style;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        node.setAttribute('style', current);
        io.disconnect();
      }
    }, { rootMargin: '200px' });
    node.setAttribute('style', current.replace(/background-image:[^;]*;/, ''));
    io.observe(node);
    return {
      update(next: string) {
        current = next;
      },
      destroy: () => io.disconnect(),
    };
  }

  // A minute opens inside its hour card, right under that hour's thumbnails,
  // so nothing scrolls; ◀ ▶ (and the arrow keys) step within that hour only
  // (Klaus, 2026-09-30).
  const hourOf = (m: Minute) => new Date(m.minute).getHours();
  function openMinute(m: Minute) {
    open = m;
    still = null;
  }
  function step(dir: -1 | 1) {
    if (!open) return;
    const list = hours[hourOf(open)] ?? [];
    const next = stepMinute(list, open.minute, dir);
    const m = next === null ? undefined : list.find((x) => x.minute === next);
    if (m) openMinute(m);
  }
  function onkey(e: KeyboardEvent) {
    if (!open || (e.target as HTMLElement | null)?.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else return;
    e.preventDefault();
  }
  const fmt = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  async function load() {
    message = '';
    try {
      const cams = await api<Array<{ id: string }>>('GET', '/api/cameras');
      camId = cams[0]?.id ?? '';
      if (!camId) return;
      const from = new Date(`${day}T00:00:00`).getTime();
      const to = from + 86_400_000 - 1;
      const c = encodeURIComponent(camId);
      [minutes, events] = await Promise.all([
        api<Minute[]>('GET', `/api/cameras/${c}/previews?from=${from}&to=${to}`),
        api<Ev[]>('GET', `/api/cameras/${c}/events?from=${from}&to=${to}&limit=1000`),
      ]);
      if (!minutes.length) message = 'No previews for this day.';
    } catch {
      message = 'Could not load this day.';
    }
  }
  $effect(() => {
    void day;
    open = null;
    still = null;
    void load();
  });
  // The top bar's Refresh, and today's new minutes every 60 s (the still
  // being looked at stays open).
  $effect(() => {
    if ($refreshTick) void load();
  });
  $effect(() => {
    const t = setInterval(() => {
      if (day === localDate()) void load();
    }, 60_000);
    return () => clearInterval(t);
  });
</script>

<svelte:window onkeydown={onkey} />

<section>
  <div class="head">
    <h2>Timeline</h2>
    <input type="date" bind:value={day} max={localDate()} data-testid="timeline-day" />
    <button onclick={() => void load()}>Refresh</button>
  </div>
  <p class="muted small">One thumbnail per minute; a colored edge marks an event. Click a minute for its seconds, then a second for the full still.</p>
  {#if message}<p class="muted" data-testid="timeline-message">{message}</p>{/if}

  {#each Object.entries(hours) as [hour, list] (hour)}
    <div class="card" data-testid="hour-card">
      <h3>{pad2(Number(hour))}:00</h3>
      <div class="strip">
        {#each list as m (m.minute)}
          {@const e = eventIn(m)}
          {@const marks = gridMarks.get(m.minute) ?? { count: 0, analysed: false }}
          <button class="thumb {e ? `ev-${e.kind}` : ''}" class:active={open?.minute === m.minute} class:analysed={marks.analysed} class:recovered={!!e && isRecovered(e)} use:lazyStyle={tileStyle(m, firstTile(m), 0.5)} title={`${new Date(m.minute).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${e ? ` · ${eventLabel(e)}` : ''}`} onclick={() => openMinute(m)} data-testid="minute">{#if marks.count > 1}<span class="count" data-testid="minute-count">×{marks.count}</span>{/if}</button>
        {/each}
      </div>
      {#if open && hourOf(open) === Number(hour)}
        {@const m = open}
        {@const evs = eventsInMinute(m, events, Date.now())}
        {@const kinds = secondKinds(m, events, Date.now())}
        {@const recs = secondRecovered(m, events, Date.now())}
        {@const seen = analysedSeconds(m, analysedStills(evs))}
        <div class="detail" data-testid="minute-detail">
          <div class="head">
            <h3>{new Date(m.minute).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</h3>
            <span class="spacer"></span>
            <button data-testid="minute-prev" title="Previous minute" aria-label="Previous minute" disabled={stepMinute(list, m.minute, -1) === null} onclick={() => step(-1)}>◀</button>
            <button data-testid="minute-next" title="Next minute" aria-label="Next minute" disabled={stepMinute(list, m.minute, 1) === null} onclick={() => step(1)}>▶</button>
            <button onclick={() => ((open = null), (still = null))}>Close</button>
          </div>
          {#if evs.length}
            <p class="small" data-testid="minute-events">
              {#each evs as e (e.id)}<span class="evtag ev-{e.kind}" class:recovered={isRecovered(e)} title={isRecovered(e) ? RECOVERED_NOTE : undefined} data-testid="minute-event">{eventLabel(e)} {fmt(e.start)}–{e.end === null ? 'now' : fmt(e.end)}{#if e.analysis}{' '}<button class="link" data-testid="minute-analysis-link" onclick={() => (shown = e)}>✦ Vision</button>{/if}</span>{/each}
            </p>
          {/if}
          <div class="tiles">
            {#each m.present as ok, i (i)}
              <button class="tile {kinds[i] ? `ev-${kinds[i]}` : ''}" class:missing={!ok} class:recovered={recs[i]} class:analysed={seen[i] !== null} disabled={!ok} style={tileStyle(m, i, 0.6)} title={`${new Date(m.minute + i * m.intervalS * 1000).toLocaleTimeString()}${recs[i] ? ' · recovered' : ''}`} onclick={() => { const id = seen[i]; if (id !== null) shown = evs.find((x) => x.id === id) ?? null; else still = m.minute + i * m.intervalS * 1000; }} data-testid="tile">{#if seen[i] !== null}<span class="spark">✦</span>{/if}</button>
            {/each}
          </div>
          {#if still !== null}
            <figure>
              <img src={`/api/cameras/${encodeURIComponent(camId)}/stills/${still}.jpg`} alt={`Still at ${new Date(still).toLocaleTimeString()}`} data-testid="still" />
              <figcaption class="mono">{new Date(still).toLocaleString()}</figcaption>
            </figure>
          {/if}
        </div>
      {/if}
    </div>
  {/each}
  {#if shown}<AnalysisModal {camId} event={shown} onclose={() => (shown = null)} />{/if}
</section>

<style>
  section { display: grid; gap: 12px; }
  .head { display: flex; gap: 10px; align-items: center; }
  h2 { margin: 0; font-size: 20px; }
  h3 { margin: 0 0 6px; font-size: 15px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 16px; display: grid; gap: 8px; }
  /* The open minute stands apart from the hour cards (Klaus, 2026-09-30). */
  .detail { display: grid; gap: 8px; margin-top: 6px; padding: 10px 12px; border-radius: var(--radius); background: color-mix(in srgb, var(--accent) 10%, var(--surface)); border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border)); }
  .spacer { flex: 1; }
  .evtag { display: inline-block; margin-right: 10px; padding-left: 6px; border-left: 4px solid; }
  /* Recovered from the SD recordings (#75): a dashed edge. */
  .evtag.recovered { border-left-style: dashed; font-style: italic; }
  .thumb.recovered, .tile.recovered { border-style: dashed; }
  .strip, .tiles { display: flex; flex-wrap: wrap; gap: 3px; }
  button { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); }
  .thumb, .tile { padding: 0; border-radius: 3px; border: 2px solid transparent; background-repeat: no-repeat; background-color: #111; }
  .thumb:hover, .tile:hover:not(:disabled) { border-color: var(--accent); }
  .thumb, .tile { position: relative; }
  .thumb.active { outline: 3px solid var(--accent); outline-offset: 1px; }
  .thumb.analysed { box-shadow: 0 0 0 2px #a855f7; }
  /* The open minute's outline ends 4 px out: the ring goes past it. */
  .thumb.analysed.active { box-shadow: 0 0 0 6px #a855f7; }
  .tile.analysed { outline: 2px solid #a855f7; outline-offset: 1px; }
  .count { position: absolute; right: 2px; bottom: 2px; background: rgb(0 0 0 / 0.7); color: #fff; font-size: 10px; line-height: 1.3; padding: 0 3px; border-radius: 3px; }
  .spark { position: absolute; top: 1px; left: 3px; color: #a855f7; font-size: 11px; line-height: 1; }
  .link { color: #a855f7; background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }
  .tile.missing { opacity: 0.25; cursor: default; }
  .ev-motion { border-color: #f59e0b; } .ev-person { border-color: #ef4444; } .ev-vehicle { border-color: #3b82f6; } .ev-pet { border-color: #22c55e; }
  input { padding: 5px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; }
  figure { margin: 0; display: grid; gap: 4px; }
  img { width: 100%; max-width: 896px; border-radius: 6px; background: #111; }
  .mono { font-family: var(--mono); font-size: 13px; }
  .muted { color: var(--muted); margin: 0; }
  .small { font-size: 13px; }
</style>
