import type { Request, RequestHandler, Response } from 'express';
import { STREAM_TYPES, matches, type Filter, type StreamLog, type StreamMessage, type StreamType } from './log';

export interface SseOptions { maxClients: number; queuePerClient: number; pingS: number }
export interface SseStats { messages: Record<string, number>; replayed: number; dropped: number }

const PAGE = 500;
const BLOCKED_MS = 5000; // a client whose socket stays full this long is dropped
const list = (v: unknown) => (typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

function filterFrom(req: Request): Filter | string {
  const types = list(req.query.types) ?? STREAM_TYPES.filter((t) => t !== 'still');
  const bad = types.find((t) => !(STREAM_TYPES as readonly string[]).includes(t));
  if (bad) return `unknown type: ${bad}`;
  const cam = typeof req.query.cam === 'string' ? req.query.cam : undefined;
  return { types: types as StreamType[], cam, kinds: list(req.query.kinds) };
}

function resumeFrom(req: Request): number | undefined {
  const raw = req.get('last-event-id') ?? (typeof req.query.since === 'string' ? req.query.since : undefined);
  return raw !== undefined && /^\d{1,15}$/.test(raw) ? Number(raw) : undefined;
}

const frame = (m: StreamMessage) => `id: ${m.id}\nevent: ${m.type}\ndata: ${JSON.stringify({ cam: m.cam, ...m.data })}\n\n`;

// GET handler for the SSE stream: replay from Last-Event-ID / ?since, then
// live. Each client has a bounded queue; one that can't keep up is dropped and
// resumes from its Last-Event-ID without losing anything.
export function sseHandler(log: StreamLog, opts: SseOptions): RequestHandler & { clients(): number; closeAll(): void; stats(): SseStats; setOptions(o: Partial<SseOptions>): void } {
  const o = { ...opts };
  const open = new Set<Response>();
  const stats: SseStats = { messages: {}, replayed: 0, dropped: 0 };

  const handler = ((req: Request, res: Response) => {
    const filter = filterFrom(req);
    if (typeof filter === 'string') return void res.status(400).json({ error: 'invalid', detail: filter });
    if (open.size >= o.maxClients) return void res.status(503).json({ error: 'too_many_clients' });

    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.flushHeaders();
    open.add(res);
    req.socket.setNoDelay(true);

    const queue: string[] = [];
    let waitingDrain = false;
    let blockedTimer: NodeJS.Timeout | undefined;
    let lastSent = 0;
    let replaying = true;
    const pending: StreamMessage[] = [];

    const drop = () => {
      stats.dropped++;
      res.destroy();
    };
    const pump = () => {
      while (queue.length && !waitingDrain && !res.destroyed) {
        if (!res.write(queue.shift()!)) {
          waitingDrain = true;
          blockedTimer = setTimeout(drop, BLOCKED_MS);
          res.once('drain', () => {
            waitingDrain = false;
            clearTimeout(blockedTimer);
            pump();
          });
        }
      }
    };
    const send = (m: StreamMessage) => {
      if (m.id <= lastSent) return;
      lastSent = m.id;
      stats.messages[m.type] = (stats.messages[m.type] ?? 0) + 1;
      queue.push(frame(m));
      if (queue.length > o.queuePerClient) return drop();
      pump();
    };
    const onMessage = (m: StreamMessage) => {
      if (!matches(m, filter)) return;
      if (replaying) pending.push(m);
      else send(m);
    };
    log.on('message', onMessage);
    const ping = setInterval(() => {
      queue.push(': ping\n\n');
      pump();
    }, o.pingS * 1000);

    res.on('close', () => {
      log.off('message', onMessage);
      clearInterval(ping);
      clearTimeout(blockedTimer);
      open.delete(res);
    });

    res.write('retry: 3000\n\n');
    const since = resumeFrom(req);
    if (since !== undefined) {
      let cursor = since;
      const oldest = log.oldestId();
      if (oldest !== null && oldest > since + 1) {
        queue.push(`event: reset\ndata: ${JSON.stringify({ oldestId: oldest })}\n\n`);
        cursor = oldest - 1;
      }
      const end = log.lastId();
      for (;;) {
        const page = log.since(cursor, filter, PAGE).filter((m) => m.id <= end);
        for (const m of page) send(m);
        stats.replayed += page.length;
        if (page.length < PAGE || res.destroyed) break;
        cursor = page[page.length - 1].id;
      }
      lastSent = Math.max(lastSent, end);
    } else {
      lastSent = log.lastId();
    }
    replaying = false;
    for (const m of pending.splice(0)) send(m);
    pump();
  }) as unknown as RequestHandler & { clients(): number; closeAll(): void; stats(): SseStats; setOptions(o: Partial<SseOptions>): void };

  handler.clients = () => open.size;
  handler.closeAll = () => {
    for (const res of open) res.end();
  };
  handler.stats = () => ({ ...stats, messages: { ...stats.messages } });
  handler.setOptions = (next) => Object.assign(o, next);
  return handler;
}
