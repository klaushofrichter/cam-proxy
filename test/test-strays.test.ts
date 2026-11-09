import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { strayPids } from './helpers/strays';

// #119: an aborted or crashed test run (a killed worker, a timeout, Ctrl-C)
// left cam-sim's MediaMTX and cam-proxy's go2rtc running, 67 of them on
// 2026-10-03. Every run reaps those of earlier runs (global setup and
// teardown): a media child of a test temp folder whose parent is gone.
describe('stray media children of earlier test runs', () => {
  const node = (pid: number) => ({ pid, ppid: 1, args: ['/usr/local/bin/node', 'worker.js'] });
  const mtx = (pid: number, ppid: number, dir = 'camsim-rtsp-abc') => ({ pid, ppid, args: ['/x/tools/mediamtx', join(tmpdir(), dir, 'mediamtx.yml')] });
  const g2r = (pid: number, ppid: number, dir = 'camproxy-go2rtc-abc') => ({ pid, ppid, args: ['/x/tools/go2rtc', '-c', join(tmpdir(), dir, 'go2rtc.json')] });

  it('a MediaMTX and a go2rtc of the test temp folders whose parent is gone', () => {
    expect(strayPids([node(500), mtx(10, 1), g2r(11, 1), mtx(12, 99), g2r(13, 98)], 500)).toEqual([10, 11, 12, 13]);
  });
  it('never one of a live node (a running test worker, another run side by side)', () => {
    expect(strayPids([node(500), node(600), mtx(10, 600), g2r(11, 600), mtx(12, 500)], 500)).toEqual([]);
  });
  it('never one outside those folders, nor another program with such a folder', () => {
    const other = { pid: 14, ppid: 1, args: ['/bin/cat', join(tmpdir(), 'camsim-rtsp-abc', 'mediamtx.yml')] };
    expect(strayPids([mtx(10, 1, 'elsewhere'), g2r(11, 1, 'mine'), other], 500)).toEqual([]);
  });
  it("never one a live test process orphaned on purpose (its folder names that pid); once that process is gone, it is a stray", () => {
    const marked = (pid: number, owner: number) => g2r(pid, 1, `camproxy-go2rtc-run${owner}-abc`);
    expect(strayPids([node(500), node(600), marked(10, 600), mtx(11, 1, 'camsim-rtsp-run600-x')], 500)).toEqual([]);
    expect(strayPids([node(500), marked(10, 600), mtx(11, 1, 'camsim-rtsp-run600-x')], 500)).toEqual([10, 11]);
    // Only the folder's own marker counts, not one further on.
    expect(strayPids([node(500), node(600), g2r(12, 1, 'camproxy-go2rtc-x-run600-')], 500)).toEqual([12]);
  });
  it('never this process', () => {
    expect(strayPids([{ ...mtx(500, 1) }], 500)).toEqual([]);
  });
});
