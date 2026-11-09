import { defineConfig, devices } from '@playwright/test';
import { PROXY_PORT, STATE_FILE } from './e2e/multi/env';

export default defineConfig({
  testDir: 'e2e/multi',
  // Reaps MediaMTX/go2rtc left by an aborted run (#119).
  globalSetup: './test/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${PROXY_PORT}`, ...devices['Desktop Chrome'], channel: 'chrome' },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'e2e', dependencies: ['setup'], testIgnore: /auth\.setup\.ts/, use: { storageState: STATE_FILE } },
  ],
  webServer: { command: 'npx tsx e2e/multi/start.ts', port: PROXY_PORT, reuseExistingServer: !process.env.CI, timeout: 60_000 },
});
