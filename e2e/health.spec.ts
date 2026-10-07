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

// Issue #199: the camera's SD card. cam-sim's profile has overwrite 0, as the
// real camera had: an amber warning, the same in the Health card, the Camera
// card's SD card line and GET /api/local/health.
test('the SD card: the Health item and the Camera card line, with the overwrite warning', async ({ page, request }) => {
  await page.goto('/#/status');
  await expect(page.getByTestId('health-item-sd')).toBeVisible({ timeout: 15000 });
  const h = (await (await request.get(`${base}/api/local/health`)).json()) as { camera: { sd: { overwrite: boolean | null } | null }; items: { id: string; text: string; problem: boolean; warning?: boolean }[] };
  const item = h.items.find((i) => i.id === 'sd')!;
  expect(h.camera.sd).not.toBeNull();
  await expect(page.getByTestId('health-item-sd').locator('dd')).toHaveText(item.text);
  await expect(page.getByTestId('camera-sd')).toContainText('GB free');
  if (h.camera.sd!.overwrite === false) {
    expect(item).toMatchObject({ text: 'Overwrite is off: the camera stops recording to its SD card when it is full', problem: false, warning: true });
    await expect(page.getByTestId('health-item-sd')).toHaveAttribute('data-warning', 'true');
    await expect(page.getByTestId('camera-sd')).toHaveClass(/warn/);
    await expect(page.getByTestId('camera-sd')).toContainText('overwrite off');
  }
});
