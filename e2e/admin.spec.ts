import { test, expect, type Page } from '@playwright/test';
import { ADMIN_TOKEN, SIM, SIM_CONTROL_TOKEN } from './env';

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByTestId('token-input').fill(ADMIN_TOKEN);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('shell')).toBeVisible();
}

test('a wrong token is refused; the admin token signs in', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('token-input').fill('wrong-token');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toBeVisible();
  await page.getByTestId('token-input').fill(ADMIN_TOKEN);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('shell')).toBeVisible();
});

test('status shows the camera online and ONVIF subscribed', async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId('camera-online')).toHaveText('camera online', { timeout: 15000 });
  await expect(page.getByTestId('onvif-state')).toHaveText('subscribed', { timeout: 15000 });
});

test('a camera detection shows up in the live event log', async ({ page, request }) => {
  await signIn(page);
  await page.getByTestId('nav-events').click();
  await expect(page.getByTestId('feed')).toBeVisible();
  await page.waitForTimeout(500);
  const r = await request.post(`http://127.0.0.1:${SIM.control}/sim/api/events`, { headers: { Authorization: `Bearer ${SIM_CONTROL_TOKEN}` }, data: { type: 'vehicle', durationS: 1 } });
  expect(r.status()).toBe(201);
  await expect(page.getByTestId('feed')).toContainText('vehicle start (onvif)', { timeout: 15000 });
  await expect(page.getByTestId('events')).toContainText('vehicle', { timeout: 15000 });
});

test('a setting changed in the UI becomes an override, and can be reset', async ({ page }) => {
  await signIn(page);
  await page.getByTestId('nav-settings').click();
  const input = page.getByTestId('input-sse.pingS');
  await input.fill('12');
  await page.getByTestId('save-sse.pingS').click();
  await expect(page.getByTestId('source-sse.pingS')).toHaveText('override');
  await page.getByTestId('reset-sse.pingS').click();
  await expect(page.getByTestId('source-sse.pingS')).toHaveText('default');
});

test('the token is kept nowhere in the browser', async ({ page }) => {
  await signIn(page);
  await page.reload();
  await expect(page.getByTestId('shell')).toBeVisible();
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);
  expect(stored).not.toContain(ADMIN_TOKEN);
  await page.getByTestId('logout').click();
  await expect(page.getByTestId('token-input')).toBeVisible();
});
