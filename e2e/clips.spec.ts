import { test, expect, type Page } from '@playwright/test';
import { ADMIN_TOKEN, SIM, SIM_CONTROL_TOKEN } from './env';

async function signIn(page: Page) {
  await page.goto('/'); // signed in by the storageState from auth.setup.ts
  await expect(page.getByTestId('shell')).toBeVisible();
}

test('the camera uploads a clip after setup; it plays on the Clips page', async ({ page, request }) => {
  await signIn(page);
  await expect(page.getByTestId('ftp-state')).toContainText('listening on', { timeout: 15000 });
  await page.getByTestId('nav-maintenance').click();
  await page.getByTestId('action-ftp-setup').click();
  await expect(page.getByTestId('action-result')).toContainText('Camera FTP setup: {"ftp"');
  await page.getByTestId('action-ftp-test').click();
  await expect(page.getByTestId('action-result')).toContainText('"ok":true');

  await page.getByTestId('nav-clips').click();
  // The camera-side restart in audit.spec (which runs just before) starts a new
  // ONVIF subscription whose first pull is read as the initial state, so a
  // person event inside that window (up to pullTimeoutS) is never recorded and
  // its clip has no event. Send the event again until the proxy has recorded it.
  const control = { headers: { Authorization: `Bearer ${SIM_CONTROL_TOKEN}` } };
  let recorded = false;
  for (let attempt = 0; attempt < 4 && !recorded; attempt++) {
    const since = Date.now() - 2000;
    const r = await request.post(`http://127.0.0.1:${SIM.control}/sim/api/events`, { ...control, data: { type: 'person', durationS: 1 } });
    expect(r.status()).toBe(201);
    recorded = await expect
      .poll(async () => ((await (await page.request.get(`/api/cameras/cam1/events?from=${since}&to=${Date.now() + 60_000}`)).json()) as Array<{ kind: string }>).some((e) => e.kind === 'person'), { timeout: 5000 })
      .toBe(true)
      .then(() => true, () => false);
  }
  expect(recorded, 'the proxy recorded a person event').toBe(true);
  // Not just the first clip: one left from an earlier spec may be listed first
  // (specs run faster now that they share one sign-in).
  const clip = page.getByTestId('clip').filter({ hasText: 'person' }).first();
  await expect(clip).toBeVisible({ timeout: 30000 });
  await clip.click();
  const video = page.getByTestId('clip-player');
  await expect(video).toBeVisible();
  // The browser reads the clip's metadata through the API (Range requests).
  await expect.poll(async () => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15000 }).toBeGreaterThanOrEqual(1);

  await page.getByTestId('nav-maintenance').click();
  await page.getByTestId('action-ftp-off').click();
  await expect(page.getByTestId('action-result')).toContainText('"enable":0');
});
