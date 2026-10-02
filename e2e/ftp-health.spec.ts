import { test, expect } from '@playwright/test';
import { ADMIN_TOKEN, PROXY_PORT, SIM, SIM_CONTROL_TOKEN } from './env';

// Issue #93: the camera's FTP upload switched off is red on the Status page,
// and the warning's button points it here again.
const sim = { Authorization: `Bearer ${SIM_CONTROL_TOKEN}` };

test('the camera FTP off: Status red with the alert; "Point the camera\'s FTP here" fixes it', async ({ page, request }) => {
  // Pointed here first (the sim starts unconfigured), then switched off on the camera's side.
  const setup = await request.post(`http://127.0.0.1:${PROXY_PORT}/control/actions/camera-ftp-setup`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
  expect(setup.status()).toBe(200);
  const settings = (await (await request.get(`http://127.0.0.1:${SIM.control}/sim/api/settings`, { headers: sim })).json()) as { Ftp: Record<string, unknown> };
  const off = await request.put(`http://127.0.0.1:${SIM.control}/sim/api/settings/Ftp`, { headers: sim, data: { ...settings.Ftp, enable: 0 } });
  expect(off.status()).toBe(200);

  await page.goto('/#/status');
  // Only the "off" warning: a "clips stalled" one may stand next to it after other specs' events.
  const alert = page.locator('[data-testid="ftp-alert"][data-kind="off"]');
  await expect(alert).toContainText("The camera's FTP upload is off", { timeout: 15000 });
  await expect(alert).toHaveClass(/bad/);
  await expect(alert.locator('svg')).toBeVisible(); // the alert icon
  await expect(page.getByTestId('camera-ftp-state')).toHaveText('off');
  await expect(page.getByTestId('camera-ftp-state')).toHaveClass(/bad/);

  await page.getByTestId('ftp-alert-fix').click();
  await expect(alert).toHaveCount(0);
  await expect(page.getByTestId('camera-ftp-state')).toHaveText('on, to this proxy');
  await expect(page.getByTestId('camera-ftp-state')).toHaveClass(/ok/);
});
