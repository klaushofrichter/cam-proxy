import { test, expect, type APIRequestContext } from '@playwright/test';
import { ADMIN_TOKEN, CLIENT_TOKEN, PROXY_PORT, VISION_MOCK_PORT } from './env';

// Still checks (cams #179): a second checked through the client API against
// the vision mock (never Google), the stream message, the stored answer, the
// list and the image; the setting in the admin UI.
const client = { Authorization: `Bearer ${CLIENT_TOKEN}` };
const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const PERSON = { mid: '/m/01g317', name: 'Person', score: 0.9, vertices: [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.2 }, { x: 0.4, y: 0.9 }, { x: 0.1, y: 0.9 }] };
const calls = async (r: APIRequestContext) => (await (await r.get(`http://127.0.0.1:${VISION_MOCK_PORT}/calls`)).json()).calls as number;

test.describe.configure({ mode: 'serial' });

test.afterAll(async ({ request }) => {
  await request.put('/control/config', { headers: admin, data: { analytics: { googleVision: { enabled: false, monthlyLimit: 0, dailyCap: 0, checksPerDay: 10 } } } });
  await request.post(`http://127.0.0.1:${VISION_MOCK_PORT}/script`, { data: [] });
});

test('a still check through the API: 201, the stream message, then the stored answer', async ({ request }) => {
  const [cam] = (await (await request.get('/api/cameras', { headers: client })).json()) as { id: string }[];
  const base = `/api/cameras/${encodeURIComponent(cam.id)}`;
  // A still a few seconds old (the stills run from cam-sim's stream).
  let at = 0;
  await expect
    .poll(async () => {
      const now = Date.now();
      const list = (await (await request.get(`${base}/stills?from=${now - 60_000}&to=${now - 3000}`, { headers: client })).json()) as number[];
      at = list.at(-1) ?? 0;
      return at;
    }, { timeout: 30_000 })
    .toBeGreaterThan(0);

  expect((await request.put('/control/config', { headers: admin, data: { analytics: { googleVision: { enabled: true, monthlyLimit: 100, dailyCap: 0, checksPerDay: 10 } } } })).ok()).toBe(true);
  expect((await request.post(`http://127.0.0.1:${VISION_MOCK_PORT}/script`, { data: [{ objects: [PERSON] }] })).ok()).toBe(true);

  // The stream, opened before the check: its message must arrive.
  const ac = new AbortController();
  const stream = await fetch(`http://127.0.0.1:${PROXY_PORT}${'/api/stream'}?types=still-check`, { headers: client, signal: ac.signal });
  const reader = stream.body!.getReader();
  const message = (async () => {
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text;
      text += new TextDecoder().decode(value);
      if (/event: still-check\ndata: .*\n\n/.test(text)) return text;
    }
  })();

  const before = await calls(request);
  const r = await request.post(`${base}/still-checks`, { headers: client, data: { at } });
  expect(r.status()).toBe(201);
  const body = (await r.json()) as { reused: boolean; check: { id: number; stillTs: number; summary: { category: string }[]; imageUrl: string } };
  expect(body.reused).toBe(false);
  expect(body.check).toMatchObject({ stillTs: at, summary: [expect.objectContaining({ category: 'person' })] });
  expect(await calls(request)).toBe(before + 1);

  const text = await Promise.race([message, new Promise<string>((_, rej) => setTimeout(() => rej(new Error('no still-check message')), 10_000))]);
  ac.abort();
  const data = JSON.parse(/event: still-check\ndata: (.*)\n/.exec(text)![1]) as { id: number; stillTs: number; cam: string };
  expect(data).toMatchObject({ id: body.check.id, stillTs: at, cam: cam.id });

  // The same second again: the stored answer, no call.
  const again = await request.post(`${base}/still-checks`, { headers: client, data: { at } });
  expect(again.status()).toBe(200);
  expect(await again.json()).toMatchObject({ reused: true, source: 'check', check: { id: body.check.id } });
  expect(await calls(request)).toBe(before + 1);

  const list = (await (await request.get(`${base}/still-checks?from=${at}&to=${at}`, { headers: client })).json()) as { id: number }[];
  expect(list.map((x) => x.id)).toEqual([body.check.id]);
  const jpg = await request.get(body.check.imageUrl, { headers: client });
  expect(jpg.status()).toBe(200);
  expect(jpg.headers()['content-type']).toBe('image/jpeg');
  const usage = (await (await request.get(`${base}/analytics`, { headers: client })).json()) as { checks: { today: number; cap: number } };
  expect(usage.checks).toEqual({ today: expect.any(Number), cap: 10 });
  expect(usage.checks.today).toBeGreaterThanOrEqual(1);
});

test('the admin UI sets still checks per day', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('shell')).toBeVisible();
  await page.getByTestId('nav-settings').click();
  const field = page.getByTestId('analytics-checks');
  await expect(field).toHaveValue('10');
  await field.fill('1001');
  await expect(page.getByTestId('analytics-checks-hint')).toBeVisible();
  await expect(page.getByTestId('analytics-checks-save')).toBeDisabled();
  await field.fill('5');
  await page.getByTestId('analytics-checks-save').click();
  await expect(page.getByTestId('analytics-message')).toContainText('Still checks per day saved');
  const cfg = (await (await page.request.get('/control/config', { headers: admin })).json()) as Record<string, { value: unknown }>;
  expect(cfg['analytics.googleVision.checksPerDay'].value).toBe(5);
});
