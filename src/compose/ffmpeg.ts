import { existsSync } from 'fs';
import type { Segment } from './plan';

// The ffmpeg arguments for a composed clip (spec 2026-09-28): one small
// encode per clip part and per run of stills and cards (pieceArgs), joined
// without encoding again (joinArgs); H.264/AAC MP4 at 10 fps. Stills and
// cards are silent, as is a clip without an audio track.

export type ComposeSize = 'sd' | '360p' | '720p' | '1080p';
export const SIZES: Record<ComposeSize, [number, number]> = { sd: [896, 512], '360p': [640, 360], '720p': [1280, 720], '1080p': [1920, 1080] };

export interface ComposeInput {
  segments: (Segment & { audio?: boolean })[];
  runFile: (k: number) => string;   // the numbered image pattern of the k-th run (runFrames), e.g. run-0-%04d.jpg
  pieceFile: (k: number) => string; // the k-th piece's MP4
  size: ComposeSize;
  badge: boolean;
  font: string;
  clock: (ts: number) => string;
}
export interface Piece { args: string[]; out: string; durationS: number }

const FONTS = ['/usr/share/fonts/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf'];
export function defaultFont(exists: (p: string) => boolean = existsSync): string | null {
  return FONTS.find((p) => exists(p)) ?? null;
}

// drawtext's text='…': backslash, quote and colon are special.
export function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
}

type Pic = Extract<Segment, { kind: 'still' | 'card' }>;
type Group = (Extract<Segment, { kind: 'clip' }> & { audio?: boolean }) | { kind: 'run'; seconds: Pic[] };

// Consecutive still and card seconds form one run.
export function groupRuns(segments: (Segment & { audio?: boolean })[]): Group[] {
  const out: Group[] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (s.kind === 'clip') out.push(s);
    else if (last?.kind === 'run') last.seconds.push(s);
    else out.push({ kind: 'run', seconds: [s] });
  }
  return out;
}

// A run's images, numbered from 0: each second's still, or the card
// background for a card second (its text is drawn in the graph), ten times
// over, read at 10 fps. At 1 fps a frame keeps a 1 s duration through the
// filters and stretches the piece; ten frames of 0.1 s don't. The copies are
// hard links of one file per second.
export function runFrames(seconds: Pic[], k: number): { file: string; kind: 'still' | 'card'; ts: number }[] {
  return seconds.flatMap((x, j) =>
    Array.from({ length: 10 }, (_, r) => ({ file: `run-${k}-${String(j * 10 + r).padStart(4, '0')}.jpg`, kind: x.kind, ts: x.ts })),
  );
}

// Two encoder threads: 282 MB peak at 1080p instead of 507 MB (measured),
// and cores left for the proxy's own work on a Pi.
const ENCODE = ['-threads', '2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', '10', '-c:a', 'aac', '-b:a', '64k', '-ar', '16000', '-ac', '1'];
const HEAD = ['-hide_banner', '-nostdin', '-v', 'error', '-y'];
const MONO = 'aformat=sample_fmts=fltp:channel_layouts=mono';

// One small encode per clip part and per run (final review: a single graph
// with an input per second held a frame each, over 1 GB; one graph over all
// pieces also deadlocked in ffmpeg 7). Identical settings, so joinArgs can
// put them together without encoding again. At most two inputs each.
export function pieceArgs(i: ComposeInput): Piece[] {
  const [w, h] = SIZES[i.size];
  const font = `fontfile='${escapeText(i.font)}'`;
  const fit = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=10,format=yuv420p`;
  const badge = i.badge ? `,drawtext=${font}:text='STILLS 1 FPS':x=12:y=12:fontsize=${Math.round(h / 24)}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=6` : '';
  const text = (t: string, y: string, size: number, j: number) =>
    `,drawtext=${font}:text='${escapeText(t)}':x=(w-tw)/2:y=${y}:fontsize=${size}:fontcolor=white:enable='between(t,${j},${j + 1})'`;
  const silence = (d: number) => ['-f', 'lavfi', '-t', String(d), '-i', 'anullsrc=r=16000:cl=mono'];
  let runs = 0;
  return groupRuns(i.segments).map((g, k) => {
    const out = i.pieceFile(k);
    let inputs: string[];
    let graph: string;
    let d: number;
    if (g.kind === 'clip') {
      d = g.outS - g.inS;
      inputs = ['-ss', String(g.inS), '-to', String(g.outS), '-i', g.path, ...(g.audio ? [] : silence(d))];
      const audio = g.audio ? `[0:a]aresample=16000,${MONO},apad,atrim=0:${d},asetpts=PTS-STARTPTS[a]` : `[1:a]${MONO}[a]`;
      graph = `[0:v]${fit},trim=duration=${d},setpts=PTS-STARTPTS[v];${audio}`;
    } else {
      d = g.seconds.length;
      // -reinit_filter 0: a card background and a still differ in size; a
      // rebuilt graph would restart the trim.
      inputs = ['-reinit_filter', '0', '-framerate', '10', '-i', i.runFile(runs++), ...silence(d)];
      const cards = g.seconds
        .map((x, j) => (x.kind === 'card' ? text('No recording', 'h/2-th-8', Math.round(h / 14), j) + text(i.clock(x.ts), 'h/2+8', Math.round(h / 18), j) : ''))
        .join('');
      graph = `[0:v]${fit},trim=duration=${d},setpts=PTS-STARTPTS${cards}${badge}[v];[1:a]${MONO}[a]`;
    }
    return { out, durationS: d, args: [...HEAD, ...inputs, '-filter_complex', graph, '-map', '[v]', '-map', '[a]', ...ENCODE, '-progress', 'pipe:1', '-nostats', out] };
  });
}

// The concat demuxer's list of pieces, in order.
export function joinList(files: string[]): string {
  return files.map((f) => `file '${f.replace(/'/g, "'\\''")}'\n`).join('');
}

export function joinArgs(listFile: string, out: string): string[] {
  return [...HEAD, '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', out];
}

// A card's time, 24 h, in the viewer's zone (final review: the pod runs in
// UTC); the process's zone when none is given.
export function clockText(ts: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, ...(timeZone ? { timeZone } : {}) }).format(ts);
}
export function validTimeZone(tz: string): boolean {
  if (tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// The dark background of "No recording" seconds, at the output size.
export function cardImageArgs(size: ComposeSize, out: string): string[] {
  const [w, h] = SIZES[size];
  return [...HEAD, '-f', 'lavfi', '-i', `color=c=0x111111:s=${w}x${h}`, '-frames:v', '1', out];
}

export function parseProgress(text: string, totalS: number): number | null {
  if (/^progress=end$/m.test(text)) return 1;
  const all = [...text.matchAll(/^out_time_us=(\d+)$/gm)];
  if (!all.length) return null;
  const us = Number(all[all.length - 1][1]);
  return Math.min(1, us / 1e6 / totalS);
}
