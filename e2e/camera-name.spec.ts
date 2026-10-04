import { test, expect } from '@playwright/test';
import { ADMIN_TOKEN, DEVNAME_SHIM_PORT, PROXY_PORT } from './env';

// Camera name design: the Status card shows the camera's own name; the
// Settings field "Camera name (stored on the camera)" validates as you type
// and saves through PUT /control/camera/name. The camera is cam-sim behind
// the GetDevName/SetDevName shim (start.ts).
const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const base = `http://127.0.0.1:${PROXY_PORT}`;
const shim = `http://127.0.0.1:${DEVNAME_SHIM_PORT}`;

test.afterAll(async ({ playwright }) => {
  // Back to cam-sim's own name for the other specs.
  const request = await playwright.request.newContext();
  await request.put(`${base}/control/camera/name`, { headers: admin, data: { name: 'Cam' } });
  await request.dispose();
});

test("the Status card shows the camera's name, and follows a rename made elsewhere", async ({ page, request }) => {
  await page.goto('/#/status');
  await expect(page.getByTestId('camera-name')).toHaveText('Cam', { timeout: 15000 });
  // Renamed in the Reolink app: the next poll reads it, the stream message refreshes the card.
  expect((await request.post(`${shim}/__shim/rename`, { data: { name: 'Backyard Left' } })).status()).toBe(204);
  expect((await request.post(`${base}/control/actions/camera-test`, { headers: admin })).status()).toBe(200);
  await expect(page.getByTestId('camera-name')).toHaveText('Backyard Left', { timeout: 15000 });
});

test('the Settings field validates as you type and saves on the camera', async ({ page }) => {
  await page.goto('/#/settings');
  const row = page.getByTestId('setting-camera-name');
  await expect(row).toContainText('Camera name (stored on the camera)');
  const input = page.getByTestId('input-camera-name');
  await expect(input).toHaveValue('Backyard Left', { timeout: 15000 });

  await input.fill('Back_yard');
  await expect(page.getByTestId('camera-name-problem')).toHaveText('not allowed: _');
  await expect(page.getByTestId('save-camera-name')).toBeDisabled();
  await input.fill('Back yard ');
  await expect(page.getByTestId('camera-name-problem')).toHaveText('no leading or trailing space');
  await input.fill('x'.repeat(32));
  await expect(page.getByTestId('camera-name-problem')).toHaveText('too long: 32 characters, at most 31');

  await input.fill('Front Door (1)');
  await expect(page.getByTestId('camera-name-problem')).toHaveCount(0);
  await page.getByTestId('save-camera-name').click();
  await expect(page.getByTestId('settings-message')).toHaveText('Camera name saved on the camera: Front Door (1)');
  await expect(input).toHaveValue('Front Door (1)');
  await page.goto('/#/status');
  await expect(page.getByTestId('camera-name')).toHaveText('Front Door (1)', { timeout: 15000 });
});

test("a camera refusal shows the 400's reason under the field", async ({ page, request }) => {
  await page.goto('/#/settings');
  const input = page.getByTestId('input-camera-name');
  await expect(input).toHaveValue('Front Door (1)', { timeout: 15000 });
  expect((await request.post(`${shim}/__shim/refuse-next`, { data: { rspCode: -54 } })).status()).toBe(204);
  await input.fill('Garage');
  await page.getByTestId('save-camera-name').click();
  await expect(page.getByTestId('camera-name-error')).toHaveText('Not saved: not allowed by the camera (rspCode -54)');
  // The camera kept its name.
  const st = (await (await request.get(`${base}/control/status`, { headers: admin })).json()) as { camera: { name: string } };
  expect(st.camera.name).toBe('Front Door (1)');
});
