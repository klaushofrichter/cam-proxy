import { expect, type Page } from '@playwright/test';

// The Audit page's action filter (a multi-select): show only these actions.
// "All actions" selects all when some are selected, none when all are.
export async function showActions(page: Page, actions: string[]) {
  const button = page.getByTestId('audit-filter-action');
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  const all = page.getByTestId('audit-action-all');
  if (!(await all.isChecked())) await all.click(); // some or none → all
  await all.click(); // all → none
  await expect(all).not.toBeChecked();
  for (const a of actions) await page.getByTestId(`audit-action-${a}`).check();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('audit-actions-menu')).toHaveCount(0);
}
