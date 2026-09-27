import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import net from 'net';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { StreamLog } from '../src/stream/log';
import { sseHandler } from '../src/stream/sse';
import { sseConnect } from './helpers/sse';

let dir: string;
let catalog: Catalog;
let log: StreamLog;
let server: Server;
let base: string;
let handler: ReturnType<typeof sseHandler>;
const clients: { close(): void }[] = [];

async function serve(opts: Partial<{ maxClients: number; queuePerClient: number; pingS: number }> = {}) {
  handler = sseHandler(log, { maxClients: 50, queuePerClient: 1000, pingS: 15, ...opts });
  const app = express();
  app.get('/stream', handler);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const connect = (path = '/stream', headers: Record<string, string> = {}) => {
  const c = sseConnect(`${base}${path}`, headers);
  clients.push(c);
  return c;
};
const ev = (n: number, kind = 'person') => log.append('cam1', 'camera-event', { eventId: n, kind, phase: 'start', ts: n });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-sse-'));
  catalog = openCatalog(join(dir, 'catalog.sqlite'));
  log = new StreamLog(catalog);
});
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close());
  handler?.closeAll();
  await new Promise((r) => server?.close(() => r(undefined)) ?? r(undefined));
  catalog.close();
});

describe('stream log', () => {
  it('appends with increasing ids and reads back after an id, filtered', () => {
    const a = ev(1);
    const b = log.append('cam1', 'camera-status', { online: true });
    const c = ev(3, 'vehicle');
    expect([a.id, b.id, c.id]).toEqual([1, 2, 3]);
    expect(log.since(1, { types: ['camera-event'] }, 100).map((m) => m.id)).toEqual([3]);
    expect(log.since(0, { types: ['camera-event'], kinds: ['vehicle'] }, 100).map((m) => m.id)).toEqual([3]);
    expect(log.oldestId()).toBe(1);
    expect(log.lastId()).toBe(3);
  });
});

describe('SSE', () => {
  it('sends live messages in order, with id, event and data', async () => {
    await serve();
    const c = connect();
    await c.until(() => c.status() === 200);
    await new Promise((r) => setTimeout(r, 50));
    ev(1);
    ev(2);
    await c.until(() => c.events.length === 2);
    expect(c.events[0]).toEqual({ id: 1, event: 'camera-event', data: { cam: 'cam1', eventId: 1, kind: 'person', phase: 'start', ts: 1 } });
    expect(c.ids()).toEqual([1, 2]);
  });

  it('replays what was missed from Last-Event-ID or ?since, then continues live', async () => {
    await serve();
    for (let i = 1; i <= 5; i++) ev(i);
    const a = connect('/stream', { 'Last-Event-ID': '2' });
    const b = connect('/stream?since=3');
    await a.until(() => a.ids().length === 3);
    await b.until(() => b.ids().length === 2);
    ev(6);
    await a.until(() => a.ids().length === 4);
    expect(a.ids()).toEqual([3, 4, 5, 6]);
    await b.until(() => b.ids().length === 3);
    expect(b.ids()).toEqual([4, 5, 6]);
  });

  it('resumes across a restart with exactly the missed messages', async () => {
    await serve();
    for (let i = 1; i <= 3; i++) ev(i);
    handler.closeAll();
    catalog.close();
    catalog = openCatalog(join(dir, 'catalog.sqlite'));
    log = new StreamLog(catalog);
    for (let i = 4; i <= 6; i++) ev(i);
    await new Promise((r) => server.close(() => r(undefined)));
    await serve();
    const c = connect('/stream', { 'Last-Event-ID': '3' });
    await c.until(() => c.ids().length === 3);
    await new Promise((r) => setTimeout(r, 100));
    expect(c.ids()).toEqual([4, 5, 6]);
  });

  it('says reset when the resume point is past retention, then continues from the oldest', async () => {
    await serve();
    for (let i = 1; i <= 5; i++) ev(i);
    catalog.db.prepare('DELETE FROM stream_log WHERE id <= 3').run();
    const c = connect('/stream', { 'Last-Event-ID': '1' });
    await c.until(() => c.events.length === 3);
    expect(c.events[0]).toEqual({ event: 'reset', data: { oldestId: 4 } });
    expect(c.ids()).toEqual([4, 5]);
  });

  it('filters by type and kind, and sends stills only when asked', async () => {
    await serve();
    const all = connect('/stream');
    const people = connect('/stream?types=camera-event&kinds=person');
    const stills = connect('/stream?types=still');
    await all.until(() => all.status() === 200);
    await people.until(() => people.status() === 200);
    await stills.until(() => stills.status() === 200);
    await new Promise((r) => setTimeout(r, 50));
    ev(1, 'vehicle');
    log.append('cam1', 'still', { ts: 1 });
    ev(3, 'person');
    await all.until(() => all.ids().length === 2);
    await people.until(() => people.ids().length === 1);
    await stills.until(() => stills.ids().length === 1);
    expect(all.ids()).toEqual([1, 3]);
    expect(people.ids()).toEqual([3]);
    expect(stills.ids()).toEqual([2]);
  });

  it('pings idle clients and sets the headers proxies need', async () => {
    await serve({ pingS: 0.05 as unknown as number });
    const res = await fetch(`${base}/stream`);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    await res.body?.cancel();
    const c = connect();
    await c.until(() => c.comments.some((l) => l.startsWith(': ping')));
    expect(c.comments[0]).toBe(': ping');
  });

  it('drops a client that stops reading, while others get everything', async () => {
    await serve({ queuePerClient: 20 });
    const fast = connect();
    // A raw socket that sends the request and never reads the response.
    const port = (server.address() as AddressInfo).port;
    const slow = net.connect(port, '127.0.0.1', () => slow.write('GET /stream HTTP/1.1\r\nHost: x\r\n\r\n'));
    slow.pause();
    await fast.until(() => fast.status() === 200);
    await new Promise((r) => setTimeout(r, 100));
    expect(handler.clients()).toBe(2);
    const big = 'x'.repeat(4000);
    // Bursts of 10 with a turn of the event loop between them: far faster
    // than a camera produces events, but the fast client can keep up.
    for (let i = 1; i <= 2000; i++) {
      log.append('cam1', 'camera-event', { eventId: i, kind: 'motion', pad: big });
      if (i % 10 === 0) await new Promise((r) => setImmediate(r));
    }
    await fast.until(() => fast.ids().length === 2000, 15000);
    await fast.until(() => handler.clients() === 1, 10000);
    slow.destroy();
    expect(fast.ids()[1999]).toBe(2000);
  }, 30000);

  it('refuses clients past the limit with 503', async () => {
    await serve({ maxClients: 1 });
    const a = connect();
    await a.until(() => a.status() === 200);
    const res = await fetch(`${base}/stream`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'too_many_clients' });
  });

  it('closeAll ends every stream', async () => {
    await serve();
    const c = connect();
    await c.until(() => c.status() === 200);
    handler.closeAll();
    await c.until(() => c.ended());
    expect(handler.clients()).toBe(0);
  });
});
