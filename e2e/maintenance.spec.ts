import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { ADMIN_TOKEN, PROXY_PORT } from './env';

// The camera reboot (#83) and the proxy restart (#71) from the Maintenance
// page, behind one confirmation dialog.
const auth = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const control = (request: APIRequestContext, path: string) => request.get(`http://127.0.0.1:${PROXY_PORT}${path}`, { headers: auth });

async function openMaintenance(page: Page) {
  await page.goto('/#/maintenance');
  await expect(page.getByTestId('action-camera-reboot')).toBeVisible();
}

// Later specs need the camera side whole again: ONVIF subscribed since `t0`, FTP listening.
async function settled(request: APIRequestContext, t0: number) {
  await expect
    .poll(async () => {
      const r = await control(request, '/control/status');
      if (!r.ok()) return false;
      const s = (await r.json()) as { camera: { online: boolean }; intake: { onvif: string; since: number }; ftp: { listening: boolean } };
      return s.camera.online && s.intake.onvif === 'subscribed' && s.intake.since > t0 && s.ftp.listening;
    }, { timeout: 60000, message: 'the camera side is back' })
    .toBe(true);
}

test('Cancel and Esc close the dialog and send nothing; focus stays inside it', async ({ page }) => {
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/control/actions/')) posts.push(r.url());
  });
  await openMaintenance(page);
  for (const [button, close] of [['action-camera-reboot', 'cancel'], ['action-restart-proxy', 'escape']] as const) {
    await page.getByTestId(button).click();
    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('confirm-cancel')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('confirm-ok')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('confirm-cancel')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('confirm-ok')).toBeFocused();
    if (close === 'cancel') await page.getByTestId('confirm-cancel').click();
    else await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId(button)).toBeFocused();
  }
  await page.waitForTimeout(500);
  expect(posts).toEqual([]);
});

test('camera reboot: confirm, "Rebooting…", the camera is back', async ({ page, request }) => {
  await openMaintenance(page);
  const t0 = Date.now();
  await page.getByTestId('action-camera-reboot').click();
  await expect(page.getByTestId('confirm-message')).toContainText('Reboot the camera? It is offline for about a minute');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('confirm-dialog')).toBeHidden();
  await expect(page.getByTestId('reboot-state')).toContainText('Rebooting…');
  await expect(page.getByTestId('reboot-state')).toContainText('The camera is back after', { timeout: 60000 });
  await settled(request, t0);
});

test('proxy restart: confirm, "Restarting…", the page reloads with the new process', async ({ page, request }) => {
  await openMaintenance(page);
  const before = (await (await request.get('/health')).json()) as { startedAt: number };
  const t0 = Date.now();
  await page.getByTestId('action-restart-proxy').click();
  await expect(page.getByTestId('confirm-message')).toContainText('Restart the proxy?');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('restart-state')).toContainText('Restarting…');
  // e2e/start.ts starts a new proxy in place of the supervisor.
  await expect.poll(async () => {
    try {
      return ((await (await request.get('/health')).json()) as { startedAt: number }).startedAt;
    } catch {
      return before.startedAt;
    }
  }, { timeout: 60000 }).not.toBe(before.startedAt);
  // The page reloaded: no "Restarting…" any more, the session still valid.
  await expect(page.getByTestId('restart-state')).toBeHidden({ timeout: 15000 });
  await expect(page.getByTestId('shell')).toBeVisible();
  await settled(request, t0);
});
