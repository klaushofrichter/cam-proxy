// Forward-only schema migrations; each runs in one transaction. Never edit a
// released migration: add a new one.
export const MIGRATIONS: string[] = [
  // 1: events, annotations (filled in a later phase), clips, stream_log.
  `
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    cam TEXT NOT NULL,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER,
    end_reason TEXT,
    raw TEXT
  );
  CREATE INDEX events_cam_start ON events (cam, start_ts);
  CREATE TABLE annotations (
    id INTEGER PRIMARY KEY,
    cam TEXT NOT NULL,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    value TEXT,
    confidence REAL,
    model TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX annotations_kind_start ON annotations (kind, start_ts);
  CREATE INDEX annotations_source_start ON annotations (source, start_ts);
  CREATE TABLE clips (
    id INTEGER PRIMARY KEY,
    cam TEXT NOT NULL,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER,
    path TEXT NOT NULL,
    stream TEXT NOT NULL,
    size INTEGER NOT NULL,
    received_at INTEGER NOT NULL
  );
  CREATE INDEX clips_cam_start ON clips (cam, start_ts);
  CREATE TABLE stream_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    cam TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX stream_log_ts ON stream_log (ts);
  `,
];
