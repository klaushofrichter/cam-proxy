import http from 'http';

export interface SseEvent { id?: number; event?: string; data?: unknown }

// A minimal SSE client for tests: collects events and comment lines.
export function sseConnect(url: string, headers: Record<string, string> = {}) {
  const events: SseEvent[] = [];
  const comments: string[] = [];
  let status = 0;
  let ended = false;
  let res: http.IncomingMessage | undefined;
  const req = http.get(url, { headers }, (r) => {
    res = r;
    status = r.statusCode ?? 0;
    r.setEncoding('utf8');
    let buf = '';
    r.on('data', (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev: SseEvent = {};
        let isEvent = false;
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) comments.push(line);
          else if (line.startsWith('id: ')) ((ev.id = Number(line.slice(4))), (isEvent = true));
          else if (line.startsWith('event: ')) ((ev.event = line.slice(7)), (isEvent = true));
          else if (line.startsWith('data: ')) ((ev.data = JSON.parse(line.slice(6))), (isEvent = true));
        }
        if (isEvent) events.push(ev);
      }
    });
    r.on('end', () => (ended = true));
    r.on('close', () => (ended = true));
  });
  req.on('error', () => (ended = true));
  const until = async (cond: () => boolean, ms = 5000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error(`timed out; events=${events.length} status=${status} ended=${ended}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return {
    events,
    comments,
    status: () => status,
    ended: () => ended,
    ids: () => events.filter((e) => e.id !== undefined).map((e) => e.id!),
    until,
    close: () => (req.destroy(), res?.destroy()),
  };
}
