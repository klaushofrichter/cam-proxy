import { describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cardImageArgs, clockText, defaultFont, escapeText, joinArgs, joinList, parseProgress, pieceArgs, runFrames, validTimeZone } from '../src/compose/ffmpeg';
import { ffmpegRunner } from '../src/compose/jobs';
import { planComposition } from '../src/compose/plan';

const run = promisify(execFile);
const font = defaultFont();
const base = { runFile: (k: number) => `/job/run-${k}-%04d.jpg`, pieceFile: (k: number) => `/job/piece-${k}.mp4`, size: 'sd' as const, badge: true, font: '/f.ttf', clock: () => '12:05:09' };

describe('compose ffmpeg helpers', () => {
  // Final review I5: the pod runs in UTC; cards show the viewer's time.
  it('writes the time of a card in the given zone, 24 h', () => {
    const t = Date.UTC(2026, 8, 28, 19, 5, 9);
    expect(clockText(t, 'America/Chicago')).toBe('14:05:09');
    expect(clockText(t, 'UTC')).toBe('19:05:09');
    expect(validTimeZone('Europe/Berlin')).toBe(true);
    expect(validTimeZone('Mars/Olympus')).toBe(false);
    expect(validTimeZone('x'.repeat(100))).toBe(false);
  });

  it('escapes drawtext text (colons, backslashes)', () => {
    expect(escapeText('12:05:09')).toBe('12\\:05\\:09');
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

  // Final review C1: one input per second held a frame each (1.2 GB for 40
  // stills + a clip). Now each clip part, and each run of still and card
  // seconds, is its own small encode with at most two inputs.
  it('encodes each clip part and each run of stills and cards as its own piece', () => {
    const pieces = pieceArgs({
      ...base,
      segments: [
        { kind: 'clip', clipId: 1, path: '/c/1.mp4', inS: 2, outS: 7, audio: true },
        ...Array.from({ length: 40 }, (_, k) => ({ kind: k % 5 === 4 ? ('card' as const) : ('still' as const), ts: 1000 * k })),
        { kind: 'clip', clipId: 2, path: '/c/2.mp4', inS: 0, outS: 3, audio: false },
      ],
    });
    expect(pieces.map((p) => [p.out, p.durationS])).toEqual([['/job/piece-0.mp4', 5], ['/job/piece-1.mp4', 40], ['/job/piece-2.mp4', 3]]);
    for (const p of pieces) expect(p.args.filter((a) => a === '-i').length).toBeLessThanOrEqual(2);
    const [clip, stills, silent] = pieces.map((p) => p.args.join(' '));
    expect(clip).toContain('-ss 2 -to 7 -i /c/1.mp4');
    expect(clip).not.toContain('anullsrc');
    expect(clip).not.toContain('STILLS 1 FPS'); // the badge marks pictures only
    expect(stills).toContain('-reinit_filter 0 -framerate 10 -i /job/run-0-%04d.jpg');
    expect(stills).toContain('-f lavfi -t 40 -i anullsrc=r=16000:cl=mono');
    expect(stills.match(/No recording/g)).toHaveLength(8); // one per card second, enabled for that second
    expect(stills).toContain("enable='between(t,4,5)'");
    expect(stills).toContain("text='12\\:05\\:09'");
    expect(stills).toContain("fontfile='/f.ttf'");
    expect(stills).toContain('STILLS 1 FPS');
    expect(silent).toContain('anullsrc');
    for (const p of pieces) {
      expect(p.args.join(' ')).toContain('-threads 2 -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -r 10 -c:a aac -b:a 64k -ar 16000 -ac 1');
      expect(p.args.slice(-4)).toEqual(['-progress', 'pipe:1', '-nostats', p.out]);
    }
  });

  it('numbers the images of a run from 0, ten per second: the still, or the card background', () => {
    const f = runFrames([{ kind: 'still', ts: 1000 }, { kind: 'card', ts: 2000 }], 3);
    expect(f).toHaveLength(20);
    expect(f[0]).toEqual({ file: 'run-3-0000.jpg', kind: 'still', ts: 1000 });
    expect(f[9]).toEqual({ file: 'run-3-0009.jpg', kind: 'still', ts: 1000 });
    expect(f[10]).toEqual({ file: 'run-3-0010.jpg', kind: 'card', ts: 2000 });
  });

  it('joins the pieces without encoding again', () => {
    expect(joinList(['/job/piece-0.mp4', "/job/it's.mp4"])).toBe("file '/job/piece-0.mp4'\nfile '/job/it'\\''s.mp4'\n");
    expect(joinArgs('/job/pieces.txt', '/job/out.mp4')).toEqual(['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', '/job/pieces.txt', '-c', 'copy', '-movflags', '+faststart', '/job/out.mp4']);
    expect(cardImageArgs('720p', '/job/card.jpg')).toContain('color=c=0x111111:s=1280x720');
  });

  it.skipIf(!font)('really composes: a still, a clip part, a card and a still of another size — duration, size, fps, codecs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'compose-'));
    const clip = join(dir, 'c.mp4');
    const still = join(dir, 's.jpg');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=f=440:r=16000', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180', '-frames:v', '1', still]);
    const T = 1_790_000_000_000;
    const plan = planComposition({ clip: { id: 1, start: T, end: T + 4000, path: clip }, preS: 1, postS: 2, clips: [], hasStill: (t) => t !== T + 4000 });
    if (!plan.ok) throw new Error(plan.error);
    const out = join(dir, 'out.mp4');
    const progress: number[] = [];
    await ffmpegRunner({ font: font!, clock: () => '12:00:00', readStill: async () => readFileSync(still), hasAudio: async () => true })({
      dir, out, req: { cam: 'cam1', plan, size: '360p', badge: true }, onProgress: (p) => progress.push(p), signal: new AbortController().signal,
    });
    expect(existsSync(out)).toBe(true);
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,duration:format=duration', '-of', 'json', out]);
    const probe = JSON.parse(stdout) as { streams: { codec_name: string; width?: number; height?: number; r_frame_rate: string; duration: string }[]; format: { duration: string } };
    const v = probe.streams.find((x) => x.codec_name === 'h264')!;
    expect(Math.abs(Number(v.duration) - 7)).toBeLessThan(0.2); // 1 still + 4 s clip + 1 card + 1 still
    expect(Math.abs(Number(probe.format.duration) - 7)).toBeLessThan(0.25);
    expect([v.width, v.height, v.r_frame_rate]).toEqual([640, 360, '10/1']);
    expect(probe.streams.some((x) => x.codec_name === 'aac')).toBe(true);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1])).toBe(true); // never goes back
  }, 60_000);
});
