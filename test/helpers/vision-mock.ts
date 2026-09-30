import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

// A stand-in for Google Vision's images:annotate (spec: tests never call
// Google). Answers from `script` in order (the last one repeats); counts calls.
export type MockAnswer = {
  objects?: { name: string; score: number; vertices: { x?: number; y?: number }[] }[];
  status?: number;
  body?: unknown;
  delayMs?: number;
};
export interface VisionMock {
  url: string;
  calls: number;
  lastKeyHeader: string | undefined;
  lastUrl: string | undefined;
  script: MockAnswer[];
  close(): Promise<void>;
}

const PERSON = { name: 'Person', score: 0.9, vertices: [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.2 }, { x: 0.4, y: 0.9 }, { x: 0.1, y: 0.9 }] };

export async function startVisionMock(o: { key?: string } = {}): Promise<VisionMock> {
  const key = o.key ?? 'mock-vision-key-000000';
  let server: Server;
  const mock: VisionMock = {
    url: '',
    calls: 0,
    lastKeyHeader: undefined,
    lastUrl: undefined,
    script: [],
    close: () => new Promise((r) => server.close(() => r())),
  };
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      mock.calls++;
      mock.lastUrl = req.url;
      mock.lastKeyHeader = req.headers['x-goog-api-key'] as string | undefined;
      const answer = mock.script.length > 1 ? mock.script.shift()! : (mock.script[0] ?? {});
      if (answer.delayMs) await new Promise((r) => setTimeout(r, answer.delayMs));
      if (req.method !== 'POST' || req.url !== '/v1/images:annotate') return void res.writeHead(404).end();
      if (mock.lastKeyHeader !== key) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'API key not valid.' } }));
      }
      const status = answer.status ?? 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      if (answer.body !== undefined) return void res.end(JSON.stringify(answer.body));
      if (status !== 200) return void res.end(JSON.stringify({ error: { code: status, status: 'ERROR', message: 'mock error' } }));
      const objects = answer.objects ?? [PERSON];
      res.end(JSON.stringify({ responses: [{ localizedObjectAnnotations: objects.map((x) => ({ name: x.name, score: x.score, boundingPoly: { normalizedVertices: x.vertices } })) }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return mock;
}
