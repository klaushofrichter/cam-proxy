import { test, expect, type Page } from '@playwright/test';
import { ADMIN_TOKEN, SIM, SIM_CONTROL_TOKEN, VISION_MOCK_PORT } from './env';

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByTestId('token-input').fill(ADMIN_TOKEN);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('shell')).toBeVisible();
}
const calls = async (page: Page) => (await (await page.request.get(`http://127.0.0.1:${VISION_MOCK_PORT}/calls`)).json()).calls as number;
const person = (page: Page) => page.request.post(`http://127.0.0.1:${SIM.control}/sim/api/events`, { headers: { Authorization: `Bearer ${SIM_CONTROL_TOKEN}` }, data: { type: 'person', durationS: 2 } });
const reset = { analytics: { kinds: { person: true, vehicle: false, pet: false }, googleVision: { enabled: false, monthlyLimit: 0, dailyCap: 0 } } };

test.describe.configure({ mode: 'serial' });

// Start from known settings: another spec may have left a daily cap behind.
test.beforeAll(async ({ request }) => {
  const r = await request.put('/control/config', { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }, data: reset });
  expect(r.ok()).toBe(true);
});

test('with the limit at 0, a person event reaches no analytics call', async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId('stream-state')).toHaveText('up', { timeout: 30000 });
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('analytics-key')).toContainText('e2e-…cret');
  await page.getByTestId('analytics-enabled').check();
  await expect(page.getByTestId('analytics-message')).toContainText('saved');
  const before = await calls(page);
  expect((await person(page)).status()).toBe(201);
  // The event reached the service and was skipped for the limit (the path ran)...
  await page.getByTestId('nav-events').click();
  await expect(page.getByTestId('analysis-tag').first()).toContainText('✦ not analysed (limit)', { timeout: 20000 });
  // ...and no call went out.
  expect(await calls(page)).toBe(before);
});

test('a person event is analysed: Status counts it, Events tags it, the Timeline marks it, the modal shows the box', async ({ page }) => {
  await signIn(page);
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('analytics-monthly').fill('10');
  await page.getByTestId('analytics-monthly-save').click();
  await expect(page.getByTestId('analytics-message')).toContainText('saved'); // the limit is in force before the event comes
  await expect(page.getByTestId('analytics-estimate')).toContainText('Up to 10 calls a month: free');
  const before = await calls(page);
  expect((await person(page)).status()).toBe(201);
  await expect.poll(() => calls(page), { timeout: 20000 }).toBe(before + 1);

  await page.getByTestId('nav-status').click();
  await expect(page.getByTestId('analytics-usage')).toContainText('1 of 10 this month');

  await page.getByTestId('nav-events').click();
  const tag = page.getByTestId('analysis-tag').first();
  await expect(tag).toContainText('✦ Vision: Person 0.90', { timeout: 15000 });
  await tag.click();
  const modal = page.getByTestId('analysis-modal');
  await expect(modal).toBeVisible();
  await expect(modal.getByTestId('analysis-boxes').locator('rect')).toHaveCount(1);
  await expect.poll(() => modal.getByTestId('analysis-image').evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBe(896);
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);

  await page.getByTestId('nav-timeline').click();
  const analysed = page.locator('[data-testid="minute"].analysed').last();
  await expect(analysed).toBeVisible({ timeout: 15000 });
  await expect(page.locator('[data-testid="minute-count"]').first()).toContainText('×'); // person + its motion event
  await analysed.click();
  await page.getByTestId('minute-analysis-link').first().click();
  await expect(page.getByTestId('analysis-modal')).toBeVisible();
});

test.afterAll(async ({ request }) => {
  // Leave analytics off for the other specs.
  await request.put('/control/config', { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }, data: reset });
});
