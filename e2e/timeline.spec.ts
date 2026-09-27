import { test, expect, type Page } from '@playwright/test';
import { ADMIN_TOKEN } from './env';

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByTestId('token-input').fill(ADMIN_TOKEN);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('shell')).toBeVisible();
}

test('the status page shows the stills stream up', async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId('stream-state')).toHaveText('up', { timeout: 30000 });
});

test('the timeline shows today’s minutes, and a click shows a still', async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId('stream-state')).toHaveText('up', { timeout: 30000 });
  await page.waitForTimeout(3000); // a few seconds of stills
  await page.getByTestId('nav-timeline').click();
  const minute = page.getByTestId('minute').last();
  await expect(minute).toBeVisible({ timeout: 10000 });
  await minute.click();
  await expect(page.getByTestId('minute-detail')).toBeVisible();
  await page.locator('[data-testid="tile"]:not([disabled])').first().click();
  const img = page.getByTestId('still');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10000 }).toBe(896);
});
