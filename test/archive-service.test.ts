// The Archive service's space check across jobs in flight (review of #159):
// two clips that each fit alone must not together pass storage.minFreeBytes.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog } from '../src/catalog/db';
import { StreamLog } from '../src/stream/log';
import { AuditLog } from '../src/audit/audit-log';
import { DEFAULTS } from '../src/config/defaults';
import { Archive } from '../src/archive/service';
import { ArchiveJobError, fileSource, type Obtain } from '../src/archive/sources';
import { SPARE_BYTES, type ArchiveRequest, type JobView } from '../src/archive/jobs';

const MB = 2 ** 20;
function setup(free: number) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-asvc-'));
  const catalog = openCatalog(join(dir, 'catalog.sqlite'));
  const config = structuredClone(DEFAULTS);
  config.server.dataDir = dir;
  config.storage.minFreeBytes = 100 * MB;
  const archive = new Archive({
    dataDir: dir, catalog, log: new StreamLog(catalog), audit: new AuditLog({ dir: join(dir, 'audit'), version: 't' }), config: () => config,
    disk: () => ({ free, size: 10_000 * MB }), timeInfo: () => undefined, cameraName: () => 'Den', cameraModel: () => null, version: 't',
    stillsIn: () => [], readStill: async () => undefined, media: { duration: async () => 1, frame: async () => undefined },
  });
  return { dir, archive };
}
const req = (obtain: Obtain, size: number): ArchiveRequest => ({
  cam: 'cam1', source: { type: 'clip', clipId: 1 }, kind: 'clip', window: { from: 0, to: 1000 }, quality: 'sd', original: true, size, durationS: 1, obtain, labels: [], retentionDays: 1, createdBy: 'client',
});

describe('Archive.checkSpace with jobs in flight', () => {
  it('counts what the other jobs still have to write', async () => {
    const size = 60 * MB;
    // Free: the floor plus room for one clip, not two.
    const { archive } = setup(100 * MB + size + SPARE_BYTES + 10 * MB);
    expect(() => archive.checkSpace(size)).not.toThrow(); // alone it fits
    let release!: () => void;
    const hang: Obtain = ({ signal }) => new Promise((resolve, reject) => {
      release = () => reject(new ArchiveJobError('cancelled', 'cancelled'));
      signal.addEventListener('abort', release);
    });
    const a = archive.create(req(hang, size), { user: 'client' }) as JobView;
    await new Promise((r) => setTimeout(r, 20));
    expect(archive.jobs.get(a.id)?.state).toBe('running');
    // The second one would fit alone, not beside the first.
    expect(() => archive.checkSpace(size)).toThrow(ArchiveJobError);
    try {
      archive.checkSpace(size);
    } catch (err) {
      expect((err as ArchiveJobError).extra).toMatchObject({ needed: size + SPARE_BYTES, inFlight: size + SPARE_BYTES });
    }
    // The running job's own checks don't count itself.
    release();
    await archive.jobs.wait(a.id, 2000);
    expect(() => archive.checkSpace(size)).not.toThrow();
  });

  it('a job in flight is refused when another took the room meanwhile', async () => {
    const size = 60 * MB;
    const { dir, archive } = setup(100 * MB + size + SPARE_BYTES + 10 * MB);
    const file = join(dir, 'x.mp4');
    writeFileSync(file, Buffer.alloc(10));
    let release!: () => void;
    const first = archive.create(req(({ signal }) => new Promise((_r, reject) => { release = () => reject(new ArchiveJobError('cancelled', 'cancelled')); signal.addEventListener('abort', release); }), size), { user: 'client' }) as JobView;
    await new Promise((r) => setTimeout(r, 20));
    const second = archive.create(req(fileSource(file), size), { user: 'client' }) as JobView;
    expect(await archive.jobs.wait(second.id, 2000)).toMatchObject({ state: 'failed', error: 'insufficient_space' });
    release();
    await archive.jobs.wait(first.id, 2000);
  });
});
