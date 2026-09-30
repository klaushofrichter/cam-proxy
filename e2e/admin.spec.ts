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

test('serves the favicon as SVG', async ({ request }) => {
  const r = await request.get('/favicon.svg');
  expect(r.status()).toBe(200);
  expect(r.headers()['content-type']).toMatch(/image\/svg\+xml/);
  expect(await r.text()).toContain('<svg');
});

test('the camera model links to the camera’s own web page', async ({ page }) => {
  await signIn(page);
  const link = page.getByTestId('camera-model');
  await expect(link).toHaveText('RLC-1224A', { timeout: 15000 });
  // e2e's camera is 127.0.0.1:<port>: https://<host without port>/.
  await expect(link).toHaveAttribute('href', 'https://127.0.0.1/');
  await expect(link).toHaveAttribute('target', '_blank');
});

test('the top bar Refresh reloads the open page and says when', async ({ page }) => {
  await signIn(page);
  await page.getByTestId('nav-maintenance').click();
  await expect(page.getByTestId('updated')).toBeVisible();
  const reloads: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname === '/control/status' || u.pathname === '/control/log') reloads.push(u.pathname);
  });
  await page.getByTestId('refresh').click();
  await expect.poll(() => reloads.includes('/control/log') && reloads.includes('/control/status')).toBe(true);
  await expect(page.getByTestId('updated')).toContainText(/just now|\d+ s ago/);
});

test('the title links to the repository', async ({ page }) => {
  await signIn(page);
  const brand = page.getByTestId('brand');
  await expect(brand).toHaveAttribute('href', 'https://github.com/klaushofrichter/cam-proxy');
  await expect(brand).toHaveAttribute('target', '_blank');
});

test('typing in the analytics limits survives a refresh and a save of the other field', async ({ page }) => {
  await signIn(page);
  await page.getByTestId('nav-settings').click();
  const monthly = page.getByTestId('analytics-monthly');
  const daily = page.getByTestId('analytics-daily');
  await expect(monthly).toBeVisible();
  await monthly.fill('1234');
  await page.getByTestId('refresh').click();
  await page.waitForTimeout(800);
  await expect(monthly).toHaveValue('1234');
  await daily.fill('7');
  await page.getByTestId('analytics-daily-save').click();
  await expect(page.getByTestId('analytics-message')).toContainText('Daily cap saved');
  await expect(monthly).toHaveValue('1234');
  await monthly.fill('');
  await expect(page.getByTestId('analytics-monthly-save')).toBeDisabled();
  await expect(page.getByTestId('analytics-monthly-hint')).toContainText('whole number from 0 to 100,000');
  await daily.fill('0');
  await page.getByTestId('analytics-daily-save').click();
  await expect(page.getByTestId('analytics-message')).toContainText('Daily cap saved');
});
