import { test, expect, type Page, type Route } from '@playwright/test';
import { ADMIN_TOKEN } from './env';

// Moving a camera to another proxy (camera-move plan Task 11). The e2e proxy
// has no site CA, so it would refuse every move: the control routes of the
// move are answered here, as the source proxy would after cams-admin's answer
// (the real exchange is in test/move-source*.test.ts). What the page sends is
// recorded and checked.
const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const REQ = 'rq_0123456789ABCDEFGHJK';
const MOVE = 'mv_0123456789ABCDEFGHJK';
const TARGET = { proxyId: 'prx_0123456789ABCDEFGHJK', name: 'Shed', site: 'e2e' };
const GB = 1024 ** 3;
const kind = (files: number, bytes: number) => ({ files, bytes, rows: 0, oldest: files ? 1_760_000_000_000 : null, newest: files ? 1_760_900_000_000 : null });
const summary = { stills: kind(10, 4 * GB), clips: kind(5, 2 * GB), events: kind(0, 0), checks: kind(0, 0), archive: kind(0, 0) };

interface Mock { list: Record<string, unknown>[]; posted: { path: string; body: unknown }[] }

async function mockMoves(page: Page, mock: Mock) {
  await page.route('**/control/moves**', async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() === 'GET' && path === '/control/moves') return json(200, { items: mock.list });
    if (req.method() === 'GET' && path.startsWith('/control/moves/targets/')) return json(200, { targets: [TARGET] });
    mock.posted.push({ path, body: req.postDataJSON() });
    if (path === '/control/moves/targets') return json(202, { requestId: REQ });
    if (path === '/control/moves') return json(202, { requestId: REQ });
    return json(202, {});
  });
}

const cameraId = async (request: import('@playwright/test').APIRequestContext) => ((await (await request.get('/control/status', { headers: admin })).json()) as { cameras: { id: string }[] }).cameras[0].id;

test('move dialog → rejected reason shown', async ({ page, request }) => {
  const cam = await cameraId(request);
  const mock: Mock = { list: [], posted: [] };
  await mockMoves(page, mock);
  await page.goto('/#/settings');
  await page.getByTestId('move-open').click();
  await expect(page.getByTestId('move-target')).toBeVisible({ timeout: 15000 });
  mock.list = [{ requestId: REQ, camera: cam, target: { proxyId: TARGET.proxyId, name: 'Shed' }, phase: 'rejected', answer: { accept: false, reason: 'camera_limit' }, settings: {}, summary, plan: null, budgetExceeded: false }];
  await page.getByTestId('move-continue').click();
  await expect(page.getByTestId('move-rejected')).toHaveText("Shed can't take this camera: it already has as many cameras as it may", { timeout: 15000 });
  expect(mock.posted.find((p) => p.path === '/control/moves')?.body).toEqual({ camera: cam, target: TARGET.proxyId });
});

test('move dialog → panel → approve emits move.approve', async ({ page, request }) => {
  const cam = await cameraId(request);
  const offer = {
    id: MOVE, requestId: REQ, camera: cam, target: { proxyId: TARGET.proxyId, name: 'Shed' }, phase: 'awaiting-approval',
    answer: { accept: true, estimateS: 540, space: { needed: 6 * GB, available: 3 * GB, fits: false, perKind: {}, retentionProposal: { 'stills.maxGB': 90, 'storage.maxBytes': 200 * GB } } },
    settings: { stills: { intervalS: 60 } }, summary, plan: null, budgetExceeded: false,
  };
  const mock: Mock = { list: [], posted: [] };
  await mockMoves(page, mock);
  await page.goto('/#/settings');
  await page.getByTestId('move-open').click();
  await expect(page.getByTestId('move-target')).toBeVisible({ timeout: 15000 });
  mock.list = [{ ...offer, phase: 'requested', answer: undefined }];
  await page.getByTestId('move-continue').click();
  await expect(page.getByTestId('move-asking')).toHaveText('Asking Shed…');
  mock.list = [offer];
  const panel = page.getByTestId('move-panel');
  await expect(panel).toBeVisible({ timeout: 15000 });
  await expect(panel).toContainText('Settings that move with the camera');
  await expect(page.getByTestId('move-short')).toHaveText('Not everything fits on Shed (6.0 GB needed, 3.0 GB free).');
  await expect(page.getByTestId('move-kind-events')).toHaveCount(0);
  await page.getByTestId('move-option-retention').check();
  await expect(page.getByTestId('move-limits')).toContainText('stills.maxGB: 90 GB');
  await expect(page.getByTestId('move-limits')).toContainText('storage.maxBytes: 200.0 GB');
  await expect(page.getByTestId('move-estimate')).toHaveText('Estimated time: 9 min');
  // A budget below the estimate is refused before it is sent.
  await page.getByTestId('move-budget').fill('5');
  await expect(page.getByTestId('move-approve')).toBeDisabled();
  await page.getByTestId('move-budget').fill('12');
  mock.list = [{ ...offer, phase: 'switching', plan: {} }];
  await page.getByTestId('move-approve').click();
  await expect.poll(() => mock.posted.find((p) => p.path === `/control/moves/${MOVE}/approve`)?.body).toEqual({
    plan: { transfer: true, kinds: ['stills', 'clips'], space: 'retention', targetSettings: { 'stills.maxGB': 90, 'storage.maxBytes': 200 * GB }, budgetS: 720, estimateS: 540 },
  });
  await page.goto('/#/status');
  await expect(page.getByTestId('move-status')).toHaveText(/^Moving .+ to Shed: switching over$/, { timeout: 15000 });
});

test('the status card of a copying move, and its cancel choice', async ({ page, request }) => {
  const cam = await cameraId(request);
  const copying = { id: MOVE, requestId: REQ, camera: cam, target: { proxyId: TARGET.proxyId, name: 'Shed' }, phase: 'copying', settings: {}, summary, plan: {}, budgetExceeded: true, progress: { bytesDone: GB, bytesTotal: 4 * GB, rateBps: 1e6, etaS: 600 } };
  const mock: Mock = { list: [copying], posted: [] };
  await mockMoves(page, mock);
  await page.goto('/#/status');
  await expect(page.getByTestId('move-status')).toHaveText(/ to Shed: copying, 1\.0 GB of 4\.0 GB \(25%\), about 10 min left$/, { timeout: 15000 });
  await expect(page.getByTestId('move-over-budget')).toHaveText('Over the time budget; still copying');
  await page.getByTestId('move-cancel').click();
  await expect(page.getByTestId('move-copied-hint')).toContainText('stays and ages out');
  await page.getByTestId('move-copied-delete').check();
  await page.getByTestId('move-cancel-confirm').click();
  await expect.poll(() => mock.posted.find((p) => p.path === `/control/moves/${MOVE}/cancel`)?.body).toEqual({ copied: 'delete' });
});

test('a failed move shows its reason; a switching move disables the certificate push', async ({ page, request }) => {
  const cam = await cameraId(request);
  const base = { id: MOVE, requestId: REQ, camera: cam, target: { proxyId: TARGET.proxyId, name: 'Shed' }, settings: {}, summary, plan: {}, budgetExceeded: false };
  const mock: Mock = { list: [{ ...base, phase: 'failed', failure: 'cert_failed' }], posted: [] };
  await mockMoves(page, mock);
  await page.goto('/#/status');
  await expect(page.getByTestId('move-status')).toHaveText(/ to Shed: failed, the certificate could not be handed over$/, { timeout: 15000 });
  mock.list = [{ ...base, phase: 'switching' }];
  // The e2e proxy has no site CA: a certificates view with one, for the push button.
  await page.route('**/control/tls', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ site: 'e2e', caFingerprint: null, caNotAfter: null, proxy: null, cameras: [{ id: cam, mode: 'site-ca', notAfter: null, lastPush: null, servername: null, fingerprint: null, problem: null }], problems: [] }) }));
  await page.goto('/#/certificates');
  await expect(page.getByTestId(`cert-switching-${cam}`)).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId(`cert-push-${cam}`)).toBeDisabled();
});
