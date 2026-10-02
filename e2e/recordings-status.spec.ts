import { test, expect } from '@playwright/test';

// The Status page's Recordings (SD card) card: before any download it shows
// a dash, not a failure, and the cache against its cap.
test('Status shows the Recordings card, grey before the first download', async ({ page }) => {
  await page.goto('/#/status');
  const card = page.getByTestId('card-recordings');
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('recordings-last')).toHaveText('—');
  await expect(page.getByTestId('recordings-last')).not.toHaveClass(/bad|ok/);
  await expect(page.getByTestId('recordings-cache')).toHaveText(/^\d+ MB of \d+ MB$/);
  if (process.env.SHOT_DIR) await card.screenshot({ path: `${process.env.SHOT_DIR}/recordings-card.png` });
});
