import { test, expect, type Page } from '@playwright/test';
import { ADMIN_TOKEN, SIM, SIM_CONTROL_TOKEN } from './env';

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByTestId('token-input').fill(ADMIN_TOKEN);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('shell')).toBeVisible();
}

test('the camera uploads a clip after setup; it plays on the Clips page', async ({ page, request }) => {
  await signIn(page);
  await expect(page.getByTestId('ftp-state')).toContainText('listening on', { timeout: 15000 });
  await page.getByTestId('nav-maintenance').click();
  await page.getByTestId('action-ftp-setup').click();
  await expect(page.getByTestId('action-result')).toContainText('Camera FTP setup: {"ftp"');
  await page.getByTestId('action-ftp-test').click();
  await expect(page.getByTestId('action-result')).toContainText('"ok":true');

  await page.getByTestId('nav-clips').click();
  const r = await request.post(`http://127.0.0.1:${SIM.control}/sim/api/events`, { headers: { Authorization: `Bearer ${SIM_CONTROL_TOKEN}` }, data: { type: 'person', durationS: 1 } });
  expect(r.status()).toBe(201);
  const clip = page.getByTestId('clip').first();
  await expect(clip).toBeVisible({ timeout: 30000 });
  await expect(clip).toContainText('person');
  await clip.click();
  const video = page.getByTestId('clip-player');
  await expect(video).toBeVisible();
  // The browser reads the clip's metadata through the API (Range requests).
  await expect.poll(async () => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15000 }).toBeGreaterThanOrEqual(1);

  await page.getByTestId('nav-maintenance').click();
  await page.getByTestId('action-ftp-off').click();
  await expect(page.getByTestId('action-result')).toContainText('"enable":0');
});
