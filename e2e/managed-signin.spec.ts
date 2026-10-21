import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { ADMIN_TOKEN, MANAGED_ADMIN_TOKEN } from './env';

// Issue #227: a sign-in through a cams-admin one-time link (managed-admin)
// sees the local-admin controls off with the reason; the proxy's allow-list
// (ui.config, set by the local admin) turns the Settings page on; a refusal
// that still happens shows at the control.
const LOCKED = 'Needs the local admin token: you signed in from cams-admin.';
const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const allow = (request: APIRequestContext, list: string[]) => request.put('/control/admin/commands', { headers: admin, data: { allow: list } });

// A fresh browser (no stored local session) signed in with a link the managed admin token minted.
async function managedPage(browser: Browser, request: APIRequestContext): Promise<Page> {
  const r = await request.post('/control/login-links', { headers: { Authorization: `Bearer ${MANAGED_ADMIN_TOKEN}` } });
  expect(r.status()).toBe(201);
  const { code } = (await r.json()) as { code: string };
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto(`/control/login-link?code=${code}`);
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 15000 });
  return page;
}

test.afterEach(async ({ request }) => {
  // Other specs share this proxy: nothing stays allowed, sse.pingS back to before.
  expect((await allow(request, [])).status()).toBe(200);
  await request.delete('/control/config/sse.pingS', { headers: admin });
  await request.delete('/control/config/ntp.server', { headers: admin });
});

test('a cams-admin sign-in: settings, restarts and actions are off, with the reason', async ({ browser, request }) => {
  const page = await managedPage(browser, request);
  await page.goto('/#/settings');
  await expect(page.getByTestId('settings-locked')).toHaveText(LOCKED, { timeout: 15000 });
  await expect(page.getByTestId('input-sse.pingS')).toBeDisabled();
  // Renaming the camera stays open to it.
  await expect(page.getByTestId('input-camera-name')).toBeEnabled();
  await page.goto('/#/maintenance');
  await expect(page.getByTestId('maintenance-locked')).toHaveText(LOCKED);
  await expect(page.getByTestId('action-restart-proxy')).toBeDisabled();
  await expect(page.getByTestId('action-camera-test')).toBeDisabled();
  await page.context().close();
});

test('ui.config unlocks the Settings page except addresses; a refusal shows at the row', async ({ browser, request }) => {
  expect((await allow(request, ['ui.config'])).status()).toBe(200);
  const page = await managedPage(browser, request);
  await page.goto('/#/settings');
  await expect(page.getByTestId('settings-locked')).toHaveText(/Addresses, ports, files, trust and users need the local admin token/, { timeout: 15000 });
  await expect(page.getByTestId('input-ftp.publicHost')).toBeDisabled();
  const input = page.getByTestId('input-sse.pingS');
  await expect(input).toBeEnabled();
  await input.fill('17');
  await page.getByTestId('save-sse.pingS').click();
  await expect(page.getByTestId('settings-message')).toContainText('sse.pingS saved');
  // The local admin's override of a protected setting: no row Reset, and Reset to defaults keeps it and says so.
  expect((await request.put('/control/config', { headers: admin, data: { ntp: { server: 'ntp.example' } } })).status()).toBe(200);
  await page.reload();
  await expect(page.getByTestId('reset-ntp.server')).toBeDisabled({ timeout: 15000 });
  await page.getByTestId('reset-all').click();
  await expect(page.getByTestId('confirm-dialog')).toContainText('These stay as they are (only the local admin token resets them): ntp.server.');
  await page.getByTestId('confirm-cancel').click();
  // The local admin takes it back; the page still shows the control, and the refusal appears at the row.
  expect((await allow(request, [])).status()).toBe(200);
  await input.fill('18');
  await page.getByTestId('save-sse.pingS').click();
  await expect(page.getByTestId('error-sse.pingS')).toHaveText('Not saved: Refused: this needs the local admin token (you signed in from cams-admin). Nothing was changed.');
  await page.context().close();
});
