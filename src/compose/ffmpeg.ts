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
