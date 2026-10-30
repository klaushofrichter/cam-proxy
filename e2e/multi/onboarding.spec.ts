import { expect, test } from '@playwright/test';

// The onboarding card, the trust dialog and the camera password dialog (spec
// 2026-10-30-camera-onboarding-design §4.1, §4.4, §4.5), over Gate's cam-sim
// on HTTPS, added with trust none for this test and removed after it.
const UI = { 'X-CamProxy-UI': '1' };

test('trust a camera certificate from the onboarding card; a wrong password is refused and cleared', async ({ page }) => {
  const add = await page.request.put('/control/config', { headers: UI, data: { cameras: { cam8: { host: '127.0.0.1:18711', protocol: 'https', user: 'proxy', onvifPort: 18713, rtspPort: 18714, statusPollS: 5, ftp: { enabled: false } } } } });
  expect(add.status()).toBe(200);
  try {
    await page.goto('/#/status');
    await expect(page.getByTestId('camera-picker').locator('option')).toHaveCount(4, { timeout: 15_000 });
    await page.getByTestId('camera-picker').selectOption('cam8');
    const card = page.getByTestId('card-onboarding');
    await expect(card.getByTestId('onboarding-step-trust')).toHaveText('Certificate: certificate not trusted', { timeout: 15_000 });
    await card.getByTestId('onboarding-trust').click();
    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog.getByTestId('confirm-message')).toContainText('Trust the certificate SHA256:');
    await dialog.getByTestId('confirm-ok').click();
    await expect(card.getByTestId('onboarding-message')).toHaveText('Certificate of Gate trusted.');
    await expect(card.getByTestId('onboarding-step-trust')).toHaveAttribute('data-ok', 'true', { timeout: 15_000 });
    await card.getByTestId('onboarding-password').click();
    const pw = page.getByTestId('camera-password-dialog');
    await expect(pw.getByTestId('camera-password-confirm')).toHaveText('Save the login for Gate (127.0.0.1:18711) on this proxy?', { timeout: 10_000 });
    await pw.getByTestId('camera-password-input').fill('not-the-password');
    await pw.getByTestId('camera-password-save').click();
    await expect(pw.getByTestId('camera-password-message')).toHaveText('The camera refused this password.', { timeout: 15_000 });
    await expect(pw.getByTestId('camera-password-input')).toHaveValue('');
    await expect(pw.getByTestId('camera-password-input')).toHaveAttribute('type', 'password');
    await pw.getByTestId('camera-password-cancel').click();
  } finally {
    await page.request.delete('/control/cameras/cam8', { headers: UI });
  }
});
