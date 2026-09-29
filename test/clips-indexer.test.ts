import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { openCatalog } from '../src/catalog/db';
import { insertEvent, closeEvent } from '../src/catalog/events';
import { clipById, listClips } from '../src/catalog/clips';
import { ClipIndexer, localToUtc, parseClipName } from '../src/clips/indexer';
import { timeInfoFromGetTime } from '../src/camera/time';
import { DEFAULTS } from '../src/config/defaults';
import { StreamLog } from '../src/stream/log';
import type { Upload } from '../src/clips/ftp-server';

const run = promisify(execFile);

// GetTime as cam-sim answers it for America/Chicago (the measured US rule).
const chicago = (isDst: number) =>
  timeInfoFromGetTime({
    Dst: { enable: 1, offset: 1, startMon: 3, startWeek: 2, startWeekday: 0, startHour: 2, startMin: 0, startSec: 0, endMon: 11, endWeek: 1, endWeekday: 0, endHour: 2, endMin: 0, endSec: 0 },
    Time: { year: 2026, mon: 9, day: 27, hour: 9, min: 0, sec: 0, hourFmt: 1, isDst, timeFmt: 'MM/DD/YYYY', timeZone: 21600 },
  });

let clipFile = '';
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-clipsrc-'));
  clipFile = join(dir, 'clip.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipFile]);
}, 30_000);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-clips-'));
  const catalog = openCatalog(join(dir, 'catalog.sqlite'));
  const log = new StreamLog(catalog, () => Date.now());
  const config = structuredClone(DEFAULTS);
  config.server.dataDir = dir;
  const indexer = new ClipIndexer({ catalog, log, config: () => config, timeInfo: async () => chicago(1), dataDir: dir, cam: 'cam1' });
  const incoming = join(dir, 'ftp', '.incoming');
  mkdirSync(incoming, { recursive: true });
  let n = 0;
  // An upload as the FTP server reports it: the file already sits in .incoming.
  const upload = (name: string, content: Buffer): Upload => {
    const tmpFile = join(incoming, `t${n++}`);
    writeFileSync(tmpFile, content);
    return { path: `/2026/09/27/${name}`, name, dir: '/2026/09/27', bytes: content.length, tmpFile };
  };
  return { dir, catalog, log, indexer, upload };
}

describe('clip names', () => {
  it('parses the camera’s upload names', () => {
    expect(parseClipName('Den_00_20260927140301.mp4')).toEqual({ local: '20260927140301', ext: 'mp4' });
    expect(parseClipName('Front Door_00_20260927140301.jpg')).toEqual({ local: '20260927140301', ext: 'jpg' });
    expect(parseClipName('Den_00_2026092714030.mp4')).toBeNull();
    expect(parseClipName('Den_00_20260927140301.txt')).toBeNull();
    expect(parseClipName('notes.mp4')).toBeNull();
    expect(parseClipName('Den_00_20261399999999.mp4')).toBeNull();
  });

  it('turns camera-local names into UTC across the DST changes (Chicago)', () => {
    const t = chicago(1);
    expect(localToUtc('20260927140301', t)).toBe(Date.UTC(2026, 8, 27, 19, 3, 1)); // CDT, UTC-5
    expect(localToUtc('20260115080000', t)).toBe(Date.UTC(2026, 0, 15, 14, 0, 0)); // CST, UTC-6
    // Spring: 2026-03-08 02:00 CST → 03:00 CDT.
    expect(localToUtc('20260308015959', t)).toBe(Date.UTC(2026, 2, 8, 7, 59, 59));
    expect(localToUtc('20260308030000', t)).toBe(Date.UTC(2026, 2, 8, 8, 0, 0));
    // Fall: 2026-11-01 02:00 CDT → 01:00 CST; 00:59 is still CDT, 02:00 is CST.
    expect(localToUtc('20261101005900', t)).toBe(Date.UTC(2026, 10, 1, 5, 59, 0));
    expect(localToUtc('20261101020000', t)).toBe(Date.UTC(2026, 10, 1, 8, 0, 0));
    // A zone without DST.
    const utc = timeInfoFromGetTime({ Dst: { enable: 0 }, Time: { timeZone: 0 } });
    expect(localToUtc('20260704120000', utc)).toBe(Date.UTC(2026, 6, 4, 12, 0, 0));
  });
});

describe('ClipIndexer', () => {
  it('indexes a valid clip with its duration, the overlapping events, and a stream message', async () => {
    const { indexer, upload, catalog, log, dir } = setup();
    const start = Date.UTC(2026, 8, 27, 19, 3, 1);
    const inside = insertEvent(catalog, { cam: 'cam1', source: 'onvif', kind: 'motion', start_ts: start + 1000, raw: null });
    closeEvent(catalog, inside.id, start + 2000, 'state');
    const before = insertEvent(catalog, { cam: 'cam1', source: 'onvif', kind: 'motion', start_ts: start - 60_000, raw: null });
    closeEvent(catalog, before.id, start - 50_000, 'state');
    const u = upload('Den_00_20260927140301.mp4', readFileSync(clipFile));
    const row = await indexer.add(u);
    expect(row).not.toBeNull();
    expect(row!.start_ts).toBe(start);
    expect(row!.end_ts! - start).toBeGreaterThanOrEqual(2900);
    expect(row!.end_ts! - start).toBeLessThanOrEqual(3100);
    expect(row!.stream).toBe('main');
    expect(row!.path).toBe(join(dir, 'clips', 'cam1', '2026', '09', '27', `1903-${start}.mp4`));
    expect(existsSync(row!.path)).toBe(true);
    expect(existsSync(u.tmpFile)).toBe(false);
    expect(clipById(catalog, row!.id)?.size).toBe(u.bytes);
    expect(listClips(catalog, 'cam1', start - 1000, start + 1000).map((c) => c.id)).toEqual([row!.id]);
    const msg = log.since(0, { types: ['clip'] }, 100).find((m) => m.type === 'clip');
    expect(msg?.data).toMatchObject({ clipId: row!.id, start, end: row!.end_ts, stream: 'main', size: u.bytes, events: [inside.id], url: `/api/cameras/cam1/clips/${row!.id}.mp4` });
  });

  it('drops a file that is not a video, and counts the failure', async () => {
    const { indexer, upload, catalog } = setup();
    const u = upload('Den_00_20260927140301.mp4', Buffer.from('not a video at all'));
    expect(await indexer.add(u)).toBeNull();
    expect(existsSync(u.tmpFile)).toBe(false);
    expect(listClips(catalog, 'cam1', 0, Date.now())).toHaveLength(0);
    expect(indexer.failures()).toBe(1);
  });

  // Measured: the camera's FTP test (TestFtp) uploads <Name>_00_<time>.txt.
  it('removes the camera’s FTP test file quietly, without counting a failure', async () => {
    const { indexer, upload } = setup();
    const u = upload('Den_00_20260927144657.txt', Buffer.from('test'));
    expect(await indexer.add(u)).toBeNull();
    expect(existsSync(u.tmpFile)).toBe(false);
    expect(indexer.failures()).toBe(0);
  });

  // Issue #5: a snapshot must be a JPEG.
  it('drops a .jpg that isn’t a JPEG', async () => {
    const { indexer, upload } = setup();
    const u = upload('Den_00_20260927140301.jpg', Buffer.from('<html>not an image</html>'));
    expect(await indexer.add(u)).toBeNull();
    expect(existsSync(u.tmpFile)).toBe(false);
    expect(indexer.failures()).toBe(1);
  });

  it('drops a file with an unknown name', async () => {
    const { indexer, upload } = setup();
    const u = upload('whatever.mp4', readFileSync(clipFile));
    expect(await indexer.add(u)).toBeNull();
    expect(existsSync(u.tmpFile)).toBe(false);
  });

  it('attaches the snapshot whether it arrives after or before the clip', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    {
      const { indexer, upload, catalog } = setup();
      const row = await indexer.add(upload('Den_00_20260927140301.mp4', readFileSync(clipFile)));
      expect(row!.snapshot).toBeNull();
      expect(await indexer.add(upload('Den_00_20260927140301.jpg', jpeg))).toBeNull();
      const snap = clipById(catalog, row!.id)!.snapshot!;
      expect(snap.endsWith('.jpg')).toBe(true);
      expect(readFileSync(snap)).toEqual(jpeg);
    }
    {
      const { indexer, upload, catalog } = setup();
      await indexer.add(upload('Den_00_20260927140301.jpg', jpeg));
      const row = await indexer.add(upload('Den_00_20260927140301.mp4', readFileSync(clipFile)));
      expect(clipById(catalog, row!.id)!.snapshot).toBe(row!.path.replace(/\.mp4$/, '.jpg'));
    }
  });

  // Issue #5: in the repeated autumn hour the camera's local name is the
  // same for both passes; the later upload is the second pass (standard time).
  it('keeps both clips of the repeated autumn hour', async () => {
    const { indexer, upload, catalog } = setup();
    let now = Date.UTC(2026, 10, 1, 6, 31, 0); // 01:31 CDT, the first pass
    indexer.setClock(() => now);
    const first = await indexer.add(upload('Den_00_20261101013000.mp4', readFileSync(clipFile)));
    now += 3_600_000; // an hour later: 01:31 CST, the second pass
    const second = await indexer.add(upload('Den_00_20261101013000.mp4', readFileSync(clipFile)));
    expect(first!.start_ts).toBe(Date.UTC(2026, 10, 1, 6, 30, 0));
    expect(second!.start_ts).toBe(Date.UTC(2026, 10, 1, 7, 30, 0));
    expect(second!.path).not.toBe(first!.path);
    expect(existsSync(first!.path) && existsSync(second!.path)).toBe(true);
    expect(clipById(catalog, first!.id)).toBeDefined();
  });

  it('still replaces a quickly repeated upload of the same clip', async () => {
    const { indexer, upload, catalog } = setup();
    const a = await indexer.add(upload('Den_00_20260927140301.mp4', readFileSync(clipFile)));
    const b = await indexer.add(upload('Den_00_20260927140301.mp4', readFileSync(clipFile)));
    expect(b!.path).toBe(a!.path);
    expect(listClips(catalog, 'cam1', a!.start_ts - 1000, a!.start_ts + 1000)).toHaveLength(1); // replaced, not added
  });
});
