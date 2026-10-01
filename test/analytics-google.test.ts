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
    const before = mock.calls;
    await call();
    expect(mock.calls).toBe(before + 1); // one request per analysis
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

  it('passes Google\'s mid through, and leaves it out when there is none', async () => {
    mock.script = [{ objects: [{ mid: '/m/0k4j', name: 'Car', score: 0.8, vertices: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }] }, { name: 'Dog', score: 0.7, vertices: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }] }] }];
    const r = await call();
    expect(r.objects[0]?.mid).toBe('/m/0k4j');
    expect(r.objects[1]).not.toHaveProperty('mid');
  });

  it('answers no objects as an empty list', async () => {
    mock.script = [{ body: { responses: [{}] } }];
    expect((await call()).objects).toEqual([]);
  });

  // Issue #52: a score that isn't a number or a missing name isn't a detection.
  it('drops annotations without a numeric score or a name', async () => {
    mock.script = [{ body: { responses: [{ localizedObjectAnnotations: [
      { name: 'Person', score: '0.9', boundingPoly: { normalizedVertices: [{ x: 0.1, y: 0.1 }] } },
      { score: 0.8, boundingPoly: { normalizedVertices: [{ x: 0.1, y: 0.1 }] } },
      { name: '', score: 0.8, boundingPoly: { normalizedVertices: [{ x: 0.1, y: 0.1 }] } },
      { name: 'Dog', score: 0.7, boundingPoly: { normalizedVertices: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 }] } },
    ] }] } }];
    const r = await call();
    expect(r.objects).toEqual([{ name: 'Dog', score: 0.7, box: { x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3 } }]);
    expect((r.raw as { localizedObjectAnnotations: unknown[] }).localizedObjectAnnotations).toHaveLength(4); // the raw answer stays whole
  });

  it('the test mock refuses a script that is not JSON, and keeps serving', async () => {
    const r = await fetch(`${mock.url}/script`, { method: 'POST', body: '{not json' });
    expect(r.status).toBe(400);
    expect((await call()).objects).toHaveLength(1);
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
    [{ status: 500 }, 'http_5xx', true, null],
    [{ status: 502 }, 'http_5xx', true, null],
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
    mock.script = [{ bodyDelayMs: 500, body: { responses: [{}] } }];
    await expect(googleVision({ key: 'k-123456789012', baseUrl: mock.url }).analyze(jpeg, AbortSignal.timeout(100))).rejects.toMatchObject({ reason: 'timeout', retry: true });
  });

  it('turns a refused connection into a retryable network error', async () => {
    await expect(googleVision({ key: 'k', baseUrl: 'http://127.0.0.1:9' }).analyze(jpeg, AbortSignal.timeout(2000))).rejects.toMatchObject({ reason: 'network', retry: true });
  });
});
