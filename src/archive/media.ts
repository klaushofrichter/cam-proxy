import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { lowerPriority } from '../compose/jobs';

const run = promisify(execFile);

// A clip's duration in seconds (ffprobe), or null when it can't tell.
export async function probeDuration(path: string): Promise<number | null> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { timeout: 15_000 });
    const n = Number(stdout.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// The clip's first frame as a JPEG, 640 px wide (the thumbnail's last
// resort); undefined when ffmpeg fails. stderr is dropped (it names paths).
export function firstFrame(path: string): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-threads', '1', '-i', path, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', '-f', 'mjpeg', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    lowerPriority(p.pid);
    const chunks: Buffer[] = [];
    const t = setTimeout(() => p.kill('SIGKILL'), 20_000);
    p.stdout.on('data', (b: Buffer) => chunks.push(b));
    p.on('error', () => (clearTimeout(t), resolve(undefined)));
    p.on('close', (code) => {
      clearTimeout(t);
      const jpeg = Buffer.concat(chunks);
      resolve(code === 0 && jpeg.length > 2 && jpeg[0] === 0xff && jpeg[1] === 0xd8 ? jpeg : undefined);
    });
  });
}
