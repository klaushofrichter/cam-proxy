import { test, expect, type APIRequestContext } from '@playwright/test';
import { ADMIN_TOKEN, CLIENT_TOKEN, PROXY_PORT, SIM, SIM_CONTROL_TOKEN } from './env';

// The Archive (spec 2026-10-05-archive-design §6): the Status card, and
// "Clear the Archive" on the Maintenance page, confirmed by typing the count.
const base = `http://127.0.0.1:${PROXY_PORT}`;
const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const client = { Authorization: `Bearer ${CLIENT_TOKEN}` };

// An FTP clip of cam-sim's (the camera uploads one after an event); one an
// earlier spec left is used when there is one.
async function aClip(request: APIRequestContext): Promise<number> {
  const list = async () => {
    const now = Date.now();
    const r = await request.get(`${base}/api/cameras/cam1/clips?from=${now - 86_400_000}&to=${now}`, { headers: client });
    return ((await r.json()) as { id: number }[]).map((c) => c.id);
  };
  const have = await list();
  if (have.length) return have[0];
  await expect.poll(async () => ((await (await request.get(`${base}/control/status`, { headers: admin })).json()) as { ftp: { listening: boolean } }).ftp.listening, { timeout: 15000 }).toBe(true);
  expect((await request.post(`${base}/control/actions/camera-ftp-setup`, { headers: admin })).ok()).toBe(true);
  expect((await request.post(`http://127.0.0.1:${SIM.control}/sim/api/events`, { headers: { Authorization: `Bearer ${SIM_CONTROL_TOKEN}` }, data: { type: 'person', durationS: 1 } })).status()).toBe(201);
  await expect.poll(async () => (await list()).length, { timeout: 30000 }).toBeGreaterThan(0);
  await request.post(`${base}/control/actions/camera-ftp-off`, { headers: admin });
  return (await list())[0];
}

test('the Archive card on the Status page, and Clear the Archive by its count', async ({ page, request }) => {
  const clipId = await aClip(request);
  const add = async (name: string) => {
    const r = await request.post(`${base}/api/cameras/cam1/archive`, { headers: client, data: { source: { type: 'clip', clipId }, name, labels: ['Person'] } });
    expect([201, 202]).toContain(r.status());
  };
  await add('e2e one');
  await add('e2e two');
  const count = async () => ((await (await request.get(`${base}/api/archive/status`, { headers: client })).json()) as { count: number }).count;
  await expect.poll(count, { timeout: 20000 }).toBeGreaterThanOrEqual(2);
  const n = await count();

  await page.goto('/#/status');
  const card = page.getByTestId('card-archive');
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('archive-count')).toHaveText(String(n));
  await expect(page.getByTestId('archive-percent')).toHaveText(/^\d+\.\d %$/);
  await expect(page.getByTestId('archive-next')).toHaveText(/(in \d+ (min|h)|now) · /);
  await expect(page.getByTestId('health-item-archive')).toBeVisible();
  if (process.env.SHOT_DIR) await card.screenshot({ path: `${process.env.SHOT_DIR}/archive-card.png` });

  await page.goto('/#/maintenance');
  const button = page.getByTestId('action-archive-clear');
  await expect(button).toBeEnabled({ timeout: 15000 });
  await button.click();
  await expect(page.getByTestId('confirm-message')).toContainText(`Delete all ${n} clips in the Archive`);
  const typed = page.getByTestId('confirm-typed');
  await expect(typed).toBeFocused();
  const ok = page.getByTestId('confirm-ok');
  await expect(ok).toBeDisabled();
  await typed.fill(String(n + 1));
  await expect(ok).toBeDisabled();
  await typed.press('Enter'); // a wrong number sends nothing
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await typed.fill(String(n));
  await expect(ok).toBeEnabled();
  await ok.click();
  await expect(page.getByTestId('action-result')).toContainText(`Clear the Archive: {"cleared":${n}`);
  await expect.poll(count).toBe(0);
  await expect(button).toBeDisabled({ timeout: 15000 });
  // The audit log has it, with the admin.
  const audit = await request.get(`${base}/control/audit?action=archive-clear&limit=1`, { headers: admin });
  expect(await audit.text()).toContain(`"count":${n}`);
});
