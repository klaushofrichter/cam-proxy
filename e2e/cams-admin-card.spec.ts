import { test, expect } from '@playwright/test';
import { startFakeAdmin, type FakeAdmin } from '../test/helpers/fake-admin';

// The Status page's cams-admin card (spec 2026-10-06-cams-admin-phase1-design
// §9.2, §15.2): not enrolled, enroll with a code against a fake cams-admin,
// connected (a heartbeat arrives), unenroll.
const CODE = 'CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6B';
let fake: FakeAdmin;
test.beforeAll(async () => {
  fake = await startFakeAdmin();
});
test.afterAll(async () => {
  await fake?.close();
});

test('enroll from the card, connected, unenroll', async ({ page }) => {
  await page.goto('/#/status');
  const card = page.getByTestId('card-cams-admin');
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('cams-admin-state')).toHaveText('not enrolled');

  // A wrong code: the reason, still not enrolled, the code field emptied.
  await page.getByTestId('cams-admin-url-input').fill(fake.url);
  await page.getByTestId('cams-admin-code-input').fill(CODE);
  await page.getByTestId('cams-admin-enroll').click();
  await expect(page.getByTestId('cams-admin-message')).toContainText('refused the code');
  await expect(page.getByTestId('cams-admin-code-input')).toHaveValue('');

  fake.codes.add(CODE);
  await page.getByTestId('cams-admin-code-input').fill(CODE.toLowerCase());
  await page.getByTestId('cams-admin-enroll').click();
  await expect(page.getByTestId('cams-admin-message')).toContainText('Enrolled as prx_');
  await expect(page.getByTestId('cams-admin-state')).toHaveText('connected', { timeout: 15000 });
  await expect(page.getByTestId('cams-admin-account')).toHaveText('home');
  await expect.poll(() => fake.heartbeats().length, { timeout: 15000 }).toBeGreaterThan(0);
  await expect(page.getByTestId('cams-admin-heartbeat')).toContainText('ago', { timeout: 10000 });
  await expect(card).not.toContainText(CODE);

  await page.getByTestId('cams-admin-unenroll').click();
  await page.getByRole('button', { name: 'Unenroll' }).last().click();
  await expect(page.getByTestId('cams-admin-state')).toHaveText('not enrolled', { timeout: 15000 });
  await expect.poll(() => fake.received.some((r) => r.msg.type === 'bye' && (r.msg.body as { reason: string }).reason === 'unenrolled')).toBe(true);
});
