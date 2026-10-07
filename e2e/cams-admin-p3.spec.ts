import { test, expect } from '@playwright/test';
import { startFakeAdmin, type FakeAdmin } from '../test/helpers/fake-admin';
import { ADMIN_TOKEN } from './env';

// Remote configuration (migration P3) against a fake cams-admin: the card's
// entries are grouped and off by default; a config.set from cams-admin is
// marked on the Settings page and listed on the card; Undo restores it.
const CODE = 'CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6C';
const auth = { Authorization: `Bearer ${ADMIN_TOKEN}` };
let fake: FakeAdmin;
test.beforeAll(async () => {
  fake = await startFakeAdmin();
  fake.welcomeHeartbeatS = 1;
});
test.afterAll(async () => {
  await fake?.close();
});

test('a setting changed by cams-admin: marked, listed, undone', async ({ page, request }) => {
  await page.goto('/#/status');
  await expect(page.getByTestId('cams-admin-commands')).toBeVisible({ timeout: 15000 });
  // Grouped, the disruptive ones apart, nothing allowed.
  const disruptive = page.getByTestId('cams-admin-group-disruptive');
  await expect(disruptive).toContainText('Disruptive — off by default');
  for (const e of ['proxy.restart', 'camera.action:camera-reboot', 'camera.action:camera-powercycle']) await expect(page.getByTestId(`cams-admin-allow-${e}`)).not.toBeChecked();
  await expect(page.getByTestId('cams-admin-allow-config.set')).not.toBeChecked();

  // Enroll with the fake cams-admin; allow config.get and config.set (local admin rights).
  fake.codes.add(CODE);
  await page.getByTestId('cams-admin-url-input').fill(fake.url);
  await page.getByTestId('cams-admin-code-input').fill(CODE);
  await page.getByTestId('cams-admin-enroll').click();
  await expect(page.getByTestId('cams-admin-state')).toHaveText('connected', { timeout: 15000 });
  expect((await request.put('/control/admin/commands', { headers: auth, data: { allow: ['config.get', 'config.set'] } })).status()).toBe(200);

  // cams-admin reads, then sets sse.pingS (dry run, apply).
  const done = async (command: string, args: Record<string, unknown>) => {
    const { cmdId } = fake.sendCommand(command, args, { actor: 'admin@example.org' });
    await expect.poll(() => fake.results(cmdId).some((r) => (r.msg.body as { phase: string }).phase === 'done'), { timeout: 15000 }).toBe(true);
    return { cmdId, body: fake.results(cmdId).find((r) => (r.msg.body as { phase: string }).phase === 'done')!.msg.body as Record<string, any> };
  };
  const get = await done('config.get', { v: 1 });
  expect(get.body.status).toBe('ok');
  const base = get.body.result.revision as string;
  expect((await done('config.set', { v: 1, dryRun: true, baseRevision: base, set: { 'sse.pingS': 7 } })).body.status).toBe('ok');
  const set = await done('config.set', { v: 1, dryRun: false, baseRevision: base, set: { 'sse.pingS': 7 } });
  expect(set.body.status).toBe('ok');

  // The Settings page marks it.
  await page.goto('/#/settings');
  await expect(page.getByTestId('by-sse.pingS')).toHaveText('set by cams-admin (on behalf of admin@example.org)', { timeout: 15000 });

  // The card lists it; Undo (confirmed) restores the default.
  await page.goto('/#/status');
  const row = page.getByTestId(`cams-admin-change-${set.cmdId}`);
  await expect(row).toContainText('sse.pingS: default → 7 s', { timeout: 15000 });
  await page.getByTestId(`cams-admin-undo-${set.cmdId}`).click();
  await expect(page.getByTestId('confirm-dialog')).toContainText('sse.pingS: default → 7 s');
  await page.getByRole('button', { name: 'Undo' }).last().click();
  await expect(page.getByTestId('cams-admin-commands-message')).toContainText('Undone: sse.pingS');
  await expect(row).toContainText('undone here');
  const cfg = await (await request.get('/control/config', { headers: auth })).json();
  expect(cfg['sse.pingS']).toMatchObject({ value: 15, source: 'default' });
  expect(cfg['sse.pingS'].by).toBeUndefined();

  // Leave the proxy as it was (other specs share it).
  expect((await request.put('/control/admin/commands', { headers: auth, data: { allow: [] } })).status()).toBe(200);
  await page.getByTestId('cams-admin-unenroll').click();
  await page.getByRole('button', { name: 'Unenroll' }).last().click();
  await expect(page.getByTestId('cams-admin-state')).toHaveText('not enrolled', { timeout: 15000 });
});
