import { expect, test } from '@playwright/test';

test('the picker lists the three cameras and switches the Status cards', async ({ page }) => {
  await page.goto('/');
  const picker = page.getByTestId('camera-picker');
  await expect(picker.locator('option')).toHaveCount(3);
  await expect(page.getByTestId('camera-name')).toHaveText('Driveway', { timeout: 15_000 });
  await picker.selectOption('cam4');
  await expect(page.getByTestId('camera-name')).toHaveText('Gate');
  await page.reload();
  await expect(page.getByTestId('camera-picker')).toHaveValue('cam4');
  await expect(page.getByTestId('camera-name')).toHaveText('Gate');
});

test('per-camera settings and actions follow the picker', async ({ page }) => {
  await page.goto('/#/settings');
  await page.getByTestId('camera-picker').selectOption('cam4');
  await expect(page.getByTestId('input-cameras.cam4.statusPollS')).toBeVisible();
  await expect(page.getByTestId('input-cameras.cam3.statusPollS')).toHaveCount(0);
  await page.goto('/#/maintenance');
  const resp = page.waitForResponse((r) => r.url().includes('/control/cameras/cam4/actions/camera-test'));
  await page.getByTestId('action-camera-test').click();
  expect((await resp).status()).toBe(200);
});

test('Status: storage per camera', async ({ page }) => {
  await page.goto('/#/status');
  await expect(page.getByTestId('storage-camera-cam3')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('storage-camera-cam5')).toBeVisible();
});

test('a camera added in the Settings page starts, and can be removed again', async ({ page, request }) => {
  await page.goto('/#/settings');
  await page.getByTestId('add-camera-id').fill('cam9');
  await page.getByTestId('add-camera-host').fill('127.0.0.1:9');
  await page.getByTestId('add-camera-protocol').selectOption('http');
  await page.getByTestId('add-camera-save').click();
  await expect(page.getByTestId('add-camera-message')).toHaveText('Camera cam9 added; it starts now');
  await expect(page.getByTestId('camera-picker').locator('option')).toHaveCount(4, { timeout: 15_000 });
  await page.getByTestId('camera-picker').selectOption('cam9');
  await page.getByTestId('remove-camera').click();
  await page.getByRole('button', { name: 'Remove camera' }).last().click();
  await expect(page.getByTestId('settings-message')).toContainText('Camera cam9 removed');
  await expect(page.getByTestId('camera-picker').locator('option')).toHaveCount(3, { timeout: 15_000 });
  void request;
});

test('the Certificates card: the CA fingerprint and its download', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByTestId('card-certificates')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('ca-fingerprint')).toContainText('SHA256:');
  const ca = await request.get('/tls/ca.pem');
  expect(ca.status()).toBe(200);
  expect(await ca.text()).toContain('BEGIN CERTIFICATE');
  await expect(page.getByTestId('cert-row-cam3')).toContainText('HTTP: no certificate');
  await expect(page.getByTestId('cert-push-cam3')).toBeDisabled();
});
