import { test, expect, type Page, type Route } from '@playwright/test';
import { ADMIN_TOKEN, PROXY_PORT } from './env';

// The stills inventory (#72) from the Maintenance page's Inventory box.
test('Check stills: the result shows, and the audit log has the run', async ({ page, request }) => {
  await page.goto('/#/maintenance');
  await expect(page.getByTestId('inventory-stills')).toBeEnabled();
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/control/actions/inventory') && r.request().method() === 'POST'),
    page.getByTestId('inventory-stills').click(),
  ]);
  expect(resp.status()).toBe(202);
  const { runId } = (await resp.json()) as { runId: string };
  await expect(page.getByTestId('inventory-result')).toContainText('Stills inventory', { timeout: 30_000 });
  await expect(page.getByTestId('inventory-stills')).toBeEnabled();
  await expect
    .poll(async () => {
      const r = await request.get(`http://127.0.0.1:${PROXY_PORT}/control/audit?action=inventory&limit=20`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
      const recs = (await r.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { cam_proxy?: Record<string, unknown> });
      return recs.find((x) => x.cam_proxy?.runId === runId)?.cam_proxy ?? null;
    }, { timeout: 10_000 })
    .toMatchObject({ kind: 'stills', outcome: 'ok', requestedBy: 'session' });
});

// "Search for and retrieve missing clips" (#74): cam-sim's demo recordings
// of yesterday were never uploaded, so they are missing here; when the
// compare ends, the confirm opens by itself. Cancel leaves the follow-up
// button, which asks again. Nothing is fetched here (the API test covers
// it), so the Status page's Recordings card still shows no download.
const startRun = async (page: Page, testId: string) => {
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/control/actions/inventory') && r.request().method() === 'POST'),
    page.getByTestId(testId).click(),
  ]);
  expect(resp.status()).toBe(202);
  return ((await resp.json()) as { runId: string }).runId;
};

test('Search for and retrieve missing clips: the confirm opens by itself; Cancel leaves the follow-up button', async ({ page }) => {
  await page.goto('/#/maintenance');
  await expect(page.getByTestId('inventory-clips-camera')).toHaveText('Search for and retrieve missing clips');
  await expect(page.getByTestId('inventory-clips-camera')).toBeEnabled();
  const runId = await startRun(page, 'inventory-clips-camera');
  await expect(page.getByTestId('confirm-dialog')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('confirm-message')).toContainText(/^Retrieve \d+ clips \(\d+\.\d MB\) from the camera\?/);
  await expect(page.getByTestId('inventory-clips-result')).toHaveAttribute('data-run', runId);
  await expect(page.getByTestId('inventory-clips-result')).toContainText('Camera (sub):');
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await expect(page.getByTestId('inventory-repair')).toHaveText(/^Retrieve \d+ missing clips \(\d+\.\d MB\)$/);
  await expect(page.getByTestId('inventory-retrieve-nothing')).toHaveCount(0);
  // The follow-up button asks again; Cancel sends nothing.
  await page.getByTestId('inventory-repair').click();
  await expect(page.getByTestId('confirm-message')).toContainText(/^Retrieve \d+ clips \(\d+\.\d MB\) from the camera\?/);
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await expect(page.getByTestId('inventory-repair-result')).toHaveCount(0);
});

// "Search for and add missing events" (#75): cam-sim's demo recordings of
// yesterday have no events here; the confirm opens by itself when the check
// ends. It is not confirmed: added events would change the Events page and
// the Timeline for the specs after this one (the API test covers the repair).
test('Search for and add missing events: the confirm opens by itself; Cancel leaves the follow-up button', async ({ page }) => {
  await page.goto('/#/maintenance');
  await expect(page.getByTestId('inventory-events')).toHaveText('Search for and add missing events');
  await expect(page.getByTestId('inventory-events')).toBeEnabled();
  const runId = await startRun(page, 'inventory-events');
  await expect(page.getByTestId('confirm-dialog')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('confirm-message')).toContainText(/Add \d+ missing events \([a-z]+ \d+(, [a-z]+ \d+)*\) from the camera's SD recordings/);
  await expect(page.getByTestId('confirm-message')).toContainText('recovered');
  await expect(page.getByTestId('inventory-events-result')).toHaveAttribute('data-run', runId);
  await expect(page.getByTestId('inventory-events-result')).toContainText('Camera (sub):');
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await expect(page.getByTestId('inventory-recover')).toHaveText(/^Add \d+ missing events$/);
  await page.getByTestId('inventory-recover').click();
  await expect(page.getByTestId('confirm-message')).toContainText(/Add \d+ missing events/);
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await expect(page.getByTestId('inventory-recover-result')).toHaveCount(0);
});

// Only a click of this page asks: not the reports loaded on page open, not a
// run started elsewhere (another tab, the API).
test('The search confirm does not open for a report loaded on page open or a run started through the API', async ({ page, request }) => {
  await page.goto('/#/maintenance');
  // The previous specs left a fresh, unused compare and events check.
  await expect(page.getByTestId('inventory-repair')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('inventory-recover')).toBeVisible();
  const r = await request.post(`http://127.0.0.1:${PROXY_PORT}/control/actions/inventory`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }, data: { kind: 'clips', camera: true } });
  expect(r.status()).toBe(202);
  const { runId } = (await r.json()) as { runId: string };
  await expect(page.getByTestId('inventory-clips-result')).toHaveAttribute('data-run', runId, { timeout: 30_000 });
  await expect(page.getByTestId('inventory-repair')).toBeVisible();
  // The report is in; give an ask a moment to show (it must not).
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
});

// Nothing missing: a clear line, no dialog. cam-sim always has the missing
// demo recordings, so the run's report is answered with none missing.
test('A search with nothing missing says so and asks nothing', async ({ page }) => {
  const none = (field: string) => async (route: Route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { counts: Record<string, number>; items: unknown[] };
    body.counts[field] = 0;
    body.items = [];
    await route.fulfill({ response: res, json: body });
  };
  await page.route('**/control/inventory/runs/clips-*', none('missingLocally'));
  await page.route('**/control/inventory/runs/events-*', none('missingEvents'));
  await page.goto('/#/maintenance');
  await expect(page.getByTestId('inventory-clips-camera')).toBeEnabled();
  const clipsRun = await startRun(page, 'inventory-clips-camera');
  await expect(page.getByTestId('inventory-clips-result')).toHaveAttribute('data-run', clipsRun, { timeout: 30_000 });
  await expect(page.getByTestId('inventory-retrieve-nothing')).toHaveText(/^Nothing to retrieve: all the (camera's|listed) recordings are here\.$/);
  await expect(page.getByTestId('inventory-repair')).toHaveCount(0);
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await expect(page.getByTestId('inventory-events')).toBeEnabled();
  const eventsRun = await startRun(page, 'inventory-events');
  await expect(page.getByTestId('inventory-events-result')).toHaveAttribute('data-run', eventsRun, { timeout: 30_000 });
  await expect(page.getByTestId('inventory-add-nothing')).toHaveText('Nothing to add.');
  await expect(page.getByTestId('inventory-recover')).toHaveCount(0);
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
});

// A run started elsewhere (another tab, or the API) shows without a reload:
// the box polls while idle too (#106).
test('A stills run started through the API shows in an open page', async ({ page, request }) => {
  await page.goto('/#/maintenance');
  await expect(page.getByTestId('inventory-stills')).toBeEnabled();
  const r = await request.post(`http://127.0.0.1:${PROXY_PORT}/control/actions/inventory`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }, data: { kind: 'stills' } });
  expect(r.status()).toBe(202);
  const { runId } = (await r.json()) as { runId: string };
  await expect(page.getByTestId('inventory-result')).toHaveAttribute('data-run', runId, { timeout: 30_000 });
});
