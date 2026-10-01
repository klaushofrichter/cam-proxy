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
// No coordinates: stored as a zero-area box, listed but not drawn.
const LAMP = { mid: '/m/0dtln', name: 'lamp', score: 0.55, vertices: [] };
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
  // Nothing enabled: Status shows one "Analytics: not enabled" card (issue #52).
  await page.getByTestId('nav-status').click();
  await expect(page.getByTestId('card-analytics')).toContainText('not enabled');
  await expect(page.getByTestId('card-analytics-google-vision')).toHaveCount(0);
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
  const rects = modal.getByTestId('analysis-boxes').locator('rect');
  const labels = modal.getByTestId('analysis-label');
  const rows = modal.getByTestId('analysis-object');
  await expect(rects).toHaveCount(1);
  await expect(labels).toHaveText(['Person 90%']); // the overlay reads percent; the table keeps 0.90
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('0.90');
  // The summary's row selects, too: its box stays, and clicking again keeps it.
  await rows.first().click();
  await expect(rows.first()).toHaveAttribute('aria-pressed', 'true');
  await expect(rects).toHaveCount(1);
  await modal.getByTestId('analysis-show-all').check();
  // Switching to all objects clears the selection.
  await expect(rows).toHaveCount(2);
  await expect(modal.locator('[data-testid="analysis-object"][aria-pressed="true"]')).toHaveCount(0);
  await expect(rects).toHaveCount(2);
  await expect(labels).toHaveText(['Person 90%', 'Ceiling fan 80%']);
  // A row draws only its box; clicking it again draws all; another row switches.
  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(rows.nth(0)).toHaveAttribute('aria-pressed', 'false');
  await expect(rects).toHaveCount(1);
  await expect(labels).toHaveText(['Ceiling fan 80%']);
  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'false');
  await expect(rects).toHaveCount(2);
  await rows.nth(1).click();
  await rows.nth(0).click();
  await expect(labels).toHaveText(['Person 90%']);
  // Enter on a focused row selects it (keyboard).
  await rows.nth(1).focus();
  await page.keyboard.press('Enter');
  await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(labels).toHaveText(['Ceiling fan 80%']);
  await page.keyboard.press('Enter');
  await expect(rects).toHaveCount(2);
  await expect.poll(() => modal.getByTestId('analysis-image').evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBe(896);
  // The frame (border, rounded corners) doesn't scroll; the body inside it does,
  // so the scrollbar can't paint over the corners.
  await page.setViewportSize({ width: 1280, height: 600 });
  const body = modal.getByTestId('analysis-body');
  await expect.poll(() => body.evaluate((b) => b.scrollHeight > b.clientHeight)).toBe(true);
  expect(await modal.evaluate((m) => getComputedStyle(m).overflow)).toBe('hidden');
  expect(await modal.evaluate((m) => m.scrollHeight <= m.clientHeight)).toBe(true);
  expect(await modal.evaluate((m) => (m.firstElementChild as HTMLElement).dataset.testid === 'analysis-head')).toBe(true);
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(tag).toBeFocused(); // focus returns to the opener (issue #52)

  await page.getByTestId('nav-timeline').click();
  const analysed = page.locator('[data-testid="minute"].analysed').last();
  await expect(analysed).toBeVisible({ timeout: 15000 });
  await expect(analysed.getByTestId('minute-count')).toContainText('×'); // person + its motion event, on the analysed minute
  await analysed.click();
  await page.getByTestId('minute-analysis-link').first().click();
  await expect(page.getByTestId('analysis-modal')).toBeVisible();
});

// Issue #56: an answer with no person, vehicle or pet.
test('an answer with nothing relevant: the tag and the modal say so; show all lists the object', async ({ page }) => {
  await signIn(page);
  expect((await setScript(page, [{ objects: [FAN, LAMP] }])).ok()).toBe(true);
  await personEventsClosed(page);
  const before = await calls(page);
  expect((await person(page)).status()).toBe(201);
  await expect.poll(() => calls(page), { timeout: 20000 }).toBe(before + 1);
  await page.getByTestId('nav-events').click();
  const tag = page.getByTestId('analysis-tag').first();
  await expect(tag).toContainText('✦ Vision: nothing relevant', { timeout: 15000 });
  await tag.click();
  const modal = page.getByTestId('analysis-modal');
  await expect(modal).toContainText('Nothing relevant.');
  await expect(modal.getByTestId('analysis-boxes').locator('rect')).toHaveCount(0);
  await modal.getByTestId('analysis-show-all').check();
  await expect(modal.getByTestId('analysis-boxes').locator('rect')).toHaveCount(1);
  await expect(modal).not.toContainText('Nothing relevant.');
  // An object without a box can be selected: nothing is drawn, the row says so.
  const lamp = modal.getByTestId('analysis-object').filter({ hasText: 'lamp' });
  await expect(lamp).toContainText('no box');
  await lamp.click();
  await expect(lamp).toHaveAttribute('aria-pressed', 'true');
  await expect(modal.getByTestId('analysis-boxes').locator('rect')).toHaveCount(0);
  await lamp.click();
  await expect(modal.getByTestId('analysis-boxes').locator('rect')).toHaveCount(1);
  // Esc closes it with the focus elsewhere (the page behind), too.
  await page.locator('body').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
});

test.afterAll(async ({ request }) => {
  await request.post(`http://127.0.0.1:${VISION_MOCK_PORT}/script`, { data: [] });
  // Leave analytics off for the other specs.
  await request.put('/control/config', { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }, data: reset });
});
