import { EventEmitter } from 'events';
import type { Catalog } from '../catalog/db';

export const STREAM_TYPES = ['camera-event', 'camera-status', 'clip', 'annotation', 'still', 'analysis', 'camera', 'still-check', 'archive'] as const;
export type StreamType = (typeof STREAM_TYPES)[number];

export interface StreamMessage {
  id: number; // the SSE id: monotonic, never reused (AUTOINCREMENT)
  ts: number;
  cam: string;
  type: StreamType;
  data: Record<string, unknown>;
}

export interface Filter {
  cam?: string;
  types: StreamType[];
  kinds?: string[]; // matches data.kind
}

type Row = { id: number; ts: number; cam: string; type: StreamType; data: string };
const fromRow = (r: Row): StreamMessage => ({ ...r, data: JSON.parse(r.data) });

// Everything clients may care about is written here first, then pushed:
// 'message' is emitted after the row is stored, so a resume never misses it.
export class StreamLog extends EventEmitter {
  constructor(
    private readonly c: Catalog,
    private readonly now: () => number = Date.now,
  ) {
    super();
    this.setMaxListeners(0);
  }

  append(cam: string, type: StreamType, data: Record<string, unknown>): StreamMessage {
    const r = this.c.db.prepare('INSERT INTO stream_log (ts, cam, type, data) VALUES (?, ?, ?, ?) RETURNING *').get(this.now(), cam, type, JSON.stringify(data)) as Row;
    const m = fromRow(r);
    this.emit('message', m);
    return m;
  }

  since(id: number, f: Filter, limit: number): StreamMessage[] {
    const where = ['id > ?', `type IN (${f.types.map(() => '?').join(',')})`];
    const args: (string | number)[] = [id, ...f.types];
    if (f.cam) (where.push('cam = ?'), args.push(f.cam));
    if (f.kinds?.length) (where.push(`json_extract(data, '$.kind') IN (${f.kinds.map(() => '?').join(',')})`), args.push(...f.kinds));
    const rows = this.c.db.prepare(`SELECT * FROM stream_log WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`).all(...args, limit) as Row[];
    return rows.map(fromRow);
  }

  // The newest message of a type for a camera (the last camera name told), or undefined.
  latest(cam: string, type: StreamType): StreamMessage | undefined {
    const r = this.c.db.prepare('SELECT * FROM stream_log WHERE cam = ? AND type = ? ORDER BY id DESC LIMIT 1').get(cam, type) as Row | undefined;
    return r && fromRow(r);
  }

  oldestId(): number | null {
    return (this.c.db.prepare('SELECT MIN(id) AS id FROM stream_log').get() as { id: number | null }).id;
  }

  lastId(): number {
    const r = this.c.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'stream_log'").get() as { seq: number } | undefined;
    return r?.seq ?? 0;
  }

  count(): number {
    return (this.c.db.prepare('SELECT COUNT(*) AS n FROM stream_log').get() as { n: number }).n;
  }

  deleteBefore(ts: number): number {
    return Number(this.c.db.prepare('DELETE FROM stream_log WHERE ts < ?').run(ts).changes);
  }
}

export function matches(m: StreamMessage, f: Filter): boolean {
  if (!f.types.includes(m.type)) return false;
  if (f.cam && m.cam !== f.cam) return false;
  if (f.kinds?.length && !f.kinds.includes(String(m.data.kind))) return false;
  return true;
}
