import { test, expect, type Page } from '@playwright/test';
import { ADMIN_TOKEN, PROXY_PORT } from './env';

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
  await page.getByTestId('audit-filter-action').selectOption('login');
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
    await page.getByTestId('audit-filter-action').selectOption('config-change');
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
  await page.getByTestId('audit-filter-action').selectOption('login'); // slow
  await page.getByTestId('audit-filter-action').selectOption('logout'); // fast
  await expect(page.getByTestId('audit-row').first()).toHaveAttribute('data-action', 'logout');
  await page.waitForTimeout(2000); // the slow login answer has arrived by now
  const actions = await page.getByTestId('audit-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-action')));
  expect(actions.length).toBeGreaterThan(0);
  expect(new Set(actions)).toEqual(new Set(['logout']));
});

test('a restart through the control API is recorded', async ({ page, request }) => {
  await request.post(`http://127.0.0.1:${PROXY_PORT}/control/actions/restart`, { headers: auth });
  await openAudit(page);
  await page.getByTestId('audit-filter-action').selectOption('proxy-restart');
  await expect(page.getByTestId('audit-row').first()).toHaveAttribute('data-action', 'proxy-restart');
  await expect.poll(async () => (await request.get('/health')).status(), { timeout: 30000 }).toBe(200);
});
