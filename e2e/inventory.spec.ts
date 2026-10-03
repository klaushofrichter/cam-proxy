import { test, expect } from '@playwright/test';
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

// The clips compare (#74): cam-sim's demo recordings of yesterday were never
// uploaded, so they are missing here and the box offers to fetch them. The
// fetch itself is not clicked here (the API test covers it), so the Status
// page's Recordings card still shows no download.
test('Compare clips with the camera: the result and the repair offer show', async ({ page }) => {
  await page.goto('/#/maintenance');
  await expect(page.getByTestId('inventory-clips-camera')).toBeEnabled();
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/control/actions/inventory') && r.request().method() === 'POST'),
    page.getByTestId('inventory-clips-camera').click(),
  ]);
  expect(resp.status()).toBe(202);
  await expect(page.getByTestId('inventory-clips-result')).toContainText('Clips inventory', { timeout: 30_000 });
  await expect(page.getByTestId('inventory-clips-result')).toContainText('Camera (sub):');
  await expect(page.getByTestId('inventory-repair')).toHaveText(/^Fetch \d+ lost clips \(\d+\.\d MB\)$/);
  // The offer asks first, with the numbers; Cancel sends nothing.
  await page.getByTestId('inventory-repair').click();
  await expect(page.getByTestId('confirm-message')).toContainText(/Fetch \d+ lost clips \(\d+\.\d MB\)/);
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await expect(page.getByTestId('inventory-repair-result')).toHaveCount(0);
});

// The events check (#75): cam-sim's demo recordings of yesterday have no
// events here, so the box offers to add them. The offer is not confirmed:
// added events would change the Events page and the Timeline for the specs
// after this one (the API test covers the repair).
test('Check events: the result and the offer to add missing events show', async ({ page }) => {
  await page.goto('/#/maintenance');
  await expect(page.getByTestId('inventory-events')).toBeEnabled();
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/control/actions/inventory') && r.request().method() === 'POST'),
    page.getByTestId('inventory-events').click(),
  ]);
  expect(resp.status()).toBe(202);
  await expect(page.getByTestId('inventory-events-result')).toContainText('Events inventory', { timeout: 30_000 });
  await expect(page.getByTestId('inventory-events-result')).toContainText('Camera (sub):');
  await expect(page.getByTestId('inventory-recover')).toHaveText(/^Add \d+ missing events$/);
  // The offer asks first, with the count; Cancel sends nothing.
  await page.getByTestId('inventory-recover').click();
  await expect(page.getByTestId('confirm-message')).toContainText(/Add \d+ missing events from the camera's SD recordings/);
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await expect(page.getByTestId('inventory-recover-result')).toHaveCount(0);
});
