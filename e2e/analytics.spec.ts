import { test, expect, type Page } from '@playwright/test';
import { ADMIN_TOKEN, CLIENT_TOKEN, SIM, SIM_CONTROL_TOKEN, VISION_MOCK_PORT } from './env';

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByTestId('token-input').fill(ADMIN_TOKEN);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('shell')).toBeVisible();
}
const calls = async (page: Page) => (await (await page.request.get(`http://127.0.0.1:${VISION_MOCK_PORT}/calls`)).json()).calls as number;
const person = (page: Page) => page.request.post(`http://127.0.0.1:${SIM.control}/sim/api/events`, { headers: { Authorization: `Bearer ${SIM_CONTROL_TOKEN}` }, data: { type: 'person', durationS: 2 } });
const setScript = (page: Page, script: unknown[]) => page.request.post(`http://127.0.0.1:${VISION_MOCK_PORT}/script`, { data: script });
// cam-sim counts a person trigger during an active one as the same detection,
// so no new event starts: wait until the proxy has closed every person event
// (the previous test's may still run on a fast CI runner).
async function personEventsClosed(page: Page) {
  const headers = { Authorization: `Bearer ${CLIENT_TOKEN}` };
  const [cam] = (await (await page.request.get('/api/cameras', { headers })).json()) as { id: string }[];
  const now = Date.now();
  await expect
    .poll(async () => {
      const evs = (await (await page.request.get(`/api/cameras/${encodeURIComponent(cam.id)}/events?from=${now - 3_600_000}&to=${now + 60_000}&limit=100`, { headers })).json()) as { kind: string; end: number | null }[];
      return evs.filter((e) => e.kind === 'person').every((e) => e.end !== null);
    }, { timeout: 15000 })
    .toBe(true);
}
const FAN = { mid: '/m/03ldnb', name: 'Ceiling fan', score: 0.8, vertices: [{ x: 0.6, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.4 }, { x: 0.6, y: 0.4 }] };
const PERSON = { mid: '/m/01g317', name: 'Person', score: 0.9, vertices: [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.2 }, { x: 0.4, y: 0.9 }, { x: 0.1, y: 0.9 }] };
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
  // The mock sees a person and a ceiling fan: the fan is no relevant finding.
  expect((await setScript(page, [{ objects: [PERSON, FAN] }])).ok()).toBe(true);
  await personEventsClosed(page);
  const before = await calls(page);
  expect((await person(page)).status()).toBe(201);
  await expect.poll(() => calls(page), { timeout: 20000 }).toBe(before + 1);

  await page.getByTestId('nav-status').click();
  await expect(page.getByTestId('analytics-usage')).toContainText('1 of 10 this month');
  await expect(page.getByTestId('card-analytics-unmapped')).toContainText('Ceiling fan');

  await page.getByTestId('nav-events').click();
  const tag = page.getByTestId('analysis-tag').first();
  await expect(tag).toContainText('✦ Vision: Person 0.90', { timeout: 15000 });
  await tag.click();
  const modal = page.getByTestId('analysis-modal');
  await expect(modal).toBeVisible();
  await expect(modal.getByTestId('analysis-boxes').locator('rect')).toHaveCount(1);
  await modal.getByTestId('analysis-show-all').check();
  await expect(modal.getByTestId('analysis-boxes').locator('rect')).toHaveCount(2);
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
  await request.post(`http://127.0.0.1:${VISION_MOCK_PORT}/script`, { data: [] });
  // Leave analytics off for the other specs.
  await request.put('/control/config', { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }, data: reset });
});
