import { defineConfig } from 'vitest/config';
import { existsSync } from 'fs';
import { resolve } from 'path';

// go2rtc and MediaMTX (cam-sim's RTSP) from tools/ when installed there
// (scripts/install-go2rtc.sh, scripts/install-mediamtx.sh); CI sets them itself.
const tool = (name: string) => (existsSync(resolve('tools', name)) ? resolve('tools', name) : undefined);
const env: Record<string, string> = { TZ: 'America/Chicago' };
const go2rtc = process.env.CAMPROXY_TEST_GO2RTC ?? tool('go2rtc');
const mediamtx = process.env.CAMSIM_MEDIAMTX ?? tool('mediamtx');
if (go2rtc) env.CAMPROXY_TEST_GO2RTC = go2rtc;
if (mediamtx) env.CAMSIM_MEDIAMTX = mediamtx;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
    env,
  },
});
