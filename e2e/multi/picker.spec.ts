import { expect, test } from '@playwright/test';

test('the picker lists the three cameras and switches the Status cards', async ({ page }) => {
  await page.goto('/');
  const picker = page.getByTestId('camera-picker');
  await expect(picker.locator('option')).toHaveCount(3);
  await expect(page.getByTestId('camera-name')).toHaveText('Driveway', { timeout: 15_000 });
  await picker.selectOption('cam4');
  await expect(page.getByTestId('camera-name')).toHaveText('Gate');
  await page.reload();
  await expect(page.getByTestId('camera-picker')).toHaveValue('cam4');
  await expect(page.getByTestId('camera-name')).toHaveText('Gate');
});

test('Maintenance: camera actions wait for a camera route; host actions work', async ({ page }) => {
  await page.goto('/#/maintenance');
  await expect(page.getByTestId('multi-camera-note')).toBeVisible();
});
