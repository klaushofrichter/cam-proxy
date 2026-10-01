// Real Google Vision calls, by hand only (never in CI, never in npm test):
// sends the given JPEGs, at most LIMIT (default 5), and prints the time and
// the objects per image as JSON lines. Needs CAMPROXY_GOOGLE_VISION_KEY in
// the environment (CAMPROXY_GOOGLE_VISION_URL overrides Google's address).
// Scripts in this repo run with tsx, like scripts/verify-camera.ts:
//
//   CAMPROXY_GOOGLE_VISION_KEY=... npx tsx scripts/analytics-live.ts a.jpg b.jpg
//   LIMIT=2 npx tsx --env-file=.env scripts/analytics-live.ts data/stills/*.jpg
import { readFileSync } from 'fs';
import { basename } from 'path';
import { googleVision } from '../src/analytics/google-vision';

const key = process.env.CAMPROXY_GOOGLE_VISION_KEY;
if (!key) {
  console.error('set CAMPROXY_GOOGLE_VISION_KEY');
  process.exit(2);
}
const limit = Number(process.env.LIMIT ?? 5);
const files = process.argv.slice(2).slice(0, limit);
const vision = googleVision({ key, baseUrl: process.env.CAMPROXY_GOOGLE_VISION_URL ?? 'https://vision.googleapis.com' });

// Exits 1 when every call failed.
async function main() {
  let ok = 0;
  for (const f of files) {
    const t0 = Date.now();
    try {
      const r = await vision.analyze(readFileSync(f), AbortSignal.timeout(10_000));
      console.log(JSON.stringify({ file: basename(f), seconds: (Date.now() - t0) / 1000, objects: r.objects.map((o) => [o.name, Number(o.score.toFixed(2))]) }));
      ok++;
    } catch (err) {
      console.log(JSON.stringify({ file: basename(f), seconds: (Date.now() - t0) / 1000, error: (err as Error).message }));
    }
  }
  if (files.length && !ok) process.exitCode = 1;
}
void main();
