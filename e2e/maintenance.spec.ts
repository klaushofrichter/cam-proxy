import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { ADMIN_TOKEN, POE_SWITCH_PORT, PROXY_PORT } from './env';

// The camera reboot (#83), the power-cycle (#85) and the proxy restart (#71)
// from the Maintenance page, behind one confirmation dialog.
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

test('no PoE switch configured: no "Power-cycle camera" button', async ({ page, request }) => {
  const s = (await (await control(request, '/control/status')).json()) as { camera: { poeSwitch: { model: string; configured: boolean } } };
  expect(s.camera.poeSwitch).toMatchObject({ model: 'none', configured: false });
  await openMaintenance(page);
  await expect(page.getByTestId('action-camera-powercycle')).toHaveCount(0);
});

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
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/control/actions/restart-proxy')) posts.push(r.url());
  });
  // The page's /health read before the request is slow: the button is busy
  // at once, so the dialog can't be confirmed a second time (#78 review).
  let slow = true;
  await page.route('**/health', async (route) => {
    if (slow) {
      slow = false;
      await new Promise((r) => setTimeout(r, 1500));
    }
    await route.continue();
  });
  await page.getByTestId('action-restart-proxy').click();
  await expect(page.getByTestId('confirm-message')).toContainText('Restart the proxy?');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('action-restart-proxy')).toBeDisabled();
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
  expect(posts).toHaveLength(1);
  await settled(request, t0);
});

// After the restart: a new process, so the reboot's cooldown no longer applies.
test('camera power-cycle: configure the switch, confirm, "Power-cycling…", the camera is back', async ({ page, request }) => {
  test.setTimeout(150_000); // a power-cycle and a PoE recovery, each with the camera away
  const url = `http://127.0.0.1:${PROXY_PORT}`;
  const put = await request.put(`${url}/control/config`, { headers: auth, data: { camera: { poeSwitch: { model: 'sscpoe-web', host: `127.0.0.1:${POE_SWITCH_PORT}`, port: 8, offSeconds: 5 } } } });
  expect(put.ok()).toBe(true);
  try {
    await openMaintenance(page);
    const t0 = Date.now();
    await page.getByTestId('action-camera-powercycle').click();
    await expect(page.getByTestId('confirm-message')).toHaveText(`Cut the camera's PoE power on 127.0.0.1:${POE_SWITCH_PORT} port 8 for 5 s? The camera is offline for about a minute. Only works while nobody is logged in to the switch's web UI.`);
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('confirm-dialog')).toBeHidden();
    await expect(page.getByTestId('reboot-state')).toContainText('Power-cycling…');
    await expect(page.getByTestId('action-camera-reboot')).toBeDisabled();
    await expect(page.getByTestId('action-result')).toContainText('Camera power-cycle: PoE back on after', { timeout: 20000 });
    await expect(page.getByTestId('reboot-state')).toContainText('The camera is back after', { timeout: 60000 });
    await expect(page.getByTestId('poe-alert')).toHaveCount(0);
    // The cooldown is shared: the camera reboot is refused now.
    const reboot = await request.post(`${url}/control/actions/camera-reboot`, { headers: auth });
    expect(reboot.status()).toBe(429);
    const audit = await request.get(`${url}/control/audit?action=camera-powercycle`, { headers: auth });
    const recs = (await audit.text()).trim().split('\n').map((l) => JSON.parse(l) as { event: { outcome: string }; cam_proxy: { phase: string } });
    expect(recs.map((r) => [r.cam_proxy.phase, r.event.outcome])).toEqual([['back', 'success'], ['requested', 'success']]);
    await settled(request, t0);

    // Recovery (#85 review): the port is off (as if a power-cycle could not
    // turn it on again); a read says so, the page warns, "Turn camera PoE on"
    // turns it on, and the camera comes back.
    const t1 = Date.now();
    await request.post(`http://127.0.0.1:${POE_SWITCH_PORT}/mock/poe`, { data: { index: 0, on: false } });
    expect((await request.post(`${url}/control/actions/poe-switch-read`, { headers: auth })).ok()).toBe(true);
    await expect(page.getByTestId('poe-alert')).toHaveText("The camera's PoE may be OFF: use 'Turn camera PoE on', or the switch's web UI (port 8).", { timeout: 15000 });
    await page.getByTestId('action-camera-poe-on').click();
    await expect(page.getByTestId('action-result')).toHaveText('Camera PoE: turned on on port 8; the camera boots in about a minute');
    await expect(page.getByTestId('poe-alert')).toHaveCount(0, { timeout: 15000 });
    await page.getByTestId('action-camera-poe-on').click();
    await expect(page.getByTestId('action-result')).toContainText('Camera PoE: port 8 was on already');
    await settled(request, t1);
  } finally {
    for (const k of ['model', 'host', 'port', 'offSeconds']) await request.delete(`${url}/control/config/camera.poeSwitch.${k}`, { headers: auth });
  }
});
