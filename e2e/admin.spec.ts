import { test, expect, type Page } from '@playwright/test';
import { ADMIN_TOKEN, SIM, SIM_CONTROL_TOKEN } from './env';

// The two tests that exercise the sign-in form run without the saved session.
const NO_SESSION = { cookies: [], origins: [] };
async function signIn(page: Page) {
  await page.goto('/'); // signed in by the storageState from auth.setup.ts
  await expect(page.getByTestId('shell')).toBeVisible();
}

test.describe('sign-in form', () => {
test.use({ storageState: NO_SESSION });

test('a wrong token is refused; the admin token signs in', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('token-input').fill('wrong-token');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toBeVisible();
  await page.getByTestId('token-input').fill(ADMIN_TOKEN);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('shell')).toBeVisible();
});
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
  // Reset says what it goes back to (Klaus 2026-10-05).
  await expect(page.getByTestId('reset-sse.pingS')).toHaveText('Reset – 15 s');
  await page.getByTestId('reset-sse.pingS').click();
  await expect(page.getByTestId('source-sse.pingS')).toHaveText('default');
  await expect(page.getByTestId('reset-sse.pingS')).toHaveCount(0);
});

// Klaus 2026-10-05: one button back to the defaults, after a confirmation
// that lists what changes; one request, one audit record.
test('Reset to defaults lists what changes, resets every override and is audited once', async ({ page, request }) => {
  const auth = { Authorization: `Bearer ${ADMIN_TOKEN}` };
  // A clean start: nothing overridden, so no button.
  expect((await request.delete('/control/config', { headers: auth })).ok()).toBe(true);
  await signIn(page);
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('input-sse.pingS')).toBeVisible();
  await expect(page.getByTestId('reset-all')).toHaveCount(0);
  for (const [p, v] of [['retention.auditDays', '30'], ['sse.pingS', '12']] as const) {
    await page.getByTestId(`input-${p}`).fill(v);
    await page.getByTestId(`save-${p}`).click();
    await expect(page.getByTestId(`source-${p}`)).toHaveText('override');
  }
  await expect(page.getByTestId('reset-retention.auditDays')).toHaveText('Reset – 90 days');
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/settings-resets.png`, fullPage: true });
  // Cancel changes nothing.
  await page.getByTestId('reset-all').click();
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('confirm-items')).toContainText('retention.auditDays: 30 days → 90 days');
  await expect(page.getByTestId('confirm-items')).toContainText('sse.pingS: 12 s → 15 s');
  await expect(page.getByTestId('confirm-ok')).toHaveText('Reset 2 settings');
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/settings-reset-dialog.png` });
  await page.getByTestId('confirm-cancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('source-sse.pingS')).toHaveText('override');
  // Confirm: both back, the button gone, one config-change record for both.
  await page.getByTestId('reset-all').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('source-sse.pingS')).toHaveText('default');
  await expect(page.getByTestId('source-retention.auditDays')).toHaveText('default');
  await expect(page.getByTestId('reset-all')).toHaveCount(0);
  await expect(page.getByTestId('settings-message')).toHaveText('2 settings back to their default');
  const rec = JSON.parse((await (await request.get('/control/audit?action=config-change&limit=1', { headers: auth })).text()).trim());
  expect(rec.message).toBe('Settings reset to defaults: retention.auditDays, sse.pingS');
  expect(rec.cam_proxy).toMatchObject({ reset: 'all', changes: [{ key: 'retention.auditDays', from: 30, to: 90 }, { key: 'sse.pingS', from: 12, to: 15 }] });
});

test.describe('token storage', () => {
test.use({ storageState: NO_SESSION });

test('the token is kept nowhere in the browser', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('token-input').fill(ADMIN_TOKEN);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('shell')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('shell')).toBeVisible();
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);
  expect(stored).not.toContain(ADMIN_TOKEN);
  await page.getByTestId('logout').click();
  await expect(page.getByTestId('token-input')).toBeVisible();
});
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

const dailyCap = async (page: Page) =>
  ((await (await page.request.get('/control/config', { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } })).json()) as Record<string, { value: unknown }>)['analytics.googleVision.dailyCap'].value as number;

test('typing in the analytics limits survives a refresh and a save of the other field', async ({ page }) => {
  await signIn(page);
  const original = await dailyCap(page); // restored at the end (issue #52: not assumed to be 0)
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
  await daily.fill(String(original));
  await page.getByTestId('analytics-daily-save').click();
  await expect.poll(() => dailyCap(page)).toBe(original);
});

// Klaus 2026-10-05 (the Pi's PoE rows): a whole-group save keeps only what
// differs; a Reset to none / not set says what that means; an override
// equal to the default (an older proxy's) has no Reset, and Reset to
// defaults lists it as "no change in effect".
test('Reset only where it changes something, and says what none / not set means', async ({ page, request }) => {
  const auth = { Authorization: `Bearer ${ADMIN_TOKEN}` };
  expect((await request.delete('/control/config', { headers: auth })).ok()).toBe(true);
  const put = await request.put('/control/config', { headers: auth, data: { camera: { poeSwitch: { model: 'sscpoe-web', host: '192.0.2.97', port: 8, ports: 8, offSeconds: 15 } } } });
  expect(put.ok()).toBe(true);
  const row = (k: string) => `camera.poeSwitch.${k}`;
  try {
    await signIn(page);
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId(`source-${row('ports')}`)).toHaveText('default');
    await expect(page.getByTestId(`reset-${row('model')}`)).toHaveText('Reset – none (no PoE switch: power-cycle off)');
    await expect(page.getByTestId(`reset-${row('host')}`)).toHaveText('Reset – not set (PoE switch control off: no switch address)');
    await expect(page.getByTestId(`reset-${row('port')}`)).toHaveText('Reset – not set (PoE switch control off: no camera port)');
    await expect(page.getByTestId(`reset-${row('offSeconds')}`)).toHaveText('Reset – 10 s');

    // An older proxy stored ports = 8 (the default) as an override: the answer
    // of GET /control/config says so, as it does for such an overrides.json.
    await page.route('**/control/config', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, Record<string, unknown>>;
      body[row('ports')] = { ...body[row('ports')], source: 'override', resetTo: { value: 8, source: 'default', same: true } };
      await route.fulfill({ response: res, json: body });
    });
    await page.reload();
    await page.getByTestId('nav-settings').click();
    const badge = page.getByTestId(`source-${row('ports')}`);
    await expect(badge).toHaveText('override = default');
    await expect(badge).toHaveAttribute('title', /same as the default \(8\): Reset would change nothing/);
    await expect(page.getByTestId(`reset-${row('ports')}`)).toHaveCount(0);

    const card = page.getByTestId(`setting-${row('model')}`).locator('xpath=ancestor::div[contains(@class, "card")]');
    const shots = process.env.SHOT_DIR ? [['desktop', 1280, 900], ['phone', 390, 844]] as const : [];
    for (const [name, width, height] of shots.length ? shots : [['desktop', 1280, 900] as const]) {
      for (const scheme of shots.length ? (['dark', 'light'] as const) : (['dark'] as const)) {
        await page.setViewportSize({ width, height });
        await page.evaluate((s) => (document.documentElement.dataset.theme = s), scheme);
        if (shots.length) {
          // The PoE rows; on a phone the table scrolls inside its card: to the Reset column.
          const rows = page.getByTestId(`setting-${row('model')}`);
          await rows.scrollIntoViewIfNeeded();
          await card.evaluate((el) => (el.scrollLeft = el.scrollWidth));
          await page.screenshot({ path: `${process.env.SHOT_DIR}/poe-rows-${name}-${scheme}.png` });
        }
        await page.getByTestId('reset-all').click();
        const items = page.getByTestId('confirm-items');
        await expect(items).toContainText('camera.poeSwitch.model: sscpoe-web → none (no PoE switch: power-cycle off)');
        await expect(items).toContainText('camera.poeSwitch.host: 192.0.2.97 → not set (PoE switch control off: no switch address)');
        await expect(items).toContainText('camera.poeSwitch.offSeconds: 15 s → 10 s');
        await expect(items).toContainText('1 override equal to the default is removed too, no change in effect: camera.poeSwitch.ports');
        await expect(page.getByTestId('confirm-ok')).toHaveText('Reset 4 settings');
        if (shots.length) await page.screenshot({ path: `${process.env.SHOT_DIR}/reset-dialog-${name}-${scheme}.png` });
        await page.getByTestId('confirm-cancel').click();
        await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
      }
    }
  } finally {
    await page.unrouteAll();
    await request.delete('/control/config', { headers: auth });
  }
});
