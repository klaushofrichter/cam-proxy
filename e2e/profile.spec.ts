import { test, expect } from '@playwright/test';
import { ADMIN_TOKEN, PROXY_PORT } from './env';

// The proxy profile (cams-admin spec 2026-10-25-proxy-profile-design §0): the
// Status page asks for it until it is set; the Settings page edits it.
const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const base = `http://127.0.0.1:${PROXY_PORT}`;

test.afterAll(async ({ request }) => {
  // Back to unset for the other specs.
  for (const p of ['profile.cameras', 'profile.name']) await request.delete(`${base}/control/config/${p}`, { headers: admin });
});

test("the Status page asks for the profile until it is set; Settings edits it", async ({ page, request }) => {
  await page.goto('/#/status');
  const card = page.getByTestId('card-profile-home');
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.locator('h3')).toHaveText("Set this proxy's profile");
  await expect(page.getByTestId('profile-cameras')).toHaveValue('1');
  await page.getByTestId('profile-cameras').fill('0');
  await expect(page.getByTestId('profile-problem')).toBeVisible();
  // 1: the e2e proxy's FTP has 10 passive ports set by hand (2 would warn, profile_ftp_ports).
  await page.getByTestId('profile-cameras').fill('1');
  await page.getByTestId('profile-name').fill('Test box');
  await page.getByTestId('profile-save').click();
  await expect(card).toHaveCount(0);
  const r = await request.get(`${base}/control/profile`, { headers: admin });
  expect(await r.json()).toMatchObject({ set: true, cameras: 1, name: 'Test box', warnings: [] });

  await page.goto('/#/settings');
  const s = page.getByTestId('settings-card-profile');
  await expect(s).toBeVisible();
  await expect(s.locator('h3')).toHaveText('Profile · Test box');
  await expect(page.getByTestId('profile-cameras')).toHaveValue('1');
  // One profile card: the generic settings list leaves profile.* to it.
  await expect(s).toHaveCount(1);
  await expect(s.getByTestId('profile-cameras')).toBeEnabled();
});
