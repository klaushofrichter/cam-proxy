import { test, expect, type Page } from '@playwright/test';
import { ADMIN_TOKEN, SIM, SIM_CONTROL_TOKEN } from './env';

async function signIn(page: Page) {
  await page.goto('/'); // signed in by the storageState from auth.setup.ts
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
  // Not an analysed tile: that opens the analysis modal (analytics.spec leaves one).
  await page.locator('[data-testid="tile"]:not([disabled]):not(.analysed)').first().click();
  const img = page.getByTestId('still');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10000 }).toBe(896);
});

// Klaus, 2026-09-30: the minute opens inside its hour card, right under that
// hour's thumbnails (no scrolling), set apart by its background; ◀ ▶ step
// within the hour; an event's seconds are framed and the event is named.
test('the minute opens under its hour, steps within the hour, and shows its event', async ({ page, request }) => {
  await signIn(page);
  await expect(page.getByTestId('stream-state')).toHaveText('up', { timeout: 30000 });
  const r = await request.post(`http://127.0.0.1:${SIM.control}/sim/api/events`, { headers: { Authorization: `Bearer ${SIM_CONTROL_TOKEN}` }, data: { type: 'person', durationS: 3 } });
  expect(r.status()).toBe(201);
  await page.waitForTimeout(5000); // the event ends and its stills are written
  await page.getByTestId('nav-timeline').click();
  const evMinute = page.locator('[data-testid="minute"].ev-person').last();
  await expect(evMinute).toBeVisible({ timeout: 15000 });
  const scrollBefore = await page.evaluate(() => document.scrollingElement!.scrollTop);
  await evMinute.click();

  const hourCard = page.getByTestId('hour-card').filter({ has: page.locator('[data-testid="minute"].active') });
  const detail = hourCard.getByTestId('minute-detail');
  await expect(detail).toBeVisible();
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(scrollBefore); // nothing scrolled
  const bg = (loc: import('@playwright/test').Locator) => loc.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await bg(detail)).not.toBe(await bg(hourCard));

  await expect(detail.getByTestId('minute-events')).toContainText('person');
  expect(await detail.locator('[data-testid="tile"].ev-person').count()).toBeGreaterThan(0);

  // ◀ ▶ within this hour only: disabled at its ends. Read in one go: a new
  // minute can arrive at any moment and enable ▶.
  const minutes = hourCard.getByTestId('minute');
  const state = () => hourCard.evaluate((card) => {
    const list = [...card.querySelectorAll('[data-testid="minute"]')];
    const idx = list.findIndex((e) => e.classList.contains('active'));
    const btn = (id: string) => (card.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).disabled;
    return { idx, prevOk: btn('minute-prev') === (idx === 0), nextOk: btn('minute-next') === (idx === list.length - 1) };
  });
  await expect.poll(async () => { const s = await state(); return s.prevOk && s.nextOk; }).toBe(true);
  const { idx } = await state();
  if (idx > 0) {
    await detail.getByTestId('minute-prev').click();
    await expect(minutes.nth(idx - 1)).toHaveClass(/active/);
  }
});
