import { defineConfig, devices } from '@playwright/test';
import { PROXY_PORT, STATE_FILE } from './e2e/env';

export default defineConfig({
  testDir: 'e2e',
  // The multi-camera run has its own config (playwright.multi.config.ts);
  // a project's testIgnore replaces this one, so the projects repeat it.
  testIgnore: ['multi/**'],
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${PROXY_PORT}`, ...devices['Desktop Chrome'], channel: 'chrome' },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/, testIgnore: ['multi/**'] },
    { name: 'e2e', dependencies: ['setup'], testIgnore: [/auth\.setup\.ts/, 'multi/**'], use: { storageState: STATE_FILE } },
  ],
  webServer: {
    command: 'npx tsx e2e/start.ts',
    port: PROXY_PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
