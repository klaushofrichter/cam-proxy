import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

// A stand-in for Google Vision's images:annotate (spec: tests never call
// Google). Answers from `script` in order (the last one repeats); counts calls.
export type MockAnswer = {
  objects?: { mid?: string; name: string; score: number; vertices: { x?: number; y?: number }[] }[];
  status?: number;
  body?: unknown;
  delayMs?: number;
  bodyDelayMs?: number;
};
export interface VisionMock {
  url: string;
  calls: number;
  lastKeyHeader: string | undefined;
  lastUrl: string | undefined;
  lastBody: unknown;
  script: MockAnswer[];
  close(): Promise<void>;
}

const PERSON = { mid: '/m/01g317', name: 'Person', score: 0.9, vertices: [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.2 }, { x: 0.4, y: 0.9 }, { x: 0.1, y: 0.9 }] };

// The answer's body: as scripted, an error for a non-200 status, else the objects (a person by default).
function bodyOf(answer: MockAnswer, status: number): unknown {
  if (answer.body !== undefined) return answer.body;
  if (status !== 200) return { error: { code: status, status: 'ERROR', message: 'mock error' } };
  const annotations = (answer.objects ?? [PERSON]).map((x) => ({ ...(x.mid ? { mid: x.mid } : {}), name: x.name, score: x.score, boundingPoly: { normalizedVertices: x.vertices } }));
  return { responses: [{ localizedObjectAnnotations: annotations }] };
}

export async function startVisionMock(o: { key?: string; port?: number } = {}): Promise<VisionMock> {
  const key = o.key ?? 'mock-vision-key-000000';
  const timers = new Set<NodeJS.Timeout>();
  let server: Server;
  const mock: VisionMock = {
    url: '',
    calls: 0,
    lastKeyHeader: undefined,
    lastUrl: undefined,
    lastBody: undefined,
    script: [],
    close: () =>
      new Promise<void>((r) => {
        for (const t of timers) clearTimeout(t);
        timers.clear();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
  server = createServer((req, res) => {
    // The e2e tests read the call count here (not counted as a call).
    if (req.method === 'GET' && req.url === '/calls') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ calls: mock.calls }));
    }
    // The e2e tests set the answers here (an empty list restores the default person); not counted as a call.
    if (req.method === 'POST' && req.url === '/script') {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        try {
          mock.script = JSON.parse(b) as MockAnswer[];
        } catch {
          return void res.writeHead(400).end();
        }
        res.writeHead(204).end();
      });
      return;
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      mock.calls++;
      mock.lastUrl = req.url;
      mock.lastKeyHeader = req.headers['x-goog-api-key'] as string | undefined;
      try {
        mock.lastBody = JSON.parse(body);
      } catch {
        mock.lastBody = undefined;
      }
      const answer = mock.script.length > 1 ? mock.script.shift()! : (mock.script[0] ?? {});
      if (answer.delayMs) await new Promise((r) => setTimeout(r, answer.delayMs));
      if (req.method !== 'POST' || req.url !== '/v1/images:annotate') return void res.writeHead(404).end();
      if (mock.lastKeyHeader !== key) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'API key not valid.' } }));
      }
      const status = answer.status ?? 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      const responseBody = JSON.stringify(bodyOf(answer, status));
      if (answer.bodyDelayMs) {
        res.write('{');
        await new Promise<void>((r) => {
          const t = setTimeout(() => (timers.delete(t), r()), answer.bodyDelayMs);
          timers.add(t);
          res.once('close', () => (clearTimeout(t), timers.delete(t), r()));
        });
        if (!res.destroyed) res.end(responseBody.slice(1));
      } else {
        res.end(responseBody);
      }
    });
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, '127.0.0.1', () => r()));
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return mock;
}
