import { test as setup, expect } from '@playwright/test';
import { ADMIN_TOKEN, STATE_FILE } from './env';

setup('sign in once', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('token-input').fill(ADMIN_TOKEN);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('shell')).toBeVisible();
  await page.context().storageState({ path: STATE_FILE });
});
