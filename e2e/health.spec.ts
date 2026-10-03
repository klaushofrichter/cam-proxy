import { test, expect } from '@playwright/test';
import { ADMIN_TOKEN, PROXY_PORT } from './env';

// Spec 2026-10-03-health-summary-design A3/A4: the Health card first on the
// Status page, the Pi card (start.ts reads the Pi fixture), and the same red
// marks as GET /api/local/health.
const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const base = `http://127.0.0.1:${PROXY_PORT}`;

test('the Health and Pi cards; a threshold turns the CPU temperature red in both, and back', async ({ page, request }) => {
  await page.goto('/#/status');
  const card = page.getByTestId('card-health');
  await expect(card).toBeVisible({ timeout: 15000 });
  // First in the grid.
  await expect(page.locator('.grid > .card').first()).toHaveAttribute('data-testid', 'card-health');
  for (const id of ['camera', 'stream', 'events', 'ftp', 'storage', 'disk', 'cpuTemp', 'underVoltage', 'inventory', 'version']) await expect(page.getByTestId(`health-item-${id}`)).toBeVisible();
  await expect(page.getByTestId('health-item-cpuTemp')).toContainText('53.6 °C');
  await expect(page.getByTestId('health-item-cpuTemp')).toHaveAttribute('data-problem', 'false');

  const pi = page.getByTestId('card-pi');
  await expect(pi.locator('h3')).toHaveText('Pi');
  await expect(page.getByTestId('pi-model')).toHaveText('Raspberry Pi 4 Model B Rev 1.5');
  await expect(page.getByTestId('pi-temp')).toHaveText('53.6 °C');
  await expect(page.getByTestId('pi-temp')).not.toHaveClass(/bad/);
  await expect(page.getByTestId('pi-voltage')).toHaveText('no');
  await expect(page.getByTestId('storage-disk')).toContainText('%');

  // The local API answers this (loopback) caller without a key: the same summary.
  const local = await request.get(`${base}/api/local/health`);
  expect(local.status()).toBe(200);
  expect(((await local.json()) as { schema: number }).schema).toBe(1);

  // 50 °C: the fixture's 53.6 °C is a problem now, in both cards and the API.
  expect((await request.put(`${base}/control/config`, { headers: admin, data: { health: { tempC: 50 } } })).status()).toBe(200);
  try {
    await expect(page.getByTestId('health-item-cpuTemp')).toHaveAttribute('data-problem', 'true', { timeout: 15000 });
    await expect(page.getByTestId('health-item-cpuTemp').locator('dd')).toHaveClass(/bad/);
    await expect(page.getByTestId('pi-temp')).toHaveClass(/bad/);
    const after = (await (await request.get(`${base}/api/local/health`)).json()) as { items: { id: string; problem: boolean }[] };
    expect(after.items.find((i) => i.id === 'cpuTemp')?.problem).toBe(true);
    // At least this one problem (other specs may leave others, such as an FTP stall).
    await expect(page.getByTestId('health-headline')).toHaveText(/^\d+ problems?$/);
    await expect(page.getByTestId('health-headline')).toHaveClass(/bad/);
  } finally {
    await request.delete(`${base}/control/config/health.tempC`, { headers: admin });
  }
  await expect(page.getByTestId('pi-temp')).not.toHaveClass(/bad/, { timeout: 15000 });
  await expect(page.getByTestId('health-item-cpuTemp')).toHaveAttribute('data-problem', 'false');
});

test('the Storage card: Disk used red from health.diskPercent', async ({ page, request }) => {
  await page.goto('/#/status');
  await expect(page.getByTestId('storage-disk')).toBeVisible({ timeout: 15000 });
  const h = (await (await request.get(`${base}/api/local/health`)).json()) as { disk: { usedPercent: number } };
  test.skip(h.disk.usedPercent < 50, 'the test disk is under the lowest threshold (50 %)');
  expect((await request.put(`${base}/control/config`, { headers: admin, data: { health: { diskPercent: 50 } } })).status()).toBe(200);
  try {
    await expect(page.getByTestId('storage-disk')).toHaveClass(/bad/, { timeout: 15000 });
    await expect(page.getByTestId('health-item-disk')).toHaveAttribute('data-problem', 'true');
  } finally {
    await request.delete(`${base}/control/config/health.diskPercent`, { headers: admin });
  }
  await expect(page.getByTestId('storage-disk')).not.toHaveClass(/bad/, { timeout: 15000 });
});
