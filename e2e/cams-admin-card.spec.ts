import { test, expect } from '@playwright/test';
import { startFakeAdmin, type FakeAdmin } from '../test/helpers/fake-admin';
import { MANAGED_TOKEN, MANAGED_TOKEN_ID } from './env';

// The cams-admin page (spec 2026-10-06-cams-admin-phase1-design §9.2, §15.2;
// its own page since #203): not enrolled, enroll with a code against a fake
// cams-admin, connected (a heartbeat arrives), unenroll. The Status page keeps
// a short card with a link to the page.
const CODE = 'CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6B';
let fake: FakeAdmin;
test.beforeAll(async () => {
  fake = await startFakeAdmin();
});
test.afterAll(async () => {
  await fake?.close();
});

test('enroll on the cams-admin page, connected, unenroll', async ({ page }) => {
  await page.goto('/#/status');
  await expect(page.getByTestId('summary-cams-admin-state')).toHaveText('not enrolled', { timeout: 15000 });
  await page.getByTestId('cams-admin-details-link').click();
  await expect(page).toHaveURL(/#\/cams-admin$/);
  await expect(page.getByTestId('nav-cams-admin')).toHaveAttribute('aria-current', 'page');
  const card = page.getByTestId('cams-admin-connection');
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
  // The Status page's short card follows.
  await page.goto('/#/status');
  await expect(page.getByTestId('summary-cams-admin-state')).toHaveText('connected', { timeout: 15000 });
  await expect(page.getByTestId('summary-cams-admin-account')).toHaveText('home');
  await expect(page.getByTestId('summary-cams-admin-commands')).toHaveText('on');
  await page.goto('/#/cams-admin');

  await page.getByTestId('cams-admin-unenroll').click();
  await page.getByRole('button', { name: 'Unenroll' }).last().click();
  await expect(page.getByTestId('cams-admin-state')).toHaveText('not enrolled', { timeout: 15000 });
  await expect.poll(() => fake.received.some((r) => r.msg.type === 'bye' && (r.msg.body as { reason: string }).reason === 'unenrolled')).toBe(true);
});

// Commands from cams-admin and managed tokens (migration P2): off by default;
// allow, pause and resume with the local admin session; block a managed token.
test('allowed commands, pause, recent commands and managed tokens', async ({ page, request }) => {
  await page.goto('/#/cams-admin');
  const box = page.getByTestId('cams-admin-commands');
  await expect(box).toBeVisible({ timeout: 15000 });
  await expect(box).toContainText('Allowed commands');
  const tokensApply = page.getByTestId('cams-admin-allow-tokens.apply');
  await expect(tokensApply).not.toBeChecked();
  // P3: implemented, so tickable, and still off by default.
  await expect(page.getByTestId('cams-admin-allow-config.get')).toBeEnabled();
  await expect(page.getByTestId('cams-admin-allow-config.get')).not.toBeChecked();
  await tokensApply.check();
  await page.getByTestId('cams-admin-commands-save').click();
  await expect(page.getByTestId('cams-admin-commands-message')).toContainText('Saved');
  await page.reload();
  await expect(page.getByTestId('cams-admin-allow-tokens.apply')).toBeChecked({ timeout: 15000 });

  await page.getByTestId('cams-admin-pause-reason').fill('maintenance');
  await page.getByTestId('cams-admin-pause').click();
  await expect(page.getByTestId('cams-admin-commands-banner')).toHaveText('Paused: maintenance');
  await page.getByTestId('cams-admin-resume').click();
  await expect(page.getByTestId('cams-admin-commands-banner')).toHaveCount(0);
  await expect(page.getByTestId('cams-admin-recent')).toContainText('No commands yet');

  const tokens = page.getByTestId('cams-admin-tokens');
  // The id shortened in the middle; the full one as its title (#203).
  await expect(tokens.getByTestId(`cams-admin-token-id-${MANAGED_TOKEN_ID}`)).toHaveAttribute('title', MANAGED_TOKEN_ID);
  await expect(tokens).toContainText('cams e2e');
  await expect(tokens).toContainText('live');
  expect((await request.get('/api/cameras', { headers: { Authorization: `Bearer ${MANAGED_TOKEN}` } })).status()).toBe(200);
  await page.getByTestId(`cams-admin-token-block-${MANAGED_TOKEN_ID}`).click();
  await expect(tokens).toContainText('blocked');
  expect((await request.get('/api/cameras', { headers: { Authorization: `Bearer ${MANAGED_TOKEN}` } })).status()).toBe(401);
  await page.getByTestId(`cams-admin-token-unblock-${MANAGED_TOKEN_ID}`).click();
  // Unblocking drops the entry: cams-admin's next tokens.apply brings it back.
  await expect(tokens.getByTestId(`cams-admin-token-${MANAGED_TOKEN_ID}`)).toHaveCount(0);

  // Leave the policy as it was (other specs share this proxy).
  await page.getByTestId('cams-admin-allow-tokens.apply').uncheck();
  await page.getByTestId('cams-admin-commands-save').click();
  await expect(page.getByTestId('cams-admin-commands-message')).toContainText('Saved');
});
