import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

// Async: cam-sim runs in this process and answers MediaMTX's auth callback,
// so a synchronous child would deadlock it.
const run = promisify(execFile);
import { startSim } from './helpers/sim';

// go2rtc and MediaMTX (cam-sim's RTSP) are needed from Plan 2 on; CI installs
// both (scripts/install-go2rtc.sh, scripts/install-mediamtx.sh).
const go2rtc = process.env.CAMPROXY_TEST_GO2RTC;
let close: (() => Promise<void>) | undefined;
afterAll(async () => close?.());

describe('test tools', () => {
  it('go2rtc runs', () => {
    expect(go2rtc, 'run scripts/install-go2rtc.sh').toBeTruthy();
    expect(execFileSync(go2rtc!, ['-version'], { encoding: 'utf8' })).toMatch(/go2rtc version 1\.9\.14/);
  });

  it("cam-sim serves RTSP (MediaMTX), sub stream H.264 896x512", async () => {
    expect(process.env.CAMSIM_MEDIAMTX, 'run scripts/install-mediamtx.sh').toBeTruthy();
    const s = await startSim();
    close = s.close;
    expect(s.ports.rtsp).toBeGreaterThan(0);
    const { stdout } = await run('ffprobe', ['-v', 'error', '-rtsp_transport', 'tcp', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0',
      `rtsp://proxy:${s.password}@127.0.0.1:${s.ports.rtsp}/h264Preview_01_sub`], { timeout: 20000 });
    expect(stdout.trim()).toBe('h264,896,512');
  }, 30000);
});
