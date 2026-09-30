import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { googleVision } from '../src/analytics/google-vision';
import { AnalyticsError } from '../src/analytics/providers';
import { startVisionMock, type VisionMock } from './helpers/vision-mock';

let mock: VisionMock;
beforeAll(async () => (mock = await startVisionMock({ key: 'k-123456789012' })));
afterAll(() => mock.close());
beforeEach(() => (mock.script = []));
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const call = (key = 'k-123456789012') => googleVision({ key, baseUrl: mock.url }).analyze(jpeg, AbortSignal.timeout(5000));
const fail = async (key?: string) => {
  try {
    await call(key);
  } catch (e) {
    return e as AnalyticsError;
  }
  throw new Error('no error');
};

describe('Google Vision provider', () => {
  it('sends the key in a header, never the URL, and asks for objects only', async () => {
    await call();
    expect(mock.lastKeyHeader).toBe('k-123456789012');
    expect(mock.lastUrl).toBe('/v1/images:annotate');
    expect(mock.lastUrl).not.toContain('k-123456789012');
    const req = mock.lastBody as { requests?: Array<{ features?: unknown }> } | undefined;
    expect(req?.requests?.[0]?.features).toEqual([{ type: 'OBJECT_LOCALIZATION', maxResults: 20 }]);
  });

  it('maps objects to name, score and box (fractions), missing coordinates as 0', async () => {
    mock.script = [{ objects: [{ name: 'Car', score: 0.81, vertices: [{ y: 0.38 }, { x: 0.55, y: 0.38 }, { x: 0.55, y: 0.65 }, { x: 0.27, y: 0.65 }] }] }];
    const r = await call();
    expect(r.objects).toEqual([{ name: 'Car', score: 0.81, box: { x0: 0, y0: 0.38, x1: 0.55, y1: 0.65 } }]);
    expect(r.raw).toEqual({ localizedObjectAnnotations: expect.any(Array) });
  });

  it('answers no objects as an empty list', async () => {
    mock.script = [{ body: { responses: [{}] } }];
    expect((await call()).objects).toEqual([]);
  });

  it('treats missing vertices as a zero-area box', async () => {
    mock.script = [{ objects: [{ name: 'Empty', score: 0.5, vertices: [] }] }];
    const r = await call();
    expect(r.objects).toEqual([{ name: 'Empty', score: 0.5, box: { x0: 0, y0: 0, x1: 0, y1: 0 } }]);
  });

  it.each([
    [{ status: 403 }, 'bad_key', false, 'bad_key'],
    [{ status: 401 }, 'bad_key', false, 'bad_key'],
    [{ status: 400 }, 'bad_key', false, 'bad_key'],
    [{ status: 429 }, 'quota', false, 'quota'],
    [{ status: 503 }, 'http_5xx', true, null],
    [{ status: 418 }, 'http_418', false, null],
  ])('maps %j to %s', async (answer, reason, retry, pause) => {
    mock.script = [answer];
    expect(await fail()).toMatchObject({ reason, retry, pause });
  });

  it('maps a wrong key (the mock refuses it) to bad_key', async () => {
    expect(await fail('wrong-key-0000')).toMatchObject({ reason: 'bad_key', pause: 'bad_key' });
  });

  // Review focus 5.
  it('treats an error inside responses[0] as a failure, not as nothing found', async () => {
    mock.script = [{ body: { responses: [{ error: { code: 3, message: 'Bad image data.' } }] } }];
    expect(await fail()).toMatchObject({ reason: 'bad_response', retry: false });
  });

  it('treats an unexpected body as bad_response', async () => {
    mock.script = [{ body: { hello: 1 } }];
    expect(await fail()).toMatchObject({ reason: 'bad_response' });
  });

  it('turns an abort into a retryable timeout', async () => {
    mock.script = [{ delayMs: 500 }];
    await expect(googleVision({ key: 'k-123456789012', baseUrl: mock.url }).analyze(jpeg, AbortSignal.timeout(50))).rejects.toMatchObject({ reason: 'timeout', retry: true });
  });

  it('turns an abort during body parsing into a retryable timeout', async () => {
    mock.script = [{ delayMs: 100, body: { responses: [{}] } }];
    await expect(googleVision({ key: 'k-123456789012', baseUrl: mock.url }).analyze(jpeg, AbortSignal.timeout(50))).rejects.toMatchObject({ reason: 'timeout', retry: true });
  });

  it('turns a refused connection into a retryable network error', async () => {
    await expect(googleVision({ key: 'k', baseUrl: 'http://127.0.0.1:9' }).analyze(jpeg, AbortSignal.timeout(2000))).rejects.toMatchObject({ reason: 'network', retry: true });
  });
});
