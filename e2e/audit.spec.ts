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

// One sign-in for the whole file: the /control/login limiter (20 per 15 min)
// is shared by every spec in the run, so each sign-in here is one the later
// specs can't have.
let page: Page;
test.beforeAll(async ({ browser, request }) => {
  // One wrong sign-in only, made before the real one.
  await request.post(`http://127.0.0.1:${PROXY_PORT}/control/login`, { data: { token: 'wrong' } });
  page = await browser.newPage();
  await signIn(page);
});
test.afterAll(async () => { await page.close(); });

test('sign-ins, a refused sign-in and a sign-out appear on the Audit page, newest first', async ({ request }) => {
  await page.getByTestId('nav-audit').click();
  const rows = page.getByTestId('audit-row');
  await expect(rows.first()).toHaveAttribute('data-action', 'login');
  await expect(rows.first()).toContainText('admin');
  await page.getByTestId('audit-filter-outcome').selectOption('failure');
  await expect(rows.first()).toContainText('refused');
  await rows.first().click();
  await expect(page.getByTestId('audit-row-json')).toContainText('"method": "token-form"');
});

test('pages older and newer with more than 50 records', async ({ request }) => {
  // Each changed value writes one config-change record.
  for (let i = 0; i < 55; i++) {
    const r = await request.put('/control/config', { headers: auth, data: { analytics: { googleVision: { dailyCap: (i % 2) + 1 } } } });
    expect(r.ok()).toBe(true);
  }
  try {
    await page.reload(); // a fresh page with no filters; the hash keeps us on Audit
    await expect(page.getByTestId('audit-table')).toBeVisible();
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

test('a restart through the control API is recorded', async ({ request }) => {
  await request.post(`http://127.0.0.1:${PROXY_PORT}/control/actions/restart`, { headers: auth });
  await page.reload();
  await expect(page.getByTestId('audit-table')).toBeVisible();
  await page.getByTestId('audit-filter-action').selectOption('proxy-restart');
  await expect(page.getByTestId('audit-row').first()).toHaveAttribute('data-action', 'proxy-restart');
  await expect.poll(async () => (await request.get('/health')).status(), { timeout: 30000 }).toBe(200);
});
