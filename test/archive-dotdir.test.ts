// Review of #159: a data folder with a dot in its path (~/.cam-proxy/data)
// must still serve archived videos (sendFile refuses dotfiles by default).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { execFile } from 'child_process';
import { statSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { startSim } from './helpers/sim';
import { auth, startProxy } from './helpers/proxy';
import { fileSource } from '../src/archive/sources';

const run = promisify(execFile);
let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
let id = 0;
let size = 0;

beforeAll(async () => {
  sim = await startSim();
  p = await startProxy(sim, { settings: { server: { logLevel: 'silent', dataDir: '.cam-proxy/data' } } });
  const clip = join(p.dir, 'clip.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
  size = statSync(clip).size;
  const job = p.proxy.archive.create({ cam: 'cam1', source: { type: 'clip', clipId: 1 }, kind: 'clip', window: { from: 0, to: 1000 }, quality: 'sd', original: true, size, durationS: 1, obtain: fileSource(clip), labels: [], retentionDays: 1, createdBy: 'client' }, { user: 'client' });
  if (job === 'busy') throw new Error('busy');
  id = (await p.proxy.archive.jobs.wait(job.id, 20_000))!.archiveId!;
}, 60_000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

describe('a data folder under a dot folder', () => {
  it('serves the video, whole and as a range', async () => {
    expect(p.proxy.running.server.dataDir).toContain('/.cam-proxy/');
    const r = await request(p.base).get(`/api/archive/${id}/video`).set(auth());
    expect(r.status).toBe(200);
    expect(Number(r.headers['content-length'])).toBe(size);
    expect((await request(p.base).get(`/api/archive/${id}/video`).set(auth()).set('Range', 'bytes=0-9')).status).toBe(206);
  });
});
