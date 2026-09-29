# Composed Clips (pre-/post-roll SD downloads) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cams Downloads modal for SD clips that saves the clip as it is or a composed clip. The composed clip is extended or trimmed by a pre-/post-roll, filled from other clips, the proxy's 1 fps stills, or "No recording" cards, and encoded by cam-proxy with a progress bar.

**Architecture:**
- cam-proxy gains a pure planner (which source covers each second), an ffmpeg argument builder with progress parsing, and a one-at-a-time job queue with a small REST API.
- cams passes that API through for signed-in users. A Svelte modal on the Downloads page drives it: generate, poll progress, preview, save, cancel.

**Tech Stack:** Node 26 + TypeScript, Express 5, node:sqlite (cam-proxy), ffmpeg (already in the container), Svelte 5 runes (cams), Vitest, Playwright, supertest.

**Spec:** `~/Development/cam-proxy/docs/superpowers/specs/2026-09-28-clip-composition-design.md`

**Repos:** Tasks 1–4 in `~/Development/cam-proxy` (branch `feat/compositions`), Tasks 5–7 in `~/Development/cams` (branch `feat/compose-dialog`).

## Global Constraints

- **Full quality:** not composed. Full stays today's direct download from the camera.
- **Pre-/post-roll:** whole seconds, −600…+60 each, 0 by default; the window must overlap the chosen clip by at least 1 s.
- **Result length:** 1–60 s.
- **Filling, per second:**
  1. the chosen clip;
  2. else another clip of the same camera (earliest start first);
  3. else that second's still;
  4. else a card "No recording" + `HH:MM:SS` (the proxy's `TZ`).
- **Badge:** optional, default on. "STILLS 1 FPS" top left on still and card seconds only.
- **Output:**
  - Video: H.264 (`libx264 -preset veryfast -crf 23 -pix_fmt yuv420p`), 10 fps, `-movflags +faststart`.
  - Audio: AAC 64 kb/s, 16 kHz mono.
  - Sizes: `sd` 896×512, `360p` 640×360, `720p` 1280×720, `1080p` 1920×1080.
- **Jobs:**
  - One running per proxy; up to 3 queued, else 429 `busy`.
  - Deleted on DELETE, 15 min after done, or 30 s without a poll while queued or running.
  - Leftover folders are removed at start; storage paused → 503 `storage_paused`; 200 MB disk per job.
- **Job ids:** 128-bit random base64url, and only visible for their camera.
- **Scope:** only the Downloads page SD button opens the modal, and only when the camera has a cam-proxy in use. History's download stays direct.
- **Rules:** never log tokens or job ids with codes; stage files explicitly; merge only when all checks pass.

## Review Focus

- A clip with no audio track (ffprobe finds none) must still compose, silent, instead of ffmpeg failing on `[k:a]`. Pinned in Task 2 (`audio: false` segment) and Task 4 (integration with a silent clip).
- Closing the tab mid-encode: the job must stop within about 30 s (no poll) and its folder must go. Pinned in Task 3 (the unpolled timeout).
- A second browser starting a job while one runs sees "Queued", then its own result, never the other job's. Pinned in Task 3 (queue order and ids) and Task 4 (camera scoping).
- A card's time with colons must reach `drawtext` escaped, or ffmpeg rejects the filter. Pinned in Task 2 (the escaped text in the args) and Task 4 (real ffmpeg with cards).
- A pre-roll reaching before the oldest still (older than 24 h) gives cards, not an error. Pinned in Task 1 (cards where there is nothing).

---

## File Structure

cam-proxy:
- `src/compose/plan.ts` (new): the pure planner. `planComposition()` returns window and segments.
- `src/compose/ffmpeg.ts` (new): `buildComposeArgs()` builds the ffmpeg arguments; `parseProgress()` reads ffmpeg `-progress` output; `defaultFont()` finds a font file.
- `src/compose/jobs.ts` (new): `createComposer()` holds the queue, states, cancel, timeouts, clean-up and runs ffmpeg.
- `src/api/compose-api.ts` (new): the four routes.
- `src/proxy.ts` (modify): wires the composer and routes, and stops the composer on shutdown.
- `src/config/defaults.ts`, `src/config/schema.ts` (modify): `composition.font` (optional string).
- `Dockerfile` (modify): `apk add font-dejavu`.
- `openapi.yaml`, `README.md`, `CHANGELOG.md` (modify).
- Tests: `test/compose-plan.test.ts`, `test/compose-ffmpeg.test.ts`, `test/compose-jobs.test.ts`, `test/compose-api.test.ts`.

cams:
- `server/proxy/client.ts` (modify): `open()` takes `method` and `body`.
- `server/routes/compose.ts` (new): the pass-through; mounted in `server/app.ts`.
- `test/proxy/fakeProxy.ts` (modify): fake compositions for tests and e2e.
- `web/src/lib/compose.ts` (new): client calls and the result-length helper.
- `web/src/components/ComposeDialog.svelte` (new): the modal.
- `web/src/components/DownloadList.svelte` (modify): SD opens the modal when the camera has a proxy.
- Tests: `test/composeRoutes.test.ts`, `web/src/lib/compose.test.ts`, `web/src/components/ComposeDialog.svelte.test.ts`, `e2e/compose.spec.ts`.

---

### Task 1: The planner (cam-proxy)

**Files:**
- Create: `src/compose/plan.ts`
- Test: `test/compose-plan.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ClipSpan { id: number; start: number; end: number; path: string }
export type Segment =
  | { kind: 'clip'; clipId: number; path: string; inS: number; outS: number } // seconds into the clip file
  | { kind: 'still'; ts: number }                                              // the still's unix ms (whole second)
  | { kind: 'card'; ts: number };                                              // the second's unix ms
export interface PlanInput { clip: ClipSpan; preS: number; postS: number; clips: ClipSpan[]; hasStill: (ts: number) => boolean }
export type Plan = { ok: true; start: number; end: number; durationS: number; segments: Segment[] } | { ok: false; error: string };
export const MAX_S = 60, MIN_ROLL = -600, MAX_ROLL = 60;
export function planComposition(p: PlanInput): Plan;
```

- [ ] **Step 1: Write the failing test**

```ts
// test/compose-plan.test.ts
import { describe, expect, it } from 'vitest';
import { planComposition, type ClipSpan } from '../src/compose/plan';

const T = Date.UTC(2026, 8, 28, 19, 0, 0);
const s = (sec: number) => T + sec * 1000;
const clip: ClipSpan = { id: 1, start: s(0), end: s(20), path: '/c/1.mp4' };
const none = () => false;
const all = () => true;

describe('planComposition', () => {
  it('is the clip alone for 0/0', () => {
    const p = planComposition({ clip, preS: 0, postS: 0, clips: [clip], hasStill: all });
    expect(p).toEqual({ ok: true, start: s(0), end: s(20), durationS: 20, segments: [{ kind: 'clip', clipId: 1, path: '/c/1.mp4', inS: 0, outS: 20 }] });
  });

  it('fills a pre-roll with stills, one per second', () => {
    const p = planComposition({ clip, preS: 3, postS: 0, clips: [clip], hasStill: all });
    if (!p.ok) throw new Error(p.error);
    expect(p.segments.slice(0, 3)).toEqual([{ kind: 'still', ts: s(-3) }, { kind: 'still', ts: s(-2) }, { kind: 'still', ts: s(-1) }]);
    expect(p.durationS).toBe(23);
  });

  it('reaches into the next clip: 20 s of stills, then 10 s of it (the spec example)', () => {
    const next: ClipSpan = { id: 2, start: s(40), end: s(70), path: '/c/2.mp4' };
    const p = planComposition({ clip, preS: 0, postS: 30, clips: [clip, next], hasStill: all });
    if (!p.ok) throw new Error(p.error);
    expect(p.segments[0]).toEqual({ kind: 'clip', clipId: 1, path: '/c/1.mp4', inS: 0, outS: 20 });
    expect(p.segments.slice(1, 21).every((x) => x.kind === 'still')).toBe(true);
    expect(p.segments[21]).toEqual({ kind: 'clip', clipId: 2, path: '/c/2.mp4', inS: 0, outS: 10 });
    expect(p.durationS).toBe(50);
  });

  it('prefers the chosen clip where clips overlap, then the earliest other', () => {
    const early: ClipSpan = { id: 3, start: s(-5), end: s(5), path: '/c/3.mp4' };
    const p = planComposition({ clip, preS: 5, postS: 0, clips: [early, clip], hasStill: none });
    if (!p.ok) throw new Error(p.error);
    expect(p.segments).toEqual([
      { kind: 'clip', clipId: 3, path: '/c/3.mp4', inS: 0, outS: 5 },
      { kind: 'clip', clipId: 1, path: '/c/1.mp4', inS: 0, outS: 20 },
    ]);
  });

  it('uses cards where there is neither a clip nor a still (e.g. older than 24 h)', () => {
    const p = planComposition({ clip, preS: 2, postS: 0, clips: [clip], hasStill: none });
    if (!p.ok) throw new Error(p.error);
    expect(p.segments.slice(0, 2)).toEqual([{ kind: 'card', ts: s(-2) }, { kind: 'card', ts: s(-1) }]);
  });

  it('trims with negative values', () => {
    const p = planComposition({ clip, preS: -5, postS: -3, clips: [clip], hasStill: all });
    expect(p).toMatchObject({ ok: true, start: s(5), end: s(17), durationS: 12, segments: [{ kind: 'clip', inS: 5, outS: 17 }] });
  });

  it.each([
    [{ preS: 0, postS: 41 }, 'at most 60 s'],          // 20 + 41
    [{ preS: 61, postS: 0 }, 'pre-roll and post-roll are whole seconds from -600 to 60'],
    [{ preS: 1.5, postS: 0 }, 'pre-roll and post-roll are whole seconds from -600 to 60'],
    [{ preS: -20, postS: 0 }, 'at least 1 s of the clip must remain'],
    [{ preS: -10, postS: -10 }, 'at least 1 s of the clip must remain'],
  ])('refuses %j', (roll, error) => {
    expect(planComposition({ clip, clips: [clip], hasStill: all, ...roll })).toEqual({ ok: false, error });
  });

  it('ignores clips that only touch the window edge', () => {
    const before: ClipSpan = { id: 4, start: s(-10), end: s(-2), path: '/c/4.mp4' };
    const p = planComposition({ clip, preS: 2, postS: 0, clips: [before, clip], hasStill: none });
    if (!p.ok) throw new Error(p.error);
    expect(p.segments.slice(0, 2).map((x) => x.kind)).toEqual(['card', 'card']);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/compose-plan.test.ts`
Expected: FAIL, "Cannot find module '../src/compose/plan'".

- [ ] **Step 3: Implement**

```ts
// src/compose/plan.ts
// Which source covers each second of a composed clip (spec 2026-09-28):
// the chosen clip, else another clip (earliest start), else that second's
// still, else a "No recording" card. Pure: no files, no ffmpeg.

export interface ClipSpan { id: number; start: number; end: number; path: string }
export type Segment =
  | { kind: 'clip'; clipId: number; path: string; inS: number; outS: number }
  | { kind: 'still'; ts: number }
  | { kind: 'card'; ts: number };
export interface PlanInput { clip: ClipSpan; preS: number; postS: number; clips: ClipSpan[]; hasStill: (ts: number) => boolean }
export type Plan = { ok: true; start: number; end: number; durationS: number; segments: Segment[] } | { ok: false; error: string };

export const MAX_S = 60;
export const MIN_ROLL = -600;
export const MAX_ROLL = 60;

const roll = (v: number) => Number.isInteger(v) && v >= MIN_ROLL && v <= MAX_ROLL;

export function planComposition(p: PlanInput): Plan {
  if (!roll(p.preS) || !roll(p.postS)) return { ok: false, error: 'pre-roll and post-roll are whole seconds from -600 to 60' };
  const start = p.clip.start - p.preS * 1000;
  const end = p.clip.end + p.postS * 1000;
  const overlap = Math.min(end, p.clip.end) - Math.max(start, p.clip.start);
  if (overlap < 1000) return { ok: false, error: 'at least 1 s of the clip must remain' };
  const durationS = Math.round((end - start) / 1000);
  if (durationS > MAX_S) return { ok: false, error: `at most ${MAX_S} s` };

  const others = p.clips.filter((c) => c.id !== p.clip.id).sort((a, b) => a.start - b.start || a.id - b.id);
  const covering = (t: number) => [p.clip, ...others].find((c) => t >= c.start && t + 1000 <= c.end);
  const segments: Segment[] = [];
  for (let t = start; t < end; t += 1000) {
    const c = covering(t);
    const last = segments[segments.length - 1];
    if (c) {
      const inS = (t - c.start) / 1000;
      if (last?.kind === 'clip' && last.clipId === c.id && last.outS === inS) last.outS = inS + 1;
      else segments.push({ kind: 'clip', clipId: c.id, path: c.path, inS, outS: inS + 1 });
    } else {
      segments.push({ kind: p.hasStill(t) ? 'still' : 'card', ts: t });
    }
  }
  return { ok: true, start, end, durationS, segments };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/compose-plan.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/compose/plan.ts test/compose-plan.test.ts
git commit -m "feat(compose): plan which source covers each second"
```

---

### Task 2: ffmpeg arguments and progress (cam-proxy)

**Files:**
- Create: `src/compose/ffmpeg.ts`
- Test: `test/compose-ffmpeg.test.ts`

**Interfaces:**
- Consumes: `Segment` (Task 1).
- Produces:

```ts
export type ComposeSize = 'sd' | '360p' | '720p' | '1080p';
export const SIZES: Record<ComposeSize, [number, number]>; // sd 896x512, 360p 640x360, 720p 1280x720, 1080p 1920x1080
export interface ArgsInput {
  segments: (Segment & { audio?: boolean })[]; // clip segments: audio = the file has an audio track
  stillFile: (ts: number) => string;            // a JPEG written for that still
  size: ComposeSize; badge: boolean; font: string;
  clock: (ts: number) => string;                // 'HH:MM:SS' in the proxy's zone
  out: string;
}
export function buildComposeArgs(i: ArgsInput): string[];
export function parseProgress(text: string, totalS: number): number | null; // 0..1, 1 on progress=end, null if none
export function defaultFont(exists?: (p: string) => boolean): string | null;
export function escapeText(s: string): string; // for drawtext text='…'
```

- [ ] **Step 1: Write the failing tests** (unit + one real ffmpeg run)

```ts
// test/compose-ffmpeg.test.ts
import { describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildComposeArgs, defaultFont, escapeText, parseProgress } from '../src/compose/ffmpeg';

const run = promisify(execFile);
const font = defaultFont();

describe('compose ffmpeg helpers', () => {
  it('escapes drawtext text (colons, quotes, backslashes)', () => {
    expect(escapeText("12:05:09")).toBe('12\\:05\\:09');
    expect(escapeText("it's")).toBe("it\\'s");
  });

  it('reads progress from ffmpeg -progress output', () => {
    expect(parseProgress('frame=10\nout_time_us=5000000\nprogress=continue\n', 20)).toBe(0.25);
    expect(parseProgress('out_time_us=90000000\n', 20)).toBe(1);
    expect(parseProgress('progress=end\n', 20)).toBe(1);
    expect(parseProgress('frame=3\n', 20)).toBeNull();
  });

  it('finds a font from a list of known places', () => {
    expect(defaultFont((p) => p === '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')).toBe('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
    expect(defaultFont(() => false)).toBeNull();
  });

  it('builds one concat graph: clip audio kept, stills and cards silent, badge only on pictures', () => {
    const args = buildComposeArgs({
      segments: [
        { kind: 'clip', clipId: 1, path: '/c/1.mp4', inS: 2, outS: 7, audio: true },
        { kind: 'still', ts: 1000 },
        { kind: 'card', ts: 2000 },
        { kind: 'clip', clipId: 2, path: '/c/2.mp4', inS: 0, outS: 3, audio: false },
      ],
      stillFile: (ts) => `/job/${ts}.jpg`, size: 'sd', badge: true, font: '/f.ttf', clock: () => '12:05:09', out: '/job/out.mp4',
    });
    const s = args.join(' ');
    expect(s).toContain('-ss 2 -to 7 -i /c/1.mp4');
    expect(s).toContain('-loop 1 -t 1 -i /job/1000.jpg');
    expect(s).toContain('color=c=0x111111:s=896x512:r=10:d=1');
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('concat=n=4:v=1:a=1[v][a]');
    expect(graph.match(/STILLS 1 FPS/g)).toHaveLength(2); // the still and the card
    expect(graph).toContain("text='12\\:05\\:09'");
    expect(graph.match(/anullsrc/g)?.length ?? 0).toBe(0); // silence comes from lavfi inputs
    expect(s.match(/anullsrc=r=16000:cl=mono/g)).toHaveLength(3); // still, card, and the silent clip
    expect(args.slice(-1)[0]).toBe('/job/out.mp4');
    expect(s).toContain('-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -r 10');
    expect(s).toContain('-progress pipe:1');
  });

  it.skipIf(!font)('really encodes: duration, size, fps, codecs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'compose-'));
    const clip = join(dir, 'c.mp4');
    const still = join(dir, 's.jpg');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=f=440:r=16000', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180', '-frames:v', '1', still]);
    const out = join(dir, 'out.mp4');
    const args = buildComposeArgs({
      segments: [{ kind: 'still', ts: 1 }, { kind: 'clip', clipId: 1, path: clip, inS: 1, outS: 3, audio: true }, { kind: 'card', ts: 2 }],
      stillFile: () => still, size: '360p', badge: true, font: font!, clock: () => '12:00:00', out,
    });
    await run('ffmpeg', args);
    expect(existsSync(out)).toBe(true);
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,r_frame_rate:format=duration', '-of', 'json', out]);
    const probe = JSON.parse(stdout) as { streams: { codec_name: string; width?: number; height?: number; r_frame_rate: string }[]; format: { duration: string } };
    expect(Math.abs(Number(probe.format.duration) - 4)).toBeLessThan(0.25);
    const v = probe.streams.find((x) => x.codec_name === 'h264')!;
    expect([v.width, v.height, v.r_frame_rate]).toEqual([640, 360, '10/1']);
    expect(probe.streams.some((x) => x.codec_name === 'aac')).toBe(true);
  }, 60_000);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/compose-ffmpeg.test.ts`
Expected: FAIL, the module is missing.

- [ ] **Step 3: Implement**

```ts
// src/compose/ffmpeg.ts
import { existsSync } from 'fs';
import type { Segment } from './plan';

// The ffmpeg arguments for a composed clip (spec 2026-09-28): one input per
// segment, one concat graph, H.264/AAC MP4 at 10 fps. Stills and cards are
// silent (lavfi anullsrc inputs), as is a clip without an audio track.

export type ComposeSize = 'sd' | '360p' | '720p' | '1080p';
export const SIZES: Record<ComposeSize, [number, number]> = { sd: [896, 512], '360p': [640, 360], '720p': [1280, 720], '1080p': [1920, 1080] };

export interface ArgsInput {
  segments: (Segment & { audio?: boolean })[];
  stillFile: (ts: number) => string;
  size: ComposeSize;
  badge: boolean;
  font: string;
  clock: (ts: number) => string;
  out: string;
}

const FONTS = ['/usr/share/fonts/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf'];
export function defaultFont(exists: (p: string) => boolean = existsSync): string | null {
  return FONTS.find((p) => exists(p)) ?? null;
}

// drawtext's text='…': backslash, quote and colon are special.
export function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
}

export function buildComposeArgs(i: ArgsInput): string[] {
  const [w, h] = SIZES[i.size];
  const inputs: string[] = [];
  const graph: string[] = [];
  const pairs: string[] = [];
  let n = 0; // next input index
  const silence = (d: number) => {
    inputs.push('-f', 'lavfi', '-t', String(d), '-i', 'anullsrc=r=16000:cl=mono');
    return n++;
  };
  const fit = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=10,format=yuv420p`;
  const badge = i.badge ? `,drawtext=fontfile=${i.font}:text='STILLS 1 FPS':x=12:y=12:fontsize=${Math.round(h / 24)}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=6` : '';
  i.segments.forEach((s, k) => {
    let v: number;
    let a: number;
    let d: number;
    let chain: string;
    if (s.kind === 'clip') {
      d = s.outS - s.inS;
      inputs.push('-ss', String(s.inS), '-to', String(s.outS), '-i', s.path);
      v = n++;
      chain = `[${v}:v]${fit},trim=duration=${d},setpts=PTS-STARTPTS[v${k}]`;
      if (s.audio) {
        graph.push(chain, `[${v}:a]aresample=16000,aformat=sample_fmts=fltp:channel_layouts=mono,apad,atrim=0:${d},asetpts=PTS-STARTPTS[a${k}]`);
      } else {
        a = silence(d);
        graph.push(chain, `[${a}:a]aformat=sample_fmts=fltp:channel_layouts=mono[a${k}]`);
      }
    } else {
      d = 1;
      if (s.kind === 'still') {
        inputs.push('-loop', '1', '-t', '1', '-i', i.stillFile(s.ts));
        v = n++;
        chain = `[${v}:v]${fit},trim=duration=1,setpts=PTS-STARTPTS${badge}[v${k}]`;
      } else {
        inputs.push('-f', 'lavfi', '-i', `color=c=0x111111:s=${w}x${h}:r=10:d=1`);
        v = n++;
        const text = (t: string, y: string, size: number) => `drawtext=fontfile=${i.font}:text='${escapeText(t)}':x=(w-tw)/2:y=${y}:fontsize=${size}:fontcolor=white`;
        chain = `[${v}:v]format=yuv420p,${text('No recording', 'h/2-th-8', Math.round(h / 14))},${text(i.clock(s.ts), 'h/2+8', Math.round(h / 18))}${badge}[v${k}]`;
      }
      a = silence(1);
      graph.push(chain, `[${a}:a]aformat=sample_fmts=fltp:channel_layouts=mono[a${k}]`);
    }
    pairs.push(`[v${k}][a${k}]`);
  });
  graph.push(`${pairs.join('')}concat=n=${i.segments.length}:v=1:a=1[v][a]`);
  return [
    '-hide_banner', '-nostdin', '-v', 'error', '-y',
    ...inputs,
    '-filter_complex', graph.join(';'),
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', '10',
    '-c:a', 'aac', '-b:a', '64k', '-ar', '16000', '-ac', '1',
    '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats',
    i.out,
  ];
}

export function parseProgress(text: string, totalS: number): number | null {
  if (/^progress=end$/m.test(text)) return 1;
  const all = [...text.matchAll(/^out_time_us=(\d+)$/gm)];
  if (!all.length) return null;
  const us = Number(all[all.length - 1][1]);
  return Math.min(1, us / 1e6 / totalS);
}
```

Note to the implementer: the graph has **no** inline `anullsrc` filters; silence comes from `-f lavfi -i anullsrc…` inputs. That's what the test's `anullsrc` counts check.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/compose-ffmpeg.test.ts`
Expected: PASS, including the real encode. If the local ffmpeg lacks `drawtext` (no freetype), the real-encode test fails with "No such filter: 'drawtext'"; install an ffmpeg with freetype (Homebrew's has it).

- [ ] **Step 5: Commit**

```bash
git add src/compose/ffmpeg.ts test/compose-ffmpeg.test.ts
git commit -m "feat(compose): ffmpeg arguments for a composed clip, and its progress"
```

---

### Task 3: Jobs (cam-proxy)

**Files:**
- Create: `src/compose/jobs.ts`
- Test: `test/compose-jobs.test.ts`

**Interfaces:**
- Consumes: `planComposition`, `Plan` (Task 1); `buildComposeArgs`, `parseProgress`, `ComposeSize` (Task 2).
- Produces:

```ts
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export interface JobView { id: string; state: JobState; progress: number; durationS: number; error?: string }
export interface ComposeRequest { cam: string; plan: Extract<Plan, { ok: true }>; size: ComposeSize; badge: boolean }
const MAX_BYTES = 200 * 1024 * 1024;
export interface Runner { (job: { dir: string; out: string; req: ComposeRequest; onProgress: (p: number) => void; signal: AbortSignal }): Promise<void> }
export function createComposer(o: { dir: string; runner: Runner; now?: () => number; doneTtlMs?: number; idleMs?: number; maxQueued?: number }): {
  start(req: ComposeRequest): JobView | 'busy';
  get(cam: string, id: string): JobView | undefined; // also counts as a poll
  file(cam: string, id: string): string | undefined; // the result path once done
  cancel(cam: string, id: string): boolean;
  sweep(): void;       // timeouts: unpolled queued/running (idleMs, default 30 s), done older than doneTtlMs (15 min)
  stop(): Promise<void>;
};
export function ffmpegRunner(o: { font: string; clock: (ts: number) => string; readStill: (ts: number) => Promise<Buffer | undefined>; hasAudio: (path: string) => Promise<boolean> }): Runner;
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/compose-jobs.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createComposer, type Runner } from '../src/compose/jobs';
import { planComposition } from '../src/compose/plan';

const plan = planComposition({ clip: { id: 1, start: 0, end: 10_000, path: '/c.mp4' }, preS: 0, postS: 0, clips: [], hasStill: () => false });
if (!plan.ok) throw new Error('plan');
const req = { cam: 'cam1', plan, size: 'sd' as const, badge: true };

// A runner we drive by hand: resolve/reject/progress per job.
function manual() {
  const jobs: { onProgress: (p: number) => void; finish: () => void; fail: (e: Error) => void; signal: AbortSignal; out: string }[] = [];
  const runner: Runner = ({ onProgress, signal, out }) =>
    new Promise<void>((resolve, reject) => {
      jobs.push({ onProgress, finish: () => { writeFileSync(out, 'mp4'); resolve(); }, fail: reject, signal, out });
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  return { runner, jobs };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
let stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const s of stops) await s(); stops = []; });

function make(extra: Partial<Parameters<typeof createComposer>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-'));
  const m = manual();
  let t = 0;
  const c = createComposer({ dir, runner: m.runner, now: () => t, ...extra });
  stops.push(() => c.stop());
  return { c, m, dir, advance: (ms: number) => { t += ms; } };
}

describe('composer jobs', () => {
  it('runs one at a time, queues up to 3, then says busy', async () => {
    const { c, m } = make();
    const a = c.start(req);
    const b = c.start(req);
    c.start(req); c.start(req);
    expect(c.start(req)).toBe('busy');
    await tick();
    expect(a).toMatchObject({ state: 'running' });
    expect(c.get('cam1', (b as { id: string }).id)).toMatchObject({ state: 'queued' });
    expect(m.jobs).toHaveLength(1);
  });

  it('reports progress, then done with a file; ids are random and per camera', async () => {
    const { c, m } = make();
    const a = c.start(req) as { id: string };
    await tick();
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    m.jobs[0].onProgress(0.4);
    expect(c.get('cam1', a.id)).toMatchObject({ state: 'running', progress: 0.4 });
    m.jobs[0].finish();
    await tick();
    expect(c.get('cam1', a.id)).toMatchObject({ state: 'done', progress: 1, durationS: 10 });
    expect(existsSync(c.file('cam1', a.id)!)).toBe(true);
    expect(c.get('other', a.id)).toBeUndefined();
    expect(c.file('other', a.id)).toBeUndefined();
  });

  it('cancel stops a running job, deletes its folder, and starts the next', async () => {
    const { c, m, dir } = make();
    const a = c.start(req) as { id: string };
    const b = c.start(req) as { id: string };
    await tick();
    expect(c.cancel('cam1', a.id)).toBe(true);
    await tick();
    expect(m.jobs[0].signal.aborted).toBe(true);
    expect(c.get('cam1', a.id)).toBeUndefined();
    expect(readdirSync(dir)).not.toContain(a.id);
    expect(c.get('cam1', b.id)).toMatchObject({ state: 'running' });
  });

  it('a failed run reports failed with the reason', async () => {
    const { c, m } = make();
    const a = c.start(req) as { id: string };
    await tick();
    m.jobs[0].fail(new Error('ffmpeg exited 1'));
    await tick();
    expect(c.get('cam1', a.id)).toMatchObject({ state: 'failed', error: 'ffmpeg exited 1' });
  });

  it('stops a job nobody polls for 30 s (a closed tab), and drops results after 15 min', async () => {
    const { c, m, advance } = make();
    const a = c.start(req) as { id: string };
    await tick();
    advance(29_000); c.sweep();
    expect(c.get('cam1', a.id)).toMatchObject({ state: 'running' }); // this poll resets the clock
    advance(31_000); c.sweep();
    await tick();
    expect(m.jobs[0].signal.aborted).toBe(true);
    expect(c.get('cam1', a.id)).toBeUndefined();
    const b = c.start(req) as { id: string };
    await tick();
    m.jobs[1].finish();
    await tick();
    advance(14 * 60_000); c.sweep();
    expect(c.get('cam1', b.id)).toMatchObject({ state: 'done' });
    advance(2 * 60_000); c.sweep();
    expect(c.get('cam1', b.id)).toBeUndefined();
  });

  it('removes leftover job folders at start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobs-'));
    mkdirSync(join(dir, 'old-job'));
    const c = createComposer({ dir, runner: manual().runner });
    stops.push(() => c.stop());
    expect(readdirSync(dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/compose-jobs.test.ts`
Expected: FAIL, the module is missing.

- [ ] **Step 3: Implement**

```ts
// src/compose/jobs.ts
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { buildComposeArgs, parseProgress, type ComposeSize } from './ffmpeg';
import type { Plan } from './plan';

// Composition jobs (spec 2026-09-28): one encoding at a time, up to 3
// waiting. A job nobody polls for 30 s (a closed tab) stops; a result lives
// 15 minutes. Each job has its own folder under `dir`.

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export interface JobView { id: string; state: JobState; progress: number; durationS: number; error?: string }
export interface ComposeRequest { cam: string; plan: Extract<Plan, { ok: true }>; size: ComposeSize; badge: boolean }
export interface Runner {
  (job: { dir: string; out: string; req: ComposeRequest; onProgress: (p: number) => void; signal: AbortSignal }): Promise<void>;
}

interface Job extends JobView { cam: string; req: ComposeRequest; dir: string; out: string; seen: number; doneAt?: number; ctl: AbortController }

export function createComposer(o: { dir: string; runner: Runner; now?: () => number; doneTtlMs?: number; idleMs?: number; maxQueued?: number }) {
  const now = o.now ?? Date.now;
  const doneTtl = o.doneTtlMs ?? 15 * 60_000;
  const idle = o.idleMs ?? 30_000;
  const maxQueued = o.maxQueued ?? 3;
  mkdirSync(o.dir, { recursive: true });
  for (const f of readdirSync(o.dir)) rmSync(join(o.dir, f), { recursive: true, force: true });
  const jobs = new Map<string, Job>();
  let running: Job | undefined;
  let stopped = false;

  const view = (j: Job): JobView => ({ id: j.id, state: j.state, progress: j.progress, durationS: j.durationS, ...(j.error ? { error: j.error } : {}) });
  const drop = (j: Job) => {
    jobs.delete(j.id);
    rmSync(j.dir, { recursive: true, force: true });
  };
  const next = () => {
    if (running || stopped) return;
    const j = [...jobs.values()].find((x) => x.state === 'queued');
    if (!j) return;
    running = j;
    j.state = 'running';
    o.runner({ dir: j.dir, out: j.out, req: j.req, signal: j.ctl.signal, onProgress: (p) => { if (j.state === 'running') j.progress = Math.max(j.progress, Math.min(1, p)); } })
      .then(() => {
        if (j.state !== 'running') return;
        j.state = 'done';
        j.progress = 1;
        j.doneAt = now();
      })
      .catch((err: Error) => {
        if (j.state !== 'running') return;
        j.state = 'failed';
        j.error = err.message;
        j.doneAt = now();
      })
      .finally(() => {
        running = undefined;
        next();
      });
  };

  return {
    start(req: ComposeRequest): JobView | 'busy' {
      if ([...jobs.values()].filter((j) => j.state === 'queued').length >= maxQueued) return 'busy';
      const id = randomBytes(16).toString('base64url');
      const dir = join(o.dir, id);
      mkdirSync(dir);
      const j: Job = { id, cam: req.cam, req, dir, out: join(dir, 'out.mp4'), state: 'queued', progress: 0, durationS: req.plan.durationS, seen: now(), ctl: new AbortController() };
      jobs.set(id, j);
      next();
      return view(j);
    },
    get(cam: string, id: string): JobView | undefined {
      const j = jobs.get(id);
      if (!j || j.cam !== cam) return undefined;
      j.seen = now();
      return view(j);
    },
    file(cam: string, id: string): string | undefined {
      const j = jobs.get(id);
      return j && j.cam === cam && j.state === 'done' ? j.out : undefined;
    },
    cancel(cam: string, id: string): boolean {
      const j = jobs.get(id);
      if (!j || j.cam !== cam) return false;
      j.state = 'cancelled';
      j.ctl.abort();
      drop(j);
      return true;
    },
    sweep(): void {
      const t = now();
      for (const j of [...jobs.values()]) {
        const live = j.state === 'queued' || j.state === 'running';
        if ((live && t - j.seen > idle) || (!live && j.doneAt !== undefined && t - j.doneAt > doneTtl)) {
          j.state = 'cancelled';
          j.ctl.abort();
          drop(j);
        }
      }
    },
    async stop(): Promise<void> {
      stopped = true;
      for (const j of [...jobs.values()]) {
        j.ctl.abort();
        drop(j);
      }
    },
  };
}

// The real runner: stills written as JPEGs in the job folder, then one ffmpeg.
export function ffmpegRunner(o: { font: string; clock: (ts: number) => string; readStill: (ts: number) => Promise<Buffer | undefined>; hasAudio: (path: string) => Promise<boolean> }): Runner {
  return async ({ dir, out, req, onProgress, signal }) => {
    const segments = [];
    for (const s of req.plan.segments) {
      if (s.kind === 'still') {
        const jpeg = await o.readStill(s.ts);
        if (jpeg) {
          writeFileSync(join(dir, `${s.ts}.jpg`), jpeg);
          segments.push(s);
        } else {
          segments.push({ kind: 'card' as const, ts: s.ts }); // gone since planning
        }
      } else if (s.kind === 'clip') {
        segments.push({ ...s, audio: await o.hasAudio(s.path) });
      } else {
        segments.push(s);
      }
    }
    const args = buildComposeArgs({ segments, stillFile: (ts) => join(dir, `${ts}.jpg`), size: req.size, badge: req.badge, font: o.font, clock: o.clock, out });
    await new Promise<void>((resolve, reject) => {
      const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stdout.on('data', (b: Buffer) => {
        const v = parseProgress(b.toString(), req.plan.durationS);
        if (v !== null) onProgress(v);
      });
      p.stderr.on('data', (b: Buffer) => { err = (err + b.toString()).slice(-2000); });
      const kill = () => {
        p.kill('SIGTERM');
        setTimeout(() => p.kill('SIGKILL'), 2000).unref();
      };
      signal.addEventListener('abort', kill, { once: true });
      p.on('error', reject);
      p.on('close', (code) => {
        signal.removeEventListener('abort', kill);
        if (signal.aborted) reject(new Error('cancelled'));
        else if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${err.trim().split('\n').pop() ?? ''}`));
      });
    });
    // The spec's per-job disk budget (a 60 s 1080p result is far below it).
    if (statSync(out).size > MAX_BYTES) throw new Error('the result is larger than 200 MB');
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/compose-jobs.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/compose/jobs.ts test/compose-jobs.test.ts
git commit -m "feat(compose): a one-at-a-time job queue with cancel and timeouts"
```

---

### Task 4: API, wiring, config, container, docs (cam-proxy)

**Files:**
- Create: `src/api/compose-api.ts`
- Modify: `src/proxy.ts` (construct the composer, mount the routes under `/api`, run `sweep()` every 5 s, `stop()` on shutdown)
- Modify: `src/config/defaults.ts` (`composition?: { font?: string }` in `Config`, no default value), `src/config/schema.ts` (`composition.font`: string, optional, doc "font file for the badge and card text; default: the first of DejaVu Sans (Alpine, Debian) or Arial (macOS) that exists")
- Modify: `Dockerfile` line `RUN apk add --no-cache ffmpeg \` → `RUN apk add --no-cache ffmpeg font-dejavu \`
- Modify: `openapi.yaml`, `README.md` (client API table), `CHANGELOG.md`
- Test: `test/compose-api.test.ts`

**Interfaces:**
- Consumes: `createComposer`, `ffmpegRunner` (Task 3); `planComposition` (Task 1); `defaultFont`, `ComposeSize`, `SIZES` (Task 2); `clipById`, `listClips` (`src/catalog/clips.ts`); `StillsSide.store.listStills(from, to): number[]` and `readStill(ts)`; `Storage.paused()`.
- Produces (HTTP, client token):
  - `POST /api/cameras/:cam/compositions` `{ clipId: number, preS: number, postS: number, size: 'sd'|'360p'|'720p'|'1080p', badge: boolean }`
    - 201 `JobView`
    - 400 `{error:'invalid', detail}`
    - 404 `not_found`
    - 429 `{error:'busy'}`
    - 503 `{error:'storage_paused'}`
    - 503 `{error:'no_font'}` when no font is found and `badge` or a card is needed
  - `GET /api/cameras/:cam/compositions/:id` returns `JobView`, or 404.
  - `GET /api/cameras/:cam/compositions/:id.mp4` returns `video/mp4` (`sendFile`, `Cache-Control: no-store`), 409 `{error:'not_ready'}` before `done`, or 404.
  - `DELETE /api/cameras/:cam/compositions/:id` returns 204, or 404.

- [ ] **Step 1: Write the failing test**

```ts
// test/compose-api.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { startSim } from './helpers/sim';
import { startProxy, auth, until } from './helpers/proxy';
import { insertClip } from '../src/catalog/clips';
import { defaultFont } from '../src/compose/ffmpeg';

const run = promisify(execFile);
let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
let clipId = 0;
let silentId = 0;
const T = Date.UTC(2026, 8, 28, 19, 0, 0);

beforeAll(async () => {
  sim = await startSim();
  p = await startProxy(sim);
  const withAudio = join(p.dir, 'a.mp4');
  const silent = join(p.dir, 's.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=r=16000', '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', withAudio]);
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent]);
  const cam = p.proxy.running().camera.id;
  clipId = insertClip(p.proxy.catalog, { cam, start_ts: T, end_ts: T + 6000, path: withAudio, stream: 'sub', size: 1, received_at: T, snapshot: null }).id;
  silentId = insertClip(p.proxy.catalog, { cam, start_ts: T + 20_000, end_ts: T + 24_000, path: silent, stream: 'sub', size: 1, received_at: T, snapshot: null }).id;
});
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

const cam = () => p.proxy.running().camera.id;
const post = (body: object) => request(p.proxy.app).post(`/api/cameras/${cam()}/compositions`).set(auth()).send(body);

describe('compositions API', () => {
  it('refuses bad input and unknown clips', async () => {
    expect((await post({ clipId, preS: 99, postS: 0, size: 'sd', badge: true })).status).toBe(400);
    expect((await post({ clipId, preS: 0, postS: 0, size: '4k', badge: true })).status).toBe(400);
    expect((await post({ clipId: 999_999, preS: 0, postS: 0, size: 'sd', badge: true })).status).toBe(404);
    expect((await request(p.proxy.app).post('/api/cameras/nope/compositions').set(auth()).send({ clipId, preS: 0, postS: 0, size: 'sd', badge: true })).status).toBe(404);
    expect((await request(p.proxy.app).post(`/api/cameras/${cam()}/compositions`).send({})).status).toBe(401);
  });

  it.skipIf(!defaultFont())('composes a clip with cards and a silent clip after it, and serves the result', async () => {
    const r = await post({ clipId, preS: 2, postS: 20, size: '360p', badge: true }); // 2 cards, 6 s clip, 14 cards, 4 s silent clip, 2 cards → 28 s
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ state: expect.stringMatching(/queued|running/), durationS: 28 });
    const id = r.body.id as string;
    await until(async () => (await request(p.proxy.app).get(`/api/cameras/${cam()}/compositions/${id}`).set(auth())).body.state === 'done', 60_000);
    const mp4 = await request(p.proxy.app).get(`/api/cameras/${cam()}/compositions/${id}.mp4`).set(auth()).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (c: Buffer) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
    expect(mp4.status).toBe(200);
    expect(mp4.headers['content-type']).toBe('video/mp4');
    expect((mp4.body as Buffer).subarray(4, 8).toString()).toBe('ftyp');
    expect((await request(p.proxy.app).delete(`/api/cameras/${cam()}/compositions/${id}`).set(auth())).status).toBe(204);
    expect((await request(p.proxy.app).get(`/api/cameras/${cam()}/compositions/${id}`).set(auth())).status).toBe(404);
  }, 90_000);

  it.skipIf(!defaultFont())('answers 409 for a result that is not ready, and hides jobs from other cameras', async () => {
    const r = await post({ clipId: silentId, preS: 0, postS: 30, size: 'sd', badge: false });
    const id = r.body.id as string;
    const early = await request(p.proxy.app).get(`/api/cameras/${cam()}/compositions/${id}.mp4`).set(auth());
    expect([409, 200]).toContain(early.status); // 200 only if the encode already finished
    expect((await request(p.proxy.app).get(`/api/cameras/other/compositions/${id}`).set(auth())).status).toBe(404);
    await request(p.proxy.app).delete(`/api/cameras/${cam()}/compositions/${id}`).set(auth());
  }, 30_000);
});
```

If `p.proxy.running()` or `p.proxy.catalog` aren't exposed on the `Proxy` object, expose them in `src/proxy.ts` (`catalog` already is a field of `Proxy` per `ControlDeps`; add `running: () => running` to the returned object if missing) and note it in the commit.

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/compose-api.test.ts`
Expected: FAIL, 404 for `/compositions` (no route).

- [ ] **Step 3: Implement the routes**

```ts
// src/api/compose-api.ts
import express, { type Request, type Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { clipById, listClips } from '../catalog/clips';
import type { Catalog } from '../catalog/db';
import type { Config } from '../config/defaults';
import { planComposition } from '../compose/plan';
import { SIZES, type ComposeSize } from '../compose/ffmpeg';
import type { createComposer } from '../compose/jobs';

const run = promisify(execFile);

// Composed clips (spec 2026-09-28): start, poll, fetch, cancel. The planner
// decides each second's source from the catalog and the stills store.
export function composeApi(d: {
  config: () => Config;
  catalog: Catalog;
  composer: ReturnType<typeof createComposer>;
  stillsIn: (from: number, to: number) => number[];
  paused: () => boolean;
  font: string | null;
}): express.Router {
  const r = express.Router();
  const cam = () => d.config().camera.id;
  const known = (req: Request, res: Response) => (req.params.cam === cam() ? true : (res.status(404).json({ error: 'not_found' }), false));

  r.post('/cameras/:cam/compositions', (req, res) => {
    if (!known(req, res)) return;
    const b = (req.body ?? {}) as { clipId?: unknown; preS?: unknown; postS?: unknown; size?: unknown; badge?: unknown };
    if (!Number.isSafeInteger(b.clipId) || typeof b.preS !== 'number' || typeof b.postS !== 'number' || typeof b.badge !== 'boolean' || typeof b.size !== 'string' || !(b.size in SIZES)) {
      return void res.status(400).json({ error: 'invalid', detail: 'clipId, preS, postS (seconds), size (sd, 360p, 720p, 1080p) and badge (true/false) are required' });
    }
    const row = clipById(d.catalog, b.clipId as number);
    if (!row || row.cam !== cam() || row.end_ts === null) return void res.status(404).json({ error: 'not_found' });
    if (d.paused()) return void res.status(503).json({ error: 'storage_paused' });
    const span = (c: { id: number; start_ts: number; end_ts: number | null; path: string }) => ({ id: c.id, start: c.start_ts, end: c.end_ts ?? c.start_ts, path: c.path });
    const from = row.start_ts - 600_000, to = row.end_ts + 60_000;
    const stills = new Set(d.stillsIn(from, to));
    const plan = planComposition({
      clip: span(row), preS: b.preS, postS: b.postS,
      clips: listClips(d.catalog, cam(), from, to).map(span),
      hasStill: (t) => stills.has(Math.floor(t / 1000) * 1000),
    });
    if (!plan.ok) return void res.status(400).json({ error: 'invalid', detail: plan.error });
    if (!d.font && (b.badge || plan.segments.some((s) => s.kind === 'card'))) return void res.status(503).json({ error: 'no_font' });
    const job = d.composer.start({ cam: cam(), plan, size: b.size as ComposeSize, badge: b.badge });
    if (job === 'busy') return void res.status(429).json({ error: 'busy' });
    res.status(201).json(job);
  });

  r.get('/cameras/:cam/compositions/:file', (req, res) => {
    if (!known(req, res)) return;
    const m = /^([A-Za-z0-9_-]{22})(\.mp4)?$/.exec(String(req.params.file));
    if (!m) return void res.status(404).json({ error: 'not_found' });
    const job = d.composer.get(cam(), m[1]);
    if (!job) return void res.status(404).json({ error: 'not_found' });
    if (!m[2]) return void res.json(job);
    const file = d.composer.file(cam(), m[1]);
    if (!file) return void res.status(409).json({ error: 'not_ready' });
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(file, { headers: { 'Content-Type': 'video/mp4' }, acceptRanges: true });
  });

  r.delete('/cameras/:cam/compositions/:id', (req, res) => {
    if (!known(req, res)) return;
    if (!d.composer.cancel(cam(), String(req.params.id))) return void res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  });
  return r;
}

// Whether a clip file has an audio track (the camera may send none).
export async function hasAudio(path: string): Promise<boolean> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', path]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Wire it in `src/proxy.ts`**
  1. Imports: `composeApi, hasAudio` from `./api/compose-api`; `createComposer, ffmpegRunner` from `./compose/jobs`; `defaultFont` from `./compose/ffmpeg`.
  2. After `storage` is created: build the composer and a sweep timer (below).
  3. Mount before the client API: `app.use('/api', refuseTokenInUrl, requireAccess('client', access), composeApi({ config: () => running, catalog, composer, stillsIn: (f, t) => stills?.store.listStills(f, t) ?? [], paused: () => storage.paused(), font }));`
  4. In the proxy's `stop()`: `clearInterval(sweeper); await composer.stop();`.

```ts
const font = running.composition?.font ?? defaultFont();
const clock = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
const composer = createComposer({
  dir: join(running.server.dataDir, 'compositions'),
  runner: ffmpegRunner({ font: font ?? '', clock, readStill: (ts) => stills?.store.readStill(ts) ?? Promise.resolve(undefined), hasAudio }),
});
const sweeper = setInterval(() => composer.sweep(), 5000);
sweeper.unref();
```

  `listStills` covers at most a day in the client API, but the store method itself takes any range. The planner asks for at most 11 minutes. Also add `composition` to the config type and schema as above, and add `font-dejavu` to the Dockerfile.

- [ ] **Step 5: Run the tests, then the whole suite**

Run: `npx vitest run test/compose-api.test.ts && npx vitest run && npm run check`
Expected: all pass. The openapi test needs the four routes in `openapi.yaml`; add them with the exact status codes above.

- [ ] **Step 6: Docs**
  - `README.md`: a line in the client API table: "`/api/cameras/{cam}/compositions` (POST, GET `{id}`, GET `{id}.mp4`, DELETE `{id}`): composed clips with pre-/post-roll (stills and 'No recording' cards fill gaps), H.264 10 fps, ≤ 60 s, one encoding at a time".
  - `CHANGELOG.md` under Unreleased: "Composed clips: a clip with pre-/post-roll from other clips, stills or 'No recording' cards (`/api/cameras/{cam}/compositions`), for cams' Downloads."

- [ ] **Step 7: Commit**

```bash
git add src/api/compose-api.ts src/proxy.ts src/config/defaults.ts src/config/schema.ts Dockerfile openapi.yaml README.md CHANGELOG.md test/compose-api.test.ts
git commit -m "feat(compose): the compositions API, wired into the proxy"
```

---

### Task 5: cams pass-through (cams)

**Files:**
- Modify: `server/proxy/client.ts` (`open()` init gains `method?: 'GET' | 'POST' | 'DELETE'` and `body?: string`; sets `Content-Type: application/json` when a body is given)
- Create: `server/routes/compose.ts`; mount `composeRouter` in `server/app.ts` next to `proxyRouter`
- Modify: `test/proxy/fakeProxy.ts` (fake compositions)
- Test: `test/composeRoutes.test.ts`

**Interfaces:**
- Consumes: `findProxyClip(cameraId, start, end)` (`server/recordings/proxyClips.ts`); `getProxyClient`, `proxyCameraId` (`server/proxy/client.ts`); `getCamera` (`server/cameraRegistry.ts`); `clipStartFromId`-style parsing of the event id (`YYYYMMDD-HHMMSS-HHMMSS`, local time), the same as the recordings service uses. Import the existing parser; don't write a second one.
- Produces (signed-in users):
  - `POST /api/cameras/:id/compositions` `{ eventId, preS, postS, size, badge }`: finds the proxy clip for the event, forwards `{ clipId, … }`, and answers the proxy's status and body.
  - `GET /api/cameras/:id/compositions/:job`: passes through.
  - `GET /api/cameras/:id/compositions/:job/video?inline=1`: streams the mp4.
    - With `inline=1` it sends `Content-Disposition: inline`.
    - Without it, `attachment; filename="<cam>-<YYYY-MM-DD_HH-MM-SS>-composed-<size>.mp4"`, with the name from `?name=`, validated by `^[A-Za-z0-9_.-]{1,120}\.mp4$`, else `composed.mp4`.
  - `DELETE /api/cameras/:id/compositions/:job`: passes through.
  - Without a proxy in use: 404 `no_proxy`. If no proxy clip matches: 404 `no_clip`. Proxy down: 502 `proxy_unavailable`. The job path segment must match `^[A-Za-z0-9_-]{22}$`, else 400.
- Fake proxy: `fake.compositions: Map<string, { state, progress, durationS }>`, `fake.composeDelayMs` (default 300). A POST creates a job that goes `running` → `done` with progress steps over the delay. `.mp4` returns a tiny `ftyp` buffer; DELETE removes the job; `fake.composeRequests` records bodies.

- [ ] **Step 1: Write the failing tests**

```ts
// test/composeRoutes.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const EVENT = '20260928-140000-140020';
const START = new Date(2026, 8, 28, 14, 0, 0).getTime();
let fake: FakeProxy;

beforeEach(async () => {
  fake = await startFakeProxy();
  fake.clips.push({ id: 7, cam: 'cam1', start: START, end: START + 20_000, bytes: Buffer.from('x') });
  setCameras([
    { id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN, camera: 'cam1' } },
    { id: 'shed', name: 'Shed', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' },
  ]);
  resetProxyClients();
});
afterEach(async () => {
  await fake.stop();
  setCameras([]);
});

const post = (id: string, body: object) => request(createApp()).post(`/api/cameras/${id}/compositions`).set('Cookie', auth).send(body);

describe('compositions pass-through', () => {
  it('finds the proxy clip for the event and forwards the request', async () => {
    const r = await post('den', { eventId: EVENT, preS: 5, postS: 10, size: 'sd', badge: true });
    expect(r.status).toBe(201);
    expect(r.body.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(fake.composeRequests.at(-1)).toEqual({ clipId: 7, preS: 5, postS: 10, size: 'sd', badge: true });
  });

  it('polls, then streams the result as a download or inline', async () => {
    fake.composeDelayMs = 0;
    const { body } = await post('den', { eventId: EVENT, preS: 0, postS: 5, size: 'sd', badge: false });
    await new Promise((res) => setTimeout(res, 20));
    expect((await request(createApp()).get(`/api/cameras/den/compositions/${body.id}`).set('Cookie', auth)).body).toMatchObject({ state: 'done' });
    const dl = await request(createApp()).get(`/api/cameras/den/compositions/${body.id}/video?name=den-2026-09-28_14-00-00-composed-sd.mp4`).set('Cookie', auth);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toBe('attachment; filename="den-2026-09-28_14-00-00-composed-sd.mp4"');
    const inline = await request(createApp()).get(`/api/cameras/den/compositions/${body.id}/video?inline=1`).set('Cookie', auth);
    expect(inline.headers['content-disposition']).toBe('inline');
    const odd = await request(createApp()).get(`/api/cameras/den/compositions/${body.id}/video?name=../x`).set('Cookie', auth);
    expect(odd.headers['content-disposition']).toBe('attachment; filename="composed.mp4"');
  });

  it('cancels', async () => {
    const { body } = await post('den', { eventId: EVENT, preS: 0, postS: 5, size: 'sd', badge: false });
    expect((await request(createApp()).delete(`/api/cameras/den/compositions/${body.id}`).set('Cookie', auth)).status).toBe(204);
    expect(fake.compositions.has(body.id)).toBe(false);
  });

  it('says no_proxy, no_clip, bad job ids, and needs a signed-in user', async () => {
    expect((await post('shed', { eventId: EVENT, preS: 0, postS: 5, size: 'sd', badge: false })).body).toEqual({ error: 'no_proxy' });
    expect((await post('den', { eventId: '20260928-090000-090010', preS: 0, postS: 5, size: 'sd', badge: false })).body).toEqual({ error: 'no_clip' });
    expect((await request(createApp()).get('/api/cameras/den/compositions/..%2Fx').set('Cookie', auth)).status).toBe(400);
    expect((await request(createApp()).post('/api/cameras/den/compositions').send({})).status).toBe(401);
  });

  it('says proxy_unavailable when the proxy is down', async () => {
    await fake.stop();
    expect((await post('den', { eventId: EVENT, preS: 0, postS: 5, size: 'sd', badge: false })).status).toBe(502);
    fake = await startFakeProxy();
  });
});
```

Check the fake proxy's `FakeClip` fields (`id`, `cam`, `start`, `end`, `bytes`) against `test/proxy/fakeProxy.ts` before running, and adapt the test's `push` to the real field names.

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/composeRoutes.test.ts`
Expected: FAIL (404s: no routes; the fake has no compositions).

- [ ] **Step 3: Implement.** First, the client:

```ts
// server/proxy/client.ts — inside open(), replacing the fetch line:
res = await fetch(this.urlOf(path, query), {
  method: init.method ?? 'GET',
  body: init.body,
  headers: { ...init.headers, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${this.p.token}` },
  signal: ctl.signal,
  redirect: 'error',
});
// and the init type gains: method?: 'GET' | 'POST' | 'DELETE'; body?: string;
```

Then the routes:

```ts
// server/routes/compose.ts
import { Router, type Request, type Response } from 'express';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { getCamera } from '../cameraRegistry';
import { logger } from '../logger';
import { getProxyClient, proxyCameraId, ProxyError } from '../proxy/client';
import { findProxyClip } from '../recordings/proxyClips';
import { eventSpan } from '../recordings/eventId';

// Composed clips (cam-proxy spec 2026-09-28): the Downloads modal's calls,
// passed to the camera's cam-proxy with its token.
export const composeRouter = Router();
const JOB = /^[A-Za-z0-9_-]{22}$/;
const NAME = /^[A-Za-z0-9_.-]{1,120}\.mp4$/;

function target(req: Request, res: Response) {
  const id = String(req.params.id);
  if (!getCamera(id)) return void res.status(404).json({ error: 'unknown_camera' }), undefined;
  const client = getProxyClient(id);
  if (!client) return void res.status(404).json({ error: 'no_proxy' }), undefined;
  return { id, client, base: `/api/cameras/${encodeURIComponent(proxyCameraId(id))}/compositions` };
}
function failed(err: unknown, res: Response) {
  if (!(err instanceof ProxyError)) throw err;
  logger.warn({ code: err.code, message: err.message }, 'compose_proxy_failed');
  if (!res.headersSent) res.status(502).json({ error: 'proxy_unavailable' });
  else res.destroy();
}
async function relay(res: Response, up: globalThis.Response) {
  res.status(up.status);
  const text = await up.text();
  if (text) res.type('application/json').send(text);
  else res.end();
}

composeRouter.post('/api/cameras/:id/compositions', async (req, res) => {
  const t = target(req, res);
  if (!t) return;
  const b = (req.body ?? {}) as { eventId?: unknown; preS?: unknown; postS?: unknown; size?: unknown; badge?: unknown };
  const span = typeof b.eventId === 'string' ? eventSpan(b.eventId) : null;
  if (!span) return void res.status(400).json({ error: 'invalid', detail: 'eventId is required' });
  try {
    const clip = await findProxyClip(t.id, span.start, span.end);
    if (!clip) return void res.status(404).json({ error: 'no_clip' });
    const up = await t.client.open(t.base, undefined, { method: 'POST', body: JSON.stringify({ clipId: clip.id, preS: b.preS, postS: b.postS, size: b.size, badge: b.badge }) });
    await relay(res, up);
  } catch (err) {
    failed(err, res);
  }
});

composeRouter.get('/api/cameras/:id/compositions/:job', async (req, res) => {
  if (!JOB.test(String(req.params.job))) return void res.status(400).json({ error: 'invalid' });
  const t = target(req, res);
  if (!t) return;
  try {
    await relay(res, await t.client.open(`${t.base}/${req.params.job}`));
  } catch (err) {
    failed(err, res);
  }
});

composeRouter.get('/api/cameras/:id/compositions/:job/video', async (req, res) => {
  if (!JOB.test(String(req.params.job))) return void res.status(400).json({ error: 'invalid' });
  const t = target(req, res);
  if (!t) return;
  try {
    const up = await t.client.open(`${t.base}/${req.params.job}.mp4`, undefined, { idleMs: 30_000 });
    if (!up.ok || !up.body) return void (await relay(res, up));
    const name = typeof req.query.name === 'string' && NAME.test(req.query.name) ? req.query.name : 'composed.mp4';
    res.status(200).set({
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-store',
      'Content-Disposition': req.query.inline === '1' ? 'inline' : `attachment; filename="${name}"`,
    });
    const len = up.headers.get('content-length');
    if (len && /^\d+$/.test(len)) res.setHeader('Content-Length', len);
    await pipeline(Readable.fromWeb(up.body as import('stream/web').ReadableStream), res);
  } catch (err) {
    failed(err, res);
  }
});

composeRouter.delete('/api/cameras/:id/compositions/:job', async (req, res) => {
  if (!JOB.test(String(req.params.job))) return void res.status(400).json({ error: 'invalid' });
  const t = target(req, res);
  if (!t) return;
  try {
    await relay(res, await t.client.open(`${t.base}/${req.params.job}`, undefined, { method: 'DELETE' }));
  } catch (err) {
    failed(err, res);
  }
});
```

  **`eventSpan`:** if the repo already parses event ids to `{ start, end }` (look in `server/recordings/*.ts` for the `YYYYMMDD-HHMMSS-HHMMSS` parser), import that instead and delete the `../recordings/eventId` import. Only if none exists, create `server/recordings/eventId.ts`:

```ts
// server/recordings/eventId.ts — an event id (YYYYMMDD-HHMMSS-HHMMSS, the
// camera's local time) as unix ms; the end rolls to the next day when it is
// before the start.
const ID = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;
export function eventSpan(id: string): { start: number; end: number } | null {
  const m = ID.exec(id);
  if (!m) return null;
  const n = m.slice(1).map(Number);
  const start = new Date(n[0], n[1] - 1, n[2], n[3], n[4], n[5]).getTime();
  let end = new Date(n[0], n[1] - 1, n[2], n[6], n[7], n[8]).getTime();
  if (end < start) end += 86_400_000;
  return Number.isFinite(start) ? { start, end } : null;
}
```

Then the fake proxy (add to `test/proxy/fakeProxy.ts`: interface fields, initial values, and routes):

```ts
// FakeProxy interface additions:
compositions: Map<string, { state: 'queued' | 'running' | 'done'; progress: number; durationS: number }>;
composeRequests: unknown[];
composeDelayMs: number;

// initial values in `fake`:
compositions: new Map(),
composeRequests: [],
composeDelayMs: 300,

// routes (after the clips routes):
app.post('/api/cameras/:cam/compositions', express.json(), (req, res) => {
  fake.composeRequests.push(req.body);
  const id = randomBytes(16).toString('base64url');
  const job = { state: 'running' as 'queued' | 'running' | 'done', progress: 0, durationS: 30 };
  fake.compositions.set(id, job);
  const steps = 4;
  for (let k = 1; k <= steps; k++) {
    setTimeout(() => {
      if (!fake.compositions.has(id)) return;
      job.progress = k / steps;
      if (k === steps) job.state = 'done';
    }, (fake.composeDelayMs * k) / steps);
  }
  res.status(201).json({ id, ...job });
});
app.get('/api/cameras/:cam/compositions/:file', (req, res) => {
  const m = /^([A-Za-z0-9_-]{22})(\.mp4)?$/.exec(req.params.file);
  const job = m && fake.compositions.get(m[1]);
  if (!m || !job) return void res.status(404).json({ error: 'not_found' });
  if (!m[2]) return void res.json({ id: m[1], ...job });
  if (job.state !== 'done') return void res.status(409).json({ error: 'not_ready' });
  res.type('video/mp4').send(Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.alloc(4)]));
});
app.delete('/api/cameras/:cam/compositions/:id', (req, res) => {
  if (!fake.compositions.delete(req.params.id)) return void res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});
```

  Import `randomBytes` from `crypto` in the fake if not already imported, and mount `composeRouter` in `server/app.ts` next to `proxyRouter`, behind the same auth middleware.

- [ ] **Step 4: Run the tests and the suite**

Run: `npx vitest run test/composeRoutes.test.ts && npx vitest run && npm run check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/proxy/client.ts server/routes/compose.ts server/app.ts test/proxy/fakeProxy.ts test/composeRoutes.test.ts
# plus server/recordings/eventId.ts only if created
git commit -m "feat(compose): pass the compositions API through to the camera's cam-proxy"
```

---

### Task 6: The modal (cams)

**Files:**
- Create: `web/src/lib/compose.ts`, `web/src/lib/compose.test.ts`
- Create: `web/src/components/ComposeDialog.svelte`, `web/src/components/ComposeDialog.svelte.test.ts`
- Modify: `web/src/components/DownloadList.svelte` (SD opens the dialog when `$cameras` says the camera's `proxy` is true; Full unchanged)

**Interfaces:**
- Consumes: the Task 5 routes; `thumbUrl`, `downloadUrl`, `formatClock`, `TRIGGER_LABELS`, `EventClip` (`web/src/lib/recordings.ts`); `cameras` store.
- Produces:

```ts
// web/src/lib/compose.ts
export type ComposeSize = 'sd' | '360p' | '720p' | '1080p';
export const SIZE_LABELS: Record<ComposeSize, string>; // 'SD 896×512 (original)', '640×360', '1280×720 (upscaled)', '1920×1080 (upscaled)'
export function resultLength(clipS: number, preS: number, postS: number): { ok: true; seconds: number } | { ok: false; error: string };
// errors: 'Whole seconds from -600 to 60', 'At most 1:00', 'At least 1 s of the clip must remain'
export function formatLength(s: number): string; // 52 → '0:52', 60 → '1:00'
export function composedName(cam: string, startIso: string, size: ComposeSize): string; // 'den-2026-09-28_14-00-00-composed-sd.mp4' (local time)
export interface JobView { id: string; state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; progress: number; durationS: number; error?: string }
export function startJob(cam: string, body: { eventId: string; preS: number; postS: number; size: ComposeSize; badge: boolean }): Promise<JobView>; // throws Error(message) on non-2xx
export function pollJob(cam: string, id: string): Promise<JobView | null>;                                                                          // null when 404
export function cancelJob(cam: string, id: string): void;                                                                                          // fetch DELETE, keepalive, errors ignored
export const videoUrl: (cam: string, id: string, inline: boolean, name?: string) => string;
```

- `ComposeDialog.svelte` props: `{ camera: string; clip: EventClip; onclose: () => void }`. Test ids:
  - `compose-dialog`, `compose-thumb`, `compose-pre`, `compose-post`, `compose-badge`, `compose-size`, `compose-length`, `compose-error`;
  - `compose-generate`, `compose-progress` (a `<progress>` with `value` 0–1), `compose-queued`, `compose-cancel`, `compose-player` (a `<video>`), `compose-save` (an `<a download>`), `compose-close`.

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/lib/compose.test.ts
import { describe, expect, it } from 'vitest';
import { composedName, formatLength, resultLength } from './compose';

describe('compose helpers', () => {
  it('computes the result length and its limits', () => {
    expect(resultLength(20, 0, 0)).toEqual({ ok: true, seconds: 20 });
    expect(resultLength(20, 10, 30)).toEqual({ ok: true, seconds: 60 });
    expect(resultLength(20, 10, 31)).toEqual({ ok: false, error: 'At most 1:00' });
    expect(resultLength(20, -10, -10)).toEqual({ ok: false, error: 'At least 1 s of the clip must remain' });
    expect(resultLength(20, 61, 0)).toEqual({ ok: false, error: 'Whole seconds from -600 to 60' });
    expect(resultLength(20, 1.5, 0)).toEqual({ ok: false, error: 'Whole seconds from -600 to 60' });
  });
  it('formats lengths and file names', () => {
    expect(formatLength(52)).toBe('0:52');
    expect(formatLength(60)).toBe('1:00');
    expect(composedName('den', '2026-09-28T14:00:00-05:00', 'sd')).toBe('den-2026-09-28_14-00-00-composed-sd.mp4'); // TZ=America/Chicago in vitest
  });
});
```

```ts
// web/src/components/ComposeDialog.svelte.test.ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ComposeDialog from './ComposeDialog.svelte';

const clip = { id: '20260928-140000-140020', start: '2026-09-28T14:00:00-05:00', end: '2026-09-28T14:00:20-05:00', durationSec: 20, triggers: ['person' as const], sizeSub: 1, sizeMain: 1 };
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.unstubAllGlobals();
});
function render(onclose = vi.fn()) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(ComposeDialog, { target, props: { camera: 'den', clip, onclose } });
  flushSync();
  return onclose;
}
const q = (id: string) => target!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const set = (id: string, v: string) => {
  const el = q(id) as HTMLInputElement;
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};

describe('ComposeDialog', () => {
  it('saves the original clip when nothing changes', () => {
    render();
    expect(q('compose-generate')).toBeNull();
    expect(q('compose-save')!.getAttribute('href')).toBe('/api/cameras/den/clips/20260928-140000-140020/download?quality=sub');
    expect(q('compose-length')!.textContent).toContain('0:20');
  });

  it('offers Generate for a post-roll, and disables Save until the result is ready', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    let polls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      if (init?.method === 'POST') return new Response(JSON.stringify({ id: 'a'.repeat(22), state: 'running', progress: 0, durationS: 50 }), { status: 201 });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      polls++;
      return new Response(JSON.stringify({ id: 'a'.repeat(22), state: polls > 1 ? 'done' : 'running', progress: polls > 1 ? 1 : 0.5, durationS: 50 }), { status: 200 });
    }));
    vi.useFakeTimers();
    try {
      render();
      set('compose-post', '30');
      expect(q('compose-length')!.textContent).toContain('0:50');
      expect(q('compose-save')!.getAttribute('aria-disabled')).toBe('true');
      q('compose-generate')!.click();
      await vi.advanceTimersByTimeAsync(10);
      flushSync();
      expect(JSON.parse(String(calls[0][1]!.body))).toEqual({ eventId: clip.id, preS: 0, postS: 30, size: 'sd', badge: true });
      await vi.advanceTimersByTimeAsync(1000);
      flushSync();
      expect((q('compose-progress') as HTMLProgressElement).value).toBe(0.5);
      await vi.advanceTimersByTimeAsync(1000);
      flushSync();
      expect(q('compose-player')!.getAttribute('src')).toBe(`/api/cameras/den/compositions/${'a'.repeat(22)}/video?inline=1`);
      expect(q('compose-save')!.getAttribute('aria-disabled')).toBe('false');
      expect(q('compose-save')!.getAttribute('href')).toContain('name=den-2026-09-28_14-00-00-composed-sd.mp4');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the limit instead of Generate when the result would be too long', () => {
    render();
    set('compose-pre', '60');
    set('compose-post', '10');
    expect(q('compose-error')!.textContent).toBe('At most 1:00');
    expect(q('compose-generate')).toBeNull();
  });

  it('Close cancels a running job and closes', async () => {
    const methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      return new Response(JSON.stringify({ id: 'b'.repeat(22), state: 'running', progress: 0.1, durationS: 30 }), { status: init?.method === 'POST' ? 201 : 200 });
    }));
    const onclose = render();
    set('compose-post', '10');
    q('compose-generate')!.click();
    await new Promise((r) => setTimeout(r, 10));
    q('compose-close')!.click();
    expect(methods).toContain('DELETE');
    expect(onclose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run web/src/lib/compose.test.ts web/src/components/ComposeDialog.svelte.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `web/src/lib/compose.ts`**

```ts
// Composed SD clips (cam-proxy spec 2026-09-28): the Downloads modal's API.
export type ComposeSize = 'sd' | '360p' | '720p' | '1080p';
export const SIZE_LABELS: Record<ComposeSize, string> = {
  sd: 'SD 896×512 (original)', '360p': '640×360', '720p': '1280×720 (upscaled)', '1080p': '1920×1080 (upscaled)',
};
export interface JobView { id: string; state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; progress: number; durationS: number; error?: string }

const roll = (v: number) => Number.isInteger(v) && v >= -600 && v <= 60;
export function resultLength(clipS: number, preS: number, postS: number): { ok: true; seconds: number } | { ok: false; error: string } {
  if (!roll(preS) || !roll(postS)) return { ok: false, error: 'Whole seconds from -600 to 60' };
  const start = -preS, end = clipS + postS;
  if (Math.min(end, clipS) - Math.max(start, 0) < 1) return { ok: false, error: 'At least 1 s of the clip must remain' };
  const seconds = end - start;
  return seconds > 60 ? { ok: false, error: 'At most 1:00' } : { ok: true, seconds };
}
export const formatLength = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
export function composedName(cam: string, startIso: string, size: ComposeSize): string {
  const d = new Date(startIso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${cam}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-composed-${size}.mp4`;
}
const base = (cam: string) => `/api/cameras/${encodeURIComponent(cam)}/compositions`;
export async function startJob(cam: string, body: { eventId: string; preS: number; postS: number; size: ComposeSize; badge: boolean }): Promise<JobView> {
  const r = await fetch(base(cam), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as JobView & { error?: string };
  if (!r.ok) throw new Error(j.error === 'busy' ? 'The proxy is busy; try again in a minute.' : j.error === 'no_clip' ? 'The proxy has no copy of this clip.' : 'The clip could not be composed.');
  return j;
}
export async function pollJob(cam: string, id: string): Promise<JobView | null> {
  const r = await fetch(`${base(cam)}/${id}`, { credentials: 'same-origin' });
  return r.status === 404 ? null : ((await r.json()) as JobView);
}
export function cancelJob(cam: string, id: string): void {
  void fetch(`${base(cam)}/${id}`, { method: 'DELETE', credentials: 'same-origin', keepalive: true }).catch(() => {});
}
export const videoUrl = (cam: string, id: string, inline: boolean, name?: string) =>
  `${base(cam)}/${id}/video${inline ? '?inline=1' : name ? `?name=${encodeURIComponent(name)}` : ''}`;
```

- [ ] **Step 4: Implement `ComposeDialog.svelte`**

```svelte
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { downloadUrl, formatClock, thumbUrl, TRIGGER_LABELS, type EventClip } from '../lib/recordings';
  import { cancelJob, composedName, formatLength, pollJob, resultLength, SIZE_LABELS, startJob, videoUrl, type ComposeSize, type JobView } from '../lib/compose';

  // The SD download with pre-/post-roll (cam-proxy spec 2026-09-28).
  let { camera, clip, onclose }: { camera: string; clip: EventClip; onclose: () => void } = $props();

  let preS = $state(0);
  let postS = $state(0);
  let badge = $state(true);
  let size: ComposeSize = $state('sd');
  let job: JobView | null = $state(null);
  let error = $state('');
  let timer: ReturnType<typeof setInterval> | undefined;

  const length = $derived(resultLength(clip.durationSec, Number(preS), Number(postS)));
  const plain = $derived(Number(preS) === 0 && Number(postS) === 0 && size === 'sd');
  const ready = $derived(job?.state === 'done');
  const busy = $derived(job?.state === 'queued' || job?.state === 'running');
  const name = $derived(composedName(camera, clip.start, size));

  // Any change after a result makes it stale.
  let lastKey = '';
  $effect(() => {
    const key = `${preS}|${postS}|${badge}|${size}`;
    if (lastKey && key !== lastKey && job) stop();
    lastKey = key;
  });

  // Stops polling and deletes the job on the proxy: a running one is
  // cancelled, a finished result is removed.
  function stop() {
    clearInterval(timer);
    if (job) cancelJob(camera, job.id);
    job = null;
  }
  async function generate() {
    error = '';
    stop();
    try {
      job = await startJob(camera, { eventId: clip.id, preS: Number(preS), postS: Number(postS), size, badge });
    } catch (e) {
      error = (e as Error).message;
      return;
    }
    timer = setInterval(async () => {
      if (!job) return clearInterval(timer);
      const v = await pollJob(camera, job.id).catch(() => null);
      if (!v) {
        clearInterval(timer);
        error = 'The composition was lost; try again.';
        job = null;
        return;
      }
      job = v;
      if (v.state === 'done' || v.state === 'failed') clearInterval(timer);
      if (v.state === 'failed') error = 'The clip could not be composed.';
    }, 1000);
  }
  function close() {
    stop();
    onclose();
  }
  onDestroy(() => stop());
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close()} onbeforeunload={() => stop()} />
<div class="backdrop" role="presentation" onclick={close}></div>
<div class="dialog" role="dialog" aria-modal="true" aria-label="Save SD clip" data-testid="compose-dialog">
  <header>
    <h2>Save SD clip</h2>
    <button class="x" data-testid="compose-close" aria-label="Close" onclick={close}>✕</button>
  </header>
  <div class="clip">
    <img data-testid="compose-thumb" src={thumbUrl(camera, clip.id)} alt="" />
    <span>{formatClock(clip.start)} · {clip.durationSec} s · {clip.triggers.map((t) => TRIGGER_LABELS[t]).join(', ')}</span>
  </div>
  <div class="fields">
    <label>Pre-roll (s) <input type="number" data-testid="compose-pre" min="-600" max="60" step="1" bind:value={preS} /></label>
    <label>Post-roll (s) <input type="number" data-testid="compose-post" min="-600" max="60" step="1" bind:value={postS} /></label>
    <label>Size
      <select data-testid="compose-size" bind:value={size}>
        {#each Object.entries(SIZE_LABELS) as [k, label] (k)}<option value={k}>{label}</option>{/each}
      </select>
    </label>
    <label class="row"><input type="checkbox" data-testid="compose-badge" bind:checked={badge} /> Mark still sections</label>
  </div>
  {#if length.ok}
    <p class="muted" data-testid="compose-length">Result: {formatLength(length.seconds)}</p>
  {:else}
    <p class="err" data-testid="compose-error" role="alert">{length.error}</p>
  {/if}
  {#if busy}
    {#if job?.state === 'queued'}<p class="muted" data-testid="compose-queued">Queued…</p>{/if}
    <progress data-testid="compose-progress" max="1" value={job?.progress ?? 0}></progress>
  {/if}
  {#if ready && job}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video data-testid="compose-player" src={videoUrl(camera, job.id, true)} controls playsinline></video>
  {/if}
  {#if error}<p class="err" role="alert">{error}</p>{/if}
  <footer>
    {#if busy}
      <button data-testid="compose-cancel" onclick={stop}>Cancel</button>
    {:else if !plain && length.ok}
      <button data-testid="compose-generate" onclick={generate}>{ready ? 'Generate again' : 'Generate'}</button>
    {/if}
    <a data-testid="compose-save" class="primary" download
      href={plain ? downloadUrl(camera, clip.id, 'sub') : ready && job ? videoUrl(camera, job.id, false, name) : undefined}
      aria-disabled={plain || ready ? 'false' : 'true'}>Save</a>
  </footer>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: var(--scrim); z-index: 40; }
  .dialog { position: fixed; z-index: 41; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; display: flex; flex-direction: column; gap: 12px; padding: 18px; border-radius: var(--radius); background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow); color: var(--text); }
  header { display: flex; justify-content: space-between; align-items: center; }
  h2 { margin: 0; font-size: 17px; }
  .x { border: 0; background: transparent; color: var(--muted); font-size: 16px; cursor: pointer; }
  .clip { display: flex; gap: 12px; align-items: center; font-size: 13px; color: var(--muted); }
  .clip img { width: 144px; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 6px; background: var(--no-thumb-bg); }
  .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 13px; }
  .fields label { display: grid; gap: 4px; }
  .fields .row { grid-column: 1 / -1; display: flex; gap: 6px; align-items: center; }
  input[type='number'], select { padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; }
  progress { width: 100%; }
  video { width: 100%; border-radius: 8px; background: #000; }
  .muted { margin: 0; color: var(--muted); font-size: 13px; }
  .err { margin: 0; color: var(--danger); font-size: 13px; }
  footer { display: flex; justify-content: flex-end; gap: 8px; }
  footer button, footer a { padding: 7px 14px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; font-size: 13px; text-decoration: none; cursor: pointer; }
  footer a.primary { background: var(--grad); color: var(--on-grad); border: 0; }
  footer a[aria-disabled='true'] { opacity: 0.45; pointer-events: none; }
</style>
```

- [ ] **Step 5: Wire it into `DownloadList.svelte`.**
  - SD for a camera with `proxy: true` (from `$cameras`) becomes a `<button data-testid="download-sub">` that opens the dialog; otherwise it stays the `<a>`. Full is unchanged.
  - `let composing: EventClip | null = $state(null);`
  - `{#if composing}<ComposeDialog camera={cameraId} clip={composing} onclose={() => (composing = null)} />{/if}` at the end.
  - Style the button like the links.

- [ ] **Step 6: Run the tests and the suite**

Run: `npx vitest run web/src && npm run check`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/compose.ts web/src/lib/compose.test.ts web/src/components/ComposeDialog.svelte web/src/components/ComposeDialog.svelte.test.ts web/src/components/DownloadList.svelte
git commit -m "feat(downloads): the SD modal with pre-/post-roll, progress, preview and save"
```

---

### Task 7: e2e and docs (cams)

**Files:**
- Create: `e2e/compose.spec.ts`
- Modify: `README.md` (Downloads bullet), `CHANGELOG.md`

- [ ] **Step 1: Write the e2e test** (Den has the fake proxy; Porch has none). The e2e fake proxy (`test/proxy/fakeProxy.ts` run by the Playwright web server) already carries the Task 5 routes. If its seeded clips (`e2e/fakeProxyData.ts`) don't match Den's demo events, add one fake clip matching the 08:15:10 event and note it in the commit.

```ts
// e2e/compose.spec.ts
import { expect, test } from '@playwright/test';
import { signIn } from './session';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});
const row = (page: import('@playwright/test').Page) => page.locator('[data-testid="download-row"][data-clip-id*="-081510-"]');

test('SD opens the modal; 0/0 saves the original clip', async ({ page }) => {
  await page.goto('/app/recordings?panel=downloads&cam=cam1');
  await row(page).getByTestId('download-sub').click();
  await expect(page.getByTestId('compose-dialog')).toBeVisible();
  await expect(page.getByTestId('compose-save')).toHaveAttribute('href', /download\?quality=sub/);
  await page.getByTestId('compose-close').click();
  await expect(page.getByTestId('compose-dialog')).toHaveCount(0);
});

test('a post-roll is generated with progress, previewed and saved', async ({ page }) => {
  await page.goto('/app/recordings?panel=downloads&cam=cam1');
  await row(page).getByTestId('download-sub').click();
  await page.getByTestId('compose-post').fill('10');
  await expect(page.getByTestId('compose-save')).toHaveAttribute('aria-disabled', 'true');
  await page.getByTestId('compose-generate').click();
  await expect(page.getByTestId('compose-player')).toBeVisible({ timeout: 10_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('compose-save').click()]);
  expect(download.suggestedFilename()).toMatch(/^cam1-\d{4}-\d{2}-\d{2}_08-15-10-composed-sd\.mp4$/);
});

test('Close during generation cancels the job', async ({ page }) => {
  await page.goto('/app/recordings?panel=downloads&cam=cam1');
  await row(page).getByTestId('download-sub').click();
  await page.getByTestId('compose-post').fill('10');
  const del = page.waitForRequest((r) => r.method() === 'DELETE' && /\/compositions\//.test(r.url()));
  await page.getByTestId('compose-generate').click();
  await page.getByTestId('compose-close').click();
  await del;
});

test('Full stays a direct download, and a camera without a proxy keeps a direct SD link', async ({ page }) => {
  await page.goto('/app/recordings?panel=downloads&cam=cam1');
  await expect(row(page).getByTestId('download-main')).toHaveAttribute('href', /quality=main/);
  await page.goto('/app/recordings?panel=downloads&cam=porch');
  await expect(row(page).getByTestId('download-sub')).toHaveAttribute('href', /quality=sub/);
});
```

- [ ] **Step 2: Run e2e**

Run: `npm run build && npx playwright test e2e/compose.spec.ts`
Expected: PASS (desktop and phone).

- [ ] **Step 3: Docs.**
  - `README.md` Downloads: "SD opens a dialog: save the clip, or a composed clip with pre-/post-roll (up to 1:00, filled from other clips, the proxy's stills or 'No recording' cards), with a progress bar, a preview and an optional 'STILLS' badge. Needs a cam-proxy; Full stays a direct download."
  - `CHANGELOG.md` Unreleased: "Downloads: SD opens a dialog to save the clip with a pre-/post-roll (composed by cam-proxy)."

- [ ] **Step 4: Full suite, then commit**

Run: `npx vitest run && npm run check && npx playwright test`
Expected: all pass.

```bash
git add e2e/compose.spec.ts README.md CHANGELOG.md
git commit -m "test(compose): e2e for the SD dialog; docs"
```

---

## Release order

1. cam-proxy: PR → merge when green → release. This redeploys cam2's proxy; the Mac proxy is updated by pull, build and restart. The container needs `font-dejavu`, so check the image with `docker run --rm <image> ls /usr/share/fonts/dejavu/DejaVuSans.ttf`.
2. cams: PR → merge when green → release. cams depends on the proxy's new routes only at runtime: before the proxy release, Generate would get 404 `no_clip` or `not_found`.
