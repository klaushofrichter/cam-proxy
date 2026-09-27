<script lang="ts">
  import { api } from '../lib/api';
  import { feed, refreshTick } from '../lib/state';

  interface Clip { id: number; start: number; end: number | null; stream: string; size: number; events: number[]; url: string; snapshotUrl: string | null }
  interface Ev { id: number; kind: string }

  const pad = (n: number) => String(n).padStart(2, '0');
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  let day = $state(today());
  let clips = $state<Clip[]>([]);
  let kinds = $state<Record<number, string>>({});
  let playing = $state<Clip | null>(null);
  let message = $state('');

  const time = (ts: number) => new Date(ts).toLocaleTimeString();
  const secs = (c: Clip) => (c.end === null ? '…' : `${Math.round((c.end - c.start) / 1000)} s`);
  const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;

  async function load() {
    message = '';
    try {
      const cams = await api<Array<{ id: string }>>('GET', '/api/cameras');
      if (!cams[0]) return;
      const cam = encodeURIComponent(cams[0].id);
      const from = new Date(`${day}T00:00:00`).getTime();
      const to = from + 86_400_000 - 1;
      const [list, evs] = await Promise.all([api<Clip[]>('GET', `/api/cameras/${cam}/clips?from=${from}&to=${to}`), api<Ev[]>('GET', `/api/cameras/${cam}/events?from=${from - 3_600_000}&to=${to}`)]);
      clips = list.reverse(); // newest first
      kinds = Object.fromEntries(evs.map((e) => [e.id, e.kind]));
      if (!clips.length) message = 'No clips for this day.';
    } catch {
      message = 'Could not load this day.';
    }
  }
  $effect(() => {
    void day;
    void $refreshTick;
    void load();
  });
  // A new clip announced on the stream shows up when today is open.
  let seen = 0;
  $effect(() => {
    const last = $feed.find((f) => f.type === 'clip');
    if (last && last.id !== seen) {
      seen = last.id;
      if (day === today()) void load();
    }
  });
</script>

<section>
  <h2>Clips</h2>
  <div class="card">
    <div class="head">
      <input type="date" bind:value={day} max={today()} data-testid="clips-day" />
      <span class="muted small">Recordings the camera uploads by FTP, with the events they cover.</span>
    </div>
    {#if playing}
      <div class="player">
        <!-- svelte-ignore a11y_media_has_caption -->
        <video src={playing.url} controls autoplay playsinline data-testid="clip-player"></video>
        <p class="small">{time(playing.start)} · {secs(playing)} · {playing.stream} <button onclick={() => (playing = null)}>Close</button></p>
      </div>
    {/if}
    {#if message}<p class="muted" data-testid="clips-message">{message}</p>{/if}
    <div class="grid" data-testid="clips">
      {#each clips as c (c.id)}
        <button class="clip" class:active={playing?.id === c.id} onclick={() => (playing = c)} data-testid="clip">
          {#if c.snapshotUrl}<img src={c.snapshotUrl} alt="" loading="lazy" />{:else}<div class="noimg">no snapshot</div>{/if}
          <span class="meta"><b>{time(c.start)}</b> {secs(c)} · {mb(c.size)}</span>
          <span class="chips">{#each c.events as id (id)}<span class="chip">{kinds[id] ?? 'event'}</span>{/each}</span>
        </button>
      {/each}
    </div>
  </div>
</section>

<style>
  section { display: grid; gap: 12px; }
  h2 { margin: 0; font-size: 20px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; gap: 12px; }
  .head { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  input { padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); }
  .player video { width: 100%; max-height: 60vh; background: #000; border-radius: 8px; }
  .player p { margin: 4px 0 0; display: flex; gap: 8px; align-items: center; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
  .clip { display: grid; gap: 4px; text-align: left; padding: 6px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; }
  .clip:hover, .clip.active { border-color: var(--accent); }
  .clip img, .noimg { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 6px; background: #111; }
  .noimg { display: grid; place-items: center; color: var(--muted); font-size: 12px; }
  .meta { font-size: 13px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { font-size: 11px; padding: 1px 6px; border-radius: 999px; background: var(--accent); color: #fff; }
  button { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); }
  .muted { color: var(--muted); margin: 0; }
  .small { font-size: 13px; }
</style>
