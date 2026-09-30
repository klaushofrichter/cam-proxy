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

// Klaus, 2026-09-30: a minute clicked in the hour grid opens at the top,
// in view, and looks different from the hour cards; the minute is marked.
test('a minute clicked low in the page opens at the top, set apart from the hour cards', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 360 }); // short, so the grid is below the fold
  await signIn(page);
  await expect(page.getByTestId('stream-state')).toHaveText('up', { timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.getByTestId('nav-timeline').click();
  const minute = page.getByTestId('minute').last();
  await expect(minute).toBeVisible({ timeout: 10000 });
  await minute.scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 2000); // as far down as the page goes
  await minute.click();
  const detail = page.getByTestId('minute-detail');
  await expect(detail).toBeInViewport();
  // Right under the top bar.
  const barBottom = await page.locator('header').first().evaluate((el) => el.getBoundingClientRect().bottom);
  await expect.poll(() => detail.evaluate((el) => Math.round(el.getBoundingClientRect().top)), { timeout: 5000 }).toBeLessThan(barBottom + 30);
  const bg = (loc: import('@playwright/test').Locator) => loc.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await bg(detail)).not.toBe(await bg(page.getByTestId('hour-card').first()));
  await expect(page.locator('[data-testid="minute"].active')).toHaveCount(1);
});
