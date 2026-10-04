import { expect, test } from '@playwright/test';

// Settings → Find camera and the settings set in .env (spec
// 2026-10-04-pi-config-design). The e2e proxy runs with PI_ADDRESS and
// without CAMPROXY_ENV_FILE; a fake WS-Discovery responder answers the probe.

test('Find camera lists the devices, marks the current camera, and offers the .env line by hand', async ({ page }) => {
  await page.goto('/#/settings');
  const card = page.getByTestId('find-camera-card');
  await card.getByTestId('find-camera-button').click();
  await expect(card.getByTestId('find-camera-message')).toHaveText('2 devices answered.');
  const rows = card.getByTestId('find-camera-device');
  await expect(rows).toHaveCount(2);
  const reolink = rows.filter({ hasText: '192.168.1.20' });
  await expect(reolink).toContainText('RLC-1224A');
  const current = rows.filter({ hasText: '127.0.0.1' });
  await expect(current.getByTestId('find-camera-current')).toHaveText('this camera');
  await expect(current.getByTestId('find-camera-use')).toHaveCount(0);
  await reolink.getByTestId('find-camera-use').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await expect(card.getByTestId('find-camera-message')).toContainText("The proxy can't write its .env file (CAMPROXY_ENV_FILE is not set).");
  await expect(card.getByTestId('find-camera-line')).toHaveText('CAMERA_HOST=192.168.1.20');
});

test('a setting from PI_ADDRESS is read-only on the Settings page', async ({ page }) => {
  await page.goto('/#/settings');
  for (const p of ['ftp.publicHost', 'server.publicUrl']) {
    await expect(page.getByTestId(`source-${p}`)).toHaveText('env');
    await expect(page.getByTestId(`input-${p}`)).toBeDisabled();
    await expect(page.getByTestId(`env-note-${p}`)).toHaveText('set in .env (PI_ADDRESS)');
    await expect(page.getByTestId(`reset-${p}`)).toHaveCount(0);
  }
  await expect(page.getByTestId('input-ftp.publicHost')).toHaveValue('127.0.0.1');
  // server.port (8480 by default) makes the URL; the e2e harness listens elsewhere.
  await expect(page.getByTestId('input-server.publicUrl')).toHaveValue('http://127.0.0.1:8480');
  // camera.host still comes from config.json: editable.
  await expect(page.getByTestId('input-camera.host')).toBeEnabled();
});
