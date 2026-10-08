import { mkdirSync } from 'fs';
import { join } from 'path';
import { test, expect, type Locator, type Page } from '@playwright/test';

// The layout of the cams-admin and Certificates pages and of the Status
// page's short cards (#203), at phone and desktop width, light and dark:
// nothing wider than the page, summary rows that don't stretch, ids and
// fingerprints that don't break mid-token. The proxy's answers for cams-admin
// and the certificates are test fixtures (made-up ids, never real data), with
// values as long as the real ones. Screenshots go to .superpowers/e2e-screens
// (gitignored; not uploaded).
const SCREENS = join(__dirname, '..', '.superpowers', 'e2e-screens');
mkdirSync(SCREENS, { recursive: true });

const NOW = Date.now();
const HEX = 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90';
const ADMIN = {
  state: 'connected', url: 'https://cams-admin.fixture-home-network.example.org/', account: 'home-fixture-account', proxyId: 'prx_01JFIXTURE0000000000009F5X',
  fingerprint: `SHA256:${HEX}`, enrolledAt: NOW - 3 * 86400_000, connectedSince: NOW - 6 * 3600_000, lastHeartbeatAt: NOW - 4000, lastAckAt: NOW - 4000,
  lastError: null, lastErrorAt: null, retryInMs: null, truncated: false,
};
const ACTORS = ['cms_79S6FIXTURE0000ZJZS', 'someone.with.a.long.name@fixture-family.example.org', 'cms_01JFIXTURE000000000Q2'];
const COMMANDS = ['tokens.apply', 'config.get', 'config.set', 'camera.action:camera-cert-push'];
const RECENT = Array.from({ length: 10 }, (_, i) => ({ cmdId: `cmd_01JFIXTURE0000000000000${String(i).padStart(2, '0')}`, command: COMMANDS[i % COMMANDS.length], actor: ACTORS[i % ACTORS.length], at: NOW - (i + 1) * 47 * 60_000, status: i === 3 ? 'conflict' : 'ok', ...(i === 3 ? { code: 'changed' } : {}) }));
const TOKENS = {
  revision: 7, problem: null,
  items: [
    { id: 'tok_01JFIXTURE00000000000AB1', kind: 'client', label: 'cams', retireAt: null, blocked: false, live: true, hashPrefix: 'sha256:9f86d08' },
    { id: 'tok_01JFIXTURE00000000000AB2', kind: 'admin', label: 'cams-admin fleet console (fixture)', retireAt: NOW + 5 * 3600_000, blocked: false, live: true, hashPrefix: 'sha256:60303ae' },
    { id: 'tok_01JFIXTURE00000000000AB3', kind: 'client', label: 'old phone', retireAt: null, blocked: true, live: true, hashPrefix: 'sha256:fd61a03' },
  ],
};
const CHANGES = {
  items: [
    { cmdId: 'cmd_01JFIXTURE0000000000000C1', command: 'config.set', actor: ACTORS[1], at: NOW - 2 * 3600_000, paths: [{ path: 'sse.pingS', to: 7 }, { path: 'retention.stillsDays', from: 7, to: 14 }], rolledBack: null },
    { cmdId: 'cmd_01JFIXTURE0000000000000C2', command: 'config.set', actor: ACTORS[0], at: NOW - 26 * 3600_000, paths: [{ path: 'sse.pingS', from: 15, to: 20 }], rolledBack: { at: NOW - 25 * 3600_000, by: 'local', user: 'admin' } },
  ],
};
const leaf = (n: number) => `SHA256:${HEX.slice(n)}${HEX.slice(0, n)}`;
const TLS = {
  site: 'home', caFingerprint: `SHA256:${HEX}`, caNotAfter: NOW + 3650 * 86400_000,
  proxy: { servername: 'proxy.home.internal', fingerprint: leaf(8), notAfter: NOW + 390 * 86400_000 },
  cameras: [
    { id: 'cam1', servername: 'cam1.home.internal', fingerprint: leaf(16), mode: 'site-ca', notAfter: NOW + 200 * 86400_000, lastPush: { at: NOW - 6 * 3600_000, outcome: 'pushed' }, problem: null },
    { id: 'cam2', servername: 'cam2.home.internal', fingerprint: leaf(24), mode: 'pinned', notAfter: NOW + 3000 * 86400_000, lastPush: { at: NOW - 3600_000, outcome: 'refused' }, problem: null },
    { id: 'cam3', servername: null, fingerprint: null, mode: 'none', notAfter: null, lastPush: null, problem: null },
  ],
  problems: [],
};

async function fixtures(page: Page) {
  await page.route('**/control/admin', (r) => r.fulfill({ json: ADMIN }));
  await page.route('**/control/admin/tokens', (r) => r.fulfill({ json: TOKENS }));
  await page.route('**/control/admin/changes', (r) => r.fulfill({ json: CHANGES }));
  // The real entries and groups, with fixture recent commands and ticks.
  await page.route('**/control/admin/commands', async (r) => {
    const real = await (await r.fetch()).json();
    await r.fulfill({ json: { ...real, allow: ['tokens.apply', 'config.get'], unconfirmed: ['config.set'], recent: RECENT } });
  });
  await page.route('**/control/tls', (r) => r.fulfill({ json: TLS }));
}

// Neither the page nor its scrolling main area is wider than the window.
async function noHorizontalOverflow(page: Page) {
  const sizes = await page.evaluate(() => {
    const m = document.querySelector('main')!;
    const d = document.documentElement;
    return { main: [m.scrollWidth, m.clientWidth], doc: [d.scrollWidth, d.clientWidth] };
  });
  expect(sizes.main[0], 'main scrollWidth').toBeLessThanOrEqual(sizes.main[1]);
  expect(sizes.doc[0], 'document scrollWidth').toBeLessThanOrEqual(sizes.doc[1]);
}

// The whole page in one picture: main scrolls inside the window, so it is let
// grow for the screenshot and put back after.
async function shot(page: Page, name: string) {
  const style = await page.addStyleTag({ content: '.shell { height: auto !important; } main { overflow: visible !important; }' });
  await page.screenshot({ path: join(SCREENS, `${name}.png`), fullPage: true });
  await style.evaluate((el) => el.remove());
}

// How many lines an element's text takes.
const lines = (l: Locator) => l.evaluate((el) => {
  const lh = parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.2;
  return Math.round(el.getBoundingClientRect().height / lh);
});
const heights = (l: Locator) => l.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));

for (const width of [360, 1280]) {
  for (const theme of ['light', 'dark'] as const) {
    test.describe(`${width} px, ${theme}`, () => {
      test.use({ viewport: { width, height: 900 } });
      test.beforeEach(async ({ page }) => {
        await page.addInitScript((t) => localStorage.setItem('camproxy-theme', t), theme);
        await fixtures(page);
      });

      test('Status: the short cards keep their rows together', async ({ page }) => {
        await page.goto('/#/status');
        const admin = page.getByTestId('card-cams-admin');
        const certs = page.getByTestId('card-certificates');
        await expect(page.getByTestId('summary-cams-admin-state')).toHaveText('connected', { timeout: 15000 });
        await expect(page.getByTestId('summary-cams-admin-last')).toContainText('tokens.apply');
        await expect(page.getByTestId('summary-cams-admin-allowed')).toHaveText('2 allowed, 1 needs re-confirming');
        await expect(page.getByTestId('summary-cams-admin-tokens')).toHaveText('2 live, 1 blocked');
        await expect(certs).toBeVisible();
        await expect(page.getByTestId('summary-cert-row-cam1')).toContainText(/site CA · expires in (199|200) days/);
        await noHorizontalOverflow(page);
        // No row taller than two lines: the cards don't spread their rows over
        // the height of a taller card next to them (the root cause in #203).
        for (const card of [admin, certs]) {
          for (const h of await heights(card.locator('dt, dd, li'))) expect(h).toBeLessThanOrEqual(44);
          const rows = await card.locator('dl > dt').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
          for (let i = 1; i < rows.length; i++) expect(rows[i] - rows[i - 1], 'gap between rows').toBeLessThanOrEqual(48);
        }
        await admin.scrollIntoViewIfNeeded();
        await shot(page, `status-${width}-${theme}`);
        await admin.screenshot({ path: join(SCREENS, `status-cards-cams-admin-${width}-${theme}.png`) });
        await certs.screenshot({ path: join(SCREENS, `status-cards-certificates-${width}-${theme}.png`) });
      });

      test('the cams-admin page', async ({ page }) => {
        await page.goto('/#/cams-admin');
        await expect(page.getByTestId('cams-admin-state')).toHaveText('connected', { timeout: 15000 });
        await expect(page.getByTestId('cams-admin-recent-row')).toHaveCount(10);
        await shot(page, `cams-admin-${width}-${theme}`);
        await noHorizontalOverflow(page);
        // Ids on one line (shortened at phone width), the key fingerprint in a few lines.
        expect(await lines(page.getByTestId('cams-admin-proxy-id'))).toBe(1);
        for (const t of TOKENS.items) expect(await lines(page.getByTestId(`cams-admin-token-id-${t.id}`))).toBe(1);
        expect(await lines(page.getByTestId('cams-admin-fingerprint'))).toBeLessThanOrEqual(width < 600 ? 4 : 2);
        // Recent commands: time · command · result on one line, the actor below (two lines at most).
        for (const h of await heights(page.getByTestId('cams-admin-recent-row'))) expect(h).toBeLessThanOrEqual(width < 600 ? 60 : 40);
        for (const h of await heights(page.locator('[data-testid="cams-admin-recent-row"] .time'))) expect(h).toBeLessThanOrEqual(22);
        // A token row: no column squeezed to a character per line.
        for (const h of await heights(page.locator('[data-testid^="cams-admin-token-tok_"]'))) expect(h).toBeLessThanOrEqual(width < 600 ? 110 : 50);
      });

      test('the Certificates page', async ({ page }) => {
        await page.goto('/#/certificates');
        await expect(page.getByTestId('ca-fingerprint')).toContainText('SHA256:', { timeout: 15000 });
        await expect(page.getByTestId('cert-row-cam1')).toBeVisible();
        await shot(page, `certificates-${width}-${theme}`);
        await noHorizontalOverflow(page);
        expect(await lines(page.getByTestId('ca-fingerprint'))).toBeLessThanOrEqual(width < 600 ? 4 : 2);
        // Each group of four whole on its line.
        const groups = await page.getByTestId('ca-fingerprint').locator('.g').evaluateAll((els) => els.map((e) => e.getClientRects().length));
        expect(groups.every((n) => n === 1)).toBe(true);
        for (const id of ['cert-proxy-fingerprint', 'cert-fingerprint-cam1', 'cert-fingerprint-cam2']) expect(await lines(page.getByTestId(id))).toBe(1);
      });
    });
  }
}

test('the Details links and the navigation reach both pages', async ({ page }) => {
  await fixtures(page);
  await page.goto('/#/status');
  await page.getByTestId('certificates-details-link').click();
  await expect(page).toHaveURL(/#\/certificates$/);
  await expect(page.getByTestId('nav-certificates')).toHaveAttribute('aria-current', 'page');
  await page.getByTestId('nav-cams-admin').click();
  await expect(page).toHaveURL(/#\/cams-admin$/);
  await expect(page.getByTestId('page-cams-admin')).toBeVisible();
});
