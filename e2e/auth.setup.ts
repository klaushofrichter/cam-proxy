import { test as setup, expect } from '@playwright/test';
import { ADMIN_TOKEN } from './env';

// One sign-in for the whole run, saved as storageState: the /control/login
// limiter (40 per 15 min per IP) is shared by every spec, so specs that only
// need a signed-in page reuse this session instead of signing in again. The
// session is a signed cookie, so a sign-out in one spec doesn't end it.
export const STATE_FILE = 'e2e/.auth/state.json';

setup('sign in once', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('token-input').fill(ADMIN_TOKEN);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('shell')).toBeVisible();
  await page.context().storageState({ path: STATE_FILE });
});
