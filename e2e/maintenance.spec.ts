import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { startFakeAdmin, type FakeAdmin } from '../test/helpers/fake-admin';
import { ADMIN_TOKEN, POE_SWITCH_PORT, PROXY_PORT } from './env';

// The camera reboot (#83), the power-cycle (through cams-admin, spec
// 2026-11-07-poe-switches-design) and the proxy restart (#71) from the
// Maintenance page, behind one confirmation dialog.
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

test('without cams-admin: "Power-cycle (through cams-admin)" is off and says why', async ({ page, request }) => {
  const r = await request.post(`http://127.0.0.1:${PROXY_PORT}/control/actions/camera-powercycle`, { headers: auth });
  expect(r.status()).toBe(409);
  expect((await r.json()) as { error: string }).toMatchObject({ error: 'power_cycle_needs_cams_admin' });
  await openMaintenance(page);
  await expect(page.getByTestId('action-camera-powercycle')).toHaveText('Power-cycle (through cams-admin)');
  await expect(page.getByTestId('action-camera-powercycle')).toBeDisabled();
  await expect(page.getByTestId('powercycle-why')).toContainText('needs cams-admin');
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
// cams-admin is the fake (test/helpers/fake-admin): enrolled for this test only.
test('camera power-cycle through cams-admin: confirm, "Asked cams-admin…", "Power-cycling…", the camera is back, the answer shows', async ({ page, request }) => {
  test.setTimeout(150_000);
  const url = `http://127.0.0.1:${PROXY_PORT}`;
  const fake: FakeAdmin = await startFakeAdmin();
  fake.welcomeHeartbeatS = 1;
  const before = ((await (await request.get(`${url}/control/admin/commands`, { headers: auth })).json()) as { allow: string[] }).allow;
  try {
    const CODE = 'CAE1-7Q2M-K9XD-4HPA-W3ZT-RN7D';
    fake.codes.add(CODE);
    expect((await request.post(`${url}/control/admin/enroll`, { headers: auth, data: { url: fake.url, code: CODE } })).status()).toBe(200);
    // The camera.power.* messages are on by default; an earlier spec may have switched every entry off.
    const power = ['camera.power.set', 'camera.power.cycling', 'camera.power.cycled', 'camera.power.cycle.result'];
    expect((await request.put(`${url}/control/admin/commands`, { headers: auth, data: { allow: [...new Set([...before, ...power])] } })).status()).toBe(200);
    await expect.poll(async () => ((await (await request.get(`${url}/control/admin`, { headers: auth })).json()) as { state: string }).state, { timeout: 15000 }).toBe('connected');
    const done = async (command: string, args: Record<string, unknown>) => {
      const { cmdId } = fake.sendCommand(command, { v: 1, ...args }, { actor: 'admin@example.org' });
      await expect.poll(() => fake.results(cmdId).some((r) => (r.msg.body as { phase: string }).phase === 'done'), { timeout: 15000 }).toBe(true);
      return fake.results(cmdId).find((r) => (r.msg.body as { phase: string }).phase === 'done')!.msg.body as Record<string, unknown>;
    };
    expect(await done('camera.power.set', { camera: 'cam1', power: { kind: 'poe', switchName: 'Switch 2', port: 8, watts: 6.8, verifiedAt: Date.now() - 2 * 3600_000 } })).toMatchObject({ status: 'ok' });

    // Camera settings shows the camera's power as cams-admin sent it.
    await page.goto('/#/camera-settings');
    await expect(page.getByTestId('camera-power-line')).toHaveText('PoE: Switch 2, port 8, verified 2 h ago', { timeout: 15000 });

    await openMaintenance(page);
    const t0 = Date.now();
    await expect(page.getByTestId('action-camera-powercycle')).toBeEnabled({ timeout: 15000 });
    await page.getByTestId('action-camera-powercycle').click();
    await expect(page.getByTestId('confirm-message')).toHaveText('Ask cams-admin to power-cycle the camera (PoE: Switch 2, port 8)? cams-admin first checks that the camera is on that port, then cuts its PoE for a few seconds. The camera is offline for about a minute.');
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('action-result')).toHaveText('Camera power-cycle: asked cams-admin…');
    await expect(page.getByTestId('reboot-state')).toContainText('Asked cams-admin…');
    await expect(page.getByTestId('action-camera-powercycle')).toBeDisabled();
    // Exactly one request reached cams-admin.
    await expect.poll(() => fake.events().filter((e) => (e.msg.body as { kind: string }).kind === 'camera.power.cycle.request').length, { timeout: 10000 }).toBe(1);
    const ev = fake.events().find((e) => (e.msg.body as { kind: string }).kind === 'camera.power.cycle.request')!.msg.body as { camera: string; requestId: string };
    expect(ev.camera).toBe('cam1');

    // cams-admin's operator cuts the PoE (here: the mock switch, which powers cam-sim down), then turns it on.
    await request.post(`http://127.0.0.1:${POE_SWITCH_PORT}/mock/poe`, { data: { index: 0, on: false } });
    expect(await done('camera.power.cycling', { camera: 'cam1', at: Date.now() })).toMatchObject({ status: 'ok' });
    await expect(page.getByTestId('reboot-state')).toContainText('Power-cycling…', { timeout: 10000 });
    await expect(page.getByTestId('action-camera-reboot')).toBeDisabled();
    await request.post(`http://127.0.0.1:${POE_SWITCH_PORT}/mock/poe`, { data: { index: 0, on: true } });
    expect(await done('camera.power.cycled', { camera: 'cam1', ok: true, message: 'PoE on again after 5 s' })).toMatchObject({ status: 'ok' });
    expect(await done('camera.power.cycle.result', { camera: 'cam1', requestId: ev.requestId, ok: true })).toMatchObject({ status: 'ok' });
    await expect(page.getByTestId('action-result')).toHaveText('Camera power-cycle: done by cams-admin', { timeout: 15000 });
    await expect(page.getByTestId('reboot-state')).toContainText('The camera is back after', { timeout: 60000 });
    // The cooldown is shared: the camera reboot is refused now.
    expect((await request.post(`${url}/control/actions/camera-reboot`, { headers: auth })).status()).toBe(429);
    const audit = await request.get(`${url}/control/audit?action=camera-powercycle`, { headers: auth });
    const recs = (await audit.text()).trim().split('\n').map((l) => JSON.parse(l) as { cam_proxy: { phase: string } });
    expect(recs.map((r) => r.cam_proxy.phase)).toEqual(['back', 'result', 'cycled', 'requested', 'asked']);
    await settled(request, t0);
  } finally {
    await request.put(`${url}/control/admin/commands`, { headers: auth, data: { allow: before } });
    await request.post(`${url}/control/admin/unenroll`, { headers: auth });
    await fake.close();
  }
});

// Recovery (#85 review): with the old switch settings, the port is off (as if
// a power-cycle could not turn it on again); a read says so, the page warns,
// "Turn camera PoE on" turns it on, and the camera comes back.
test('Turn camera PoE on: the warning, the recovery, the camera is back', async ({ page, request }) => {
  test.setTimeout(150_000);
  const url = `http://127.0.0.1:${PROXY_PORT}`;
  const put = await request.put(`${url}/control/config`, { headers: auth, data: { camera: { poeSwitch: { model: 'sscpoe-web', host: `127.0.0.1:${POE_SWITCH_PORT}`, port: 8, offSeconds: 5 } } } });
  expect(put.ok()).toBe(true);
  try {
    await openMaintenance(page);
    const t1 = Date.now();
    await request.post(`http://127.0.0.1:${POE_SWITCH_PORT}/mock/poe`, { data: { index: 0, on: false } });
    expect((await request.post(`${url}/control/actions/poe-switch-read`, { headers: auth })).ok()).toBe(true);
    await expect(page.getByTestId('poe-alert')).toHaveText("The camera's PoE may be OFF: use 'Turn camera PoE on', or the switch's web UI (port 8).", { timeout: 15000 });
    await page.getByTestId('action-camera-poe-on').click();
    await expect(page.getByTestId('action-result')).toHaveText('Camera PoE: turned on on port 8; the camera boots in about a minute');
    await expect(page.getByTestId('poe-alert')).toHaveCount(0, { timeout: 15000 });
    await page.getByTestId('action-camera-poe-on').click();
    await expect(page.getByTestId('action-result')).toContainText('Camera PoE: port 8 was on already');
    // The old switch settings no longer power-cycle: still through cams-admin only.
    await expect(page.getByTestId('action-camera-powercycle')).toBeDisabled();
    await settled(request, t1);
  } finally {
    for (const k of ['model', 'host', 'port', 'offSeconds']) await request.delete(`${url}/control/config/camera.poeSwitch.${k}`, { headers: auth });
  }
});
