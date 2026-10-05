import { test, expect, type Page } from '@playwright/test';
import { ADMIN_TOKEN, PROXY_PORT } from './env';
import { showActions } from './audit-filter';

const auth = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const resetCfg = { analytics: { googleVision: { dailyCap: 0 } } };

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByTestId('token-input').fill(ADMIN_TOKEN);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('shell')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

async function openAudit(page: Page) {
  await page.goto('/#/audit'); // signed in by the storageState from auth.setup.ts
  await expect(page.getByTestId('audit-table')).toBeVisible();
}

test('a refused sign-in, a sign-in and a sign-out made here appear on the Audit page, newest first', async ({ page, browser }) => {
  // Our own records, made through the form in a context with no saved session.
  // (The proxy throttles repeated anonymous records per IP, so nothing here
  // relies on records other specs may have made.)
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const form = await ctx.newPage();
  await form.goto('/');
  await form.getByTestId('token-input').fill('wrong');
  await form.getByTestId('login-submit').click();
  await expect(form.getByTestId('login-error')).toBeVisible();
  await form.getByTestId('token-input').fill(ADMIN_TOKEN);
  await form.getByTestId('login-submit').click();
  await expect(form.getByTestId('shell')).toBeVisible();
  await form.getByTestId('logout').click();
  await expect(form.getByTestId('token-input')).toBeVisible();
  await ctx.close();

  await openAudit(page);
  const rows = page.getByTestId('audit-row');
  await expect(rows.first()).toHaveAttribute('data-action', 'logout');
  await expect(rows.first()).toContainText('admin');
  await showActions(page, ['login']);
  await expect(rows.first()).toHaveAttribute('data-action', 'login');
  await expect(rows.first()).toContainText('admin');
  await rows.first().click();
  await expect(page.getByTestId('audit-row-json')).toContainText('"method": "token-form"');
  await page.getByTestId('audit-filter-outcome').selectOption('failure');
  await expect(rows.first()).toContainText('refused');
  await rows.first().click();
  await expect(page.getByTestId('audit-row-json')).toContainText('"method": "token-form"');
  await expect(page.getByTestId('audit-row-json')).toContainText('"outcome": "failure"');
});

test('pages older and newer with more than 50 records', async ({ page, request }) => {
  // Each changed value writes one config-change record.
  for (let i = 0; i < 55; i++) {
    const r = await request.put('/control/config', { headers: auth, data: { analytics: { googleVision: { dailyCap: (i % 2) + 1 } } } });
    expect(r.ok()).toBe(true);
  }
  try {
    await openAudit(page);
    await showActions(page, ['config-change']);
    await expect(page.getByTestId('audit-row')).toHaveCount(50);
    await expect(page.getByTestId('audit-older')).toBeEnabled();
    // Rows of one burst can read alike: tell pages apart by the cursor in the opened row's JSON.
    const firstCursor = async () => {
      await page.getByTestId('audit-row').first().click();
      const json = JSON.parse((await page.getByTestId('audit-row-json').textContent())!);
      return json.cam_proxy.cursor as string;
    };
    const newestCursor = await firstCursor();
    await page.getByTestId('audit-older').click();
    await expect(page.getByTestId('audit-newer')).toBeEnabled();
    await expect(page.getByTestId('audit-row-json')).toHaveCount(0);
    expect(await firstCursor()).not.toBe(newestCursor);
    await page.getByTestId('audit-newer').click();
    await expect(page.getByTestId('audit-row')).toHaveCount(50);
    expect(await firstCursor()).toBe(newestCursor);
  } finally {
    const r = await request.put('/control/config', { headers: auth, data: resetCfg });
    expect(r.ok()).toBe(true);
  }
});

test('a slow answer for an old filter does not overwrite the newer one', async ({ page }) => {
  await page.route(/\/control\/audit\?.*action=login(&|$)/, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await openAudit(page);
  await showActions(page, ['login']); // slow
  await showActions(page, ['logout']); // fast
  await expect(page.getByTestId('audit-row').first()).toHaveAttribute('data-action', 'logout');
  await page.waitForTimeout(2000); // the slow login answer has arrived by now
  const actions = await page.getByTestId('audit-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-action')));
  expect(actions.length).toBeGreaterThan(0);
  expect(new Set(actions)).toEqual(new Set(['logout']));
});

test('a restart through the control API is recorded', async ({ page, request }) => {
  const t0 = Date.now();
  await request.post(`http://127.0.0.1:${PROXY_PORT}/control/actions/restart`, { headers: auth });
  await openAudit(page);
  // The camera-side restart is a control-action (restart); proxy-restart is the process restart (#71).
  await showActions(page, ['control-action']);
  await expect(page.getByTestId('audit-row').first()).toHaveAttribute('data-action', 'control-action');
  await expect(page.getByTestId('audit-row').first()).toContainText('restart');
  await expect.poll(async () => (await request.get('/health')).status(), { timeout: 30000 }).toBe(200);
  // The restart answers 202 and runs on (the camera side stops, then starts
  // again), and /health stays up throughout. Wait until the new ONVIF
  // subscription is there, or the next spec's camera event can fall into the
  // gap and be lost (clips.spec).
  await expect
    .poll(async () => {
      const { intake } = (await (await request.get(`http://127.0.0.1:${PROXY_PORT}/control/status`, { headers: auth })).json()) as { intake: { onvif: string; since: number } };
      return intake.onvif === 'subscribed' && intake.since > t0;
    }, { timeout: 30000, message: 'the intake subscribed to the camera again after the restart' })
    .toBe(true);
});

// Klaus 2026-10-05: the action filter picks several actions; "All actions"
// selects all, and again none.
test('the action filter shows several actions; All actions selects all, then none', async ({ page }) => {
  await openAudit(page);
  const button = page.getByTestId('audit-filter-action');
  await expect(button).toHaveText(/All actions/);
  await showActions(page, ['login', 'logout']);
  await expect(button).toHaveText(/2 actions/);
  const rows = page.getByTestId('audit-row');
  const shown = async () => new Set(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-action'))));
  // The first test signed in and out: both are among the newest 50.
  await expect.poll(shown).toEqual(new Set(['login', 'logout']));
  // Clicking a selected action unselects it.
  await button.click();
  await page.getByTestId('audit-action-logout').click();
  await expect(page.getByTestId('audit-action-logout')).not.toBeChecked();
  await expect(button).toHaveText(/login/);
  await expect.poll(shown).toEqual(new Set(['login']));
  // All actions: all; again: none, and a clear message instead of rows.
  const all = page.getByTestId('audit-action-all');
  await all.click();
  await expect(all).toBeChecked();
  await expect(page.getByTestId('audit-action-event-analysis')).toBeChecked();
  await expect(button).toHaveText(/All actions/);
  await all.click();
  await expect(all).not.toBeChecked();
  await expect(button).toHaveText(/No actions/);
  await expect(rows).toHaveCount(0);
  await expect(page.getByTestId('audit-none')).toContainText('No actions selected');
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/audit-filter-none.png` });
});

test('the action filter works from the keyboard', async ({ page }) => {
  await openAudit(page);
  const button = page.getByTestId('audit-filter-action');
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('audit-action-all')).toBeFocused();
  await page.keyboard.press('Space'); // all → none
  await expect(page.getByTestId('audit-action-all')).not.toBeChecked();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('audit-action-proxy-start')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('audit-action-proxy-start')).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('audit-actions-menu')).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(button).toHaveText(/proxy-start/);
  await expect(page.getByTestId('audit-row').first()).toHaveAttribute('data-action', 'proxy-start');
});

// Klaus 2026-10-05: the real number of days and of records kept.
test('the retention line says the days and the records kept', async ({ page, request }) => {
  await openAudit(page);
  const line = page.getByTestId('audit-retention');
  await expect(line).toContainText(/Kept for 90 days \(Settings\) · [\d,]+ events in that time\./);
  const { records } = (await (await request.get('/control/audit/summary', { headers: auth })).json()) as { records: number };
  expect(Number((await line.textContent())!.match(/· ([\d,]+) events/)![1].replace(/,/g, ''))).toBeGreaterThanOrEqual(records - 5);
  const r = await request.put('/control/config', { headers: auth, data: { retention: { auditDays: 30 } } });
  expect(r.ok()).toBe(true);
  try {
    await page.reload();
    await expect(line).toContainText('Kept for 30 days (Settings)');
    if (process.env.SHOT_DIR) await page.locator('section').first().screenshot({ path: `${process.env.SHOT_DIR}/audit-retention.png` });
  } finally {
    await request.delete('/control/config/retention.auditDays', { headers: auth });
  }
});
