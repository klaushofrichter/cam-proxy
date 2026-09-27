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
    let cursor = 0; // replay position
    let replayEnd = 0; // the last id that existed when the client connected
    const pending: StreamMessage[] = []; // live messages that arrive during replay

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
      // Replay continues only as the client reads (never a whole backlog at once).
      if (replaying && !waitingDrain && queue.length === 0 && !res.destroyed) replayMore();
    };
    const push = (m: StreamMessage) => {
      if (m.id <= lastSent) return;
      lastSent = m.id;
      stats.messages[m.type] = (stats.messages[m.type] ?? 0) + 1;
      queue.push(frame(m));
    };
    // Live: the queue is bounded; a client that can't keep up is dropped and
    // resumes from its Last-Event-ID.
    const send = (m: StreamMessage) => {
      push(m);
      if (queue.length > o.queuePerClient) return drop();
      pump();
    };
    const replayMore = () => {
      const page = log.since(cursor, filter, PAGE).filter((m) => m.id <= replayEnd);
      for (const m of page) push(m);
      stats.replayed += page.length;
      if (page.length) cursor = page[page.length - 1].id;
      if (page.length < PAGE || cursor >= replayEnd) {
        replaying = false;
        lastSent = Math.max(lastSent, replayEnd);
        for (const m of pending.splice(0)) push(m);
      }
      if (queue.length) pump();
    };
    const onMessage = (m: StreamMessage) => {
      if (!matches(m, filter)) return;
      if (!replaying) return send(m);
      pending.push(m);
      // A client that stays in replay while live traffic piles up resumes later.
      if (pending.length > o.queuePerClient * 10) drop();
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
    replayEnd = log.lastId();
    if (since === undefined) {
      lastSent = replayEnd; // live only
      replaying = false;
      return;
    }
    const oldest = log.oldestId();
    const reset = (oldestId: number | null, from: number) => {
      queue.push(`event: reset\ndata: ${JSON.stringify({ oldestId })}\n\n`);
      cursor = from;
    };
    if (since > replayEnd) reset(oldest, (oldest ?? replayEnd + 1) - 1); // the ids started over (catalog reset)
    else if (oldest === null && since < replayEnd) reset(null, replayEnd); // everything after it was deleted
    else if (oldest !== null && oldest > since + 1) reset(oldest, oldest - 1); // past retention
    else cursor = since;
    lastSent = cursor;
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
