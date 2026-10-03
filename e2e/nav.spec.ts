import { test, expect, type Page } from '@playwright/test';

// Page navigation like cams: a collapsible sidebar on desktop, a hamburger
// drawer on phones (767 px and narrower).

async function open(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('shell')).toBeVisible();
}
const width = async (page: Page) => (await page.getByTestId('sidebar').boundingBox())!.width;

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the sidebar has labels, collapses to icons, remembers it, and expands again', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('hamburger')).toBeHidden();
    await expect.poll(() => width(page)).toBe(220);
    await expect(page.getByTestId('nav-events').locator('.label')).toBeVisible();
    const toggle = page.getByTestId('sidebar-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect.poll(() => width(page)).toBe(64);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('nav-events')).toHaveAttribute('title', 'Events');
    await page.reload();
    await expect.poll(() => width(page)).toBe(64);
    // Collapsed, the icons still navigate and show the active page.
    await page.getByTestId('nav-events').click();
    await expect(page).toHaveURL(/#\/events$/);
    await expect(page.getByTestId('nav-events')).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('sidebar-toggle').click();
    await expect.poll(() => width(page)).toBe(220);
    await page.reload();
    await expect.poll(() => width(page)).toBe(220);
  });

  test('the theme toggle and Sign out stay in the top bar', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('theme-toggle')).toBeVisible();
    await expect(page.getByTestId('logout')).toBeVisible();
    await expect(page.getByTestId('camera-online')).toHaveText('camera online', { timeout: 15000 });
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('no sidebar; a one-row top bar with the hamburger first', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('sidebar')).toBeHidden();
    await expect(page.getByTestId('drawer')).toHaveCount(0);
    const burger = page.getByTestId('hamburger');
    await expect(burger).toBeVisible();
    await expect(burger).toHaveAttribute('aria-expanded', 'false');
    await expect(burger).toHaveAttribute('aria-controls', 'nav-drawer');
    const bar = (await page.getByTestId('topbar').boundingBox())!;
    expect(bar.height).toBeLessThan(60); // one row, no wrapping
    expect((await burger.boundingBox())!.x).toBeLessThan(20);
    // Theme and Sign out move into the drawer.
    await expect(page.getByTestId('logout')).toBeHidden();
    // The pills keep their full text for screen readers and tests.
    await expect(page.getByTestId('camera-online')).toHaveText('camera online', { timeout: 15000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('the hamburger opens the drawer; Escape closes it and focus returns', async ({ page }) => {
    await open(page);
    const burger = page.getByTestId('hamburger');
    await burger.click();
    const drawer = page.getByTestId('drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible();
    await expect(burger).toHaveAttribute('aria-expanded', 'true');
    await expect(drawer.getByTestId('nav-status')).toBeFocused();
    await expect(drawer.getByTestId('nav-status')).toHaveAttribute('aria-current', 'page');
    await expect(drawer.getByTestId('theme-toggle')).toBeVisible();
    await expect(drawer.getByTestId('drawer-logout')).toBeVisible();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('drawer')).toHaveCount(0);
    await expect(burger).toBeFocused();
    await expect(burger).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  });

  test('navigating from the drawer closes it and shows the page', async ({ page }) => {
    await open(page);
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer').getByTestId('nav-settings').click();
    await expect(page.getByTestId('drawer')).toHaveCount(0);
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(page.getByTestId('input-sse.pingS')).toBeVisible();
    await page.getByTestId('hamburger').click();
    await expect(page.getByTestId('drawer').getByTestId('nav-settings')).toHaveAttribute('aria-current', 'page');
  });

  test('a tap on the backdrop or the close button closes the drawer', async ({ page }) => {
    await open(page);
    await page.getByTestId('hamburger').click();
    await expect(page.getByTestId('drawer')).toBeVisible();
    // The drawer is 260 px wide; the backdrop shows to its right.
    await page.getByTestId('drawer-backdrop').click({ position: { x: 340, y: 400 } });
    await expect(page.getByTestId('drawer')).toHaveCount(0);
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer-close').click();
    await expect(page.getByTestId('drawer')).toHaveCount(0);
  });

  test('growing to desktop width closes the drawer and shows the sidebar', async ({ page }) => {
    await open(page);
    await page.getByTestId('hamburger').click();
    await expect(page.getByTestId('drawer')).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('drawer')).toHaveCount(0);
    await expect(page.getByTestId('sidebar')).toBeVisible();
  });
});
