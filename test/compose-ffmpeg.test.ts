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
