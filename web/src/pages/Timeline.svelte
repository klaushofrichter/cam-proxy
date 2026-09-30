<script lang="ts">
  import { tick } from 'svelte';
  import { api } from '../lib/api';
  import { refreshTick } from '../lib/state';

  interface Minute { minute: number; cols: number; rows: number; tileW: number; tileH: number; intervalS: number; present: boolean[]; url: string }
  interface Ev { id: number; kind: string; start: number; end: number | null }

  const pad = (n: number) => String(n).padStart(2, '0');
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  let day = $state(today());
  let minutes = $state<Minute[]>([]);
  let events = $state<Ev[]>([]);
  let open = $state<Minute | null>(null);
  let still = $state<number | null>(null);
  let camId = $state('');
  let message = $state('');

  const hours = $derived(minutes.reduce<Record<number, Minute[]>>((h, m) => ((h[new Date(m.minute).getHours()] ??= []).push(m), h), {}));
  const eventIn = (m: Minute) => events.find((e) => e.start < m.minute + 60_000 && (e.end ?? Date.now()) >= m.minute);
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

  // A minute clicked in the hour grid opens at the top of the page, in view
  // (Klaus, 2026-09-30).
  let detail = $state<HTMLElement | undefined>();
  async function openMinute(m: Minute) {
    open = m;
    still = null;
    await tick();
    detail?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

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
      if (day === today()) void load();
    }, 60_000);
    return () => clearInterval(t);
  });
</script>

<section>
  <div class="head">
    <h2>Timeline</h2>
    <input type="date" bind:value={day} max={today()} data-testid="timeline-day" />
    <button onclick={() => void load()}>Refresh</button>
  </div>
  <p class="muted small">One thumbnail per minute; a colored edge marks an event. Click a minute for its seconds, then a second for the full still.</p>
  {#if message}<p class="muted" data-testid="timeline-message">{message}</p>{/if}

  {#if open}
    {@const m = open}
    <div class="card detail" data-testid="minute-detail" bind:this={detail}>
      <div class="head">
        <h3>{new Date(m.minute).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</h3>
        <button onclick={() => ((open = null), (still = null))}>Close</button>
      </div>
      <div class="tiles">
        {#each m.present as ok, i (i)}
          <button class="tile" class:missing={!ok} disabled={!ok} style={tileStyle(m, i, 0.6)} title={new Date(m.minute + i * m.intervalS * 1000).toLocaleTimeString()} onclick={() => (still = m.minute + i * m.intervalS * 1000)} data-testid="tile"></button>
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

  {#each Object.entries(hours) as [hour, list] (hour)}
    <div class="card" data-testid="hour-card">
      <h3>{pad(Number(hour))}:00</h3>
      <div class="strip">
        {#each list as m (m.minute)}
          {@const e = eventIn(m)}
          <button class="thumb {e ? `ev-${e.kind}` : ''}" class:active={open?.minute === m.minute} use:lazyStyle={tileStyle(m, firstTile(m), 0.5)} title={`${new Date(m.minute).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${e ? ` · ${e.kind}` : ''}`} onclick={() => void openMinute(m)} data-testid="minute"></button>
        {/each}
      </div>
    </div>
  {/each}
</section>

<style>
  section { display: grid; gap: 12px; }
  .head { display: flex; gap: 10px; align-items: center; }
  h2 { margin: 0; font-size: 20px; }
  h3 { margin: 0 0 6px; font-size: 15px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 16px; display: grid; gap: 8px; }
  /* The open minute stands apart from the hour cards (Klaus, 2026-09-30). */
  .card.detail { background: color-mix(in srgb, var(--accent) 10%, var(--surface)); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); scroll-margin-top: 12px; }
  .strip, .tiles { display: flex; flex-wrap: wrap; gap: 3px; }
  button { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); }
  .thumb, .tile { padding: 0; border-radius: 3px; border: 2px solid transparent; background-repeat: no-repeat; background-color: #111; }
  .thumb:hover, .tile:hover:not(:disabled) { border-color: var(--accent); }
  .thumb.active { outline: 3px solid var(--accent); outline-offset: 1px; }
  .tile.missing { opacity: 0.25; cursor: default; }
  .ev-motion { border-color: #f59e0b; } .ev-person { border-color: #ef4444; } .ev-vehicle { border-color: #3b82f6; } .ev-pet { border-color: #22c55e; }
  input { padding: 5px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; }
  figure { margin: 0; display: grid; gap: 4px; }
  img { width: 100%; max-width: 896px; border-radius: 6px; background: #111; }
  .mono { font-family: var(--mono); font-size: 13px; }
  .muted { color: var(--muted); margin: 0; }
  .small { font-size: 13px; }
</style>
