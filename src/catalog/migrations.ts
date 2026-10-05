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
  // 2: a clip's snapshot (the camera uploads a JPEG with each clip).
  `
  ALTER TABLE clips ADD COLUMN snapshot TEXT;
  CREATE INDEX clips_path ON clips (path);
  `,
  // 3: external analytics (spec 2026-09-30-analytics-design): one result per
  // event and provider, deleted with its event; calls per provider per day.
  `
  CREATE TABLE analyses (
    id INTEGER PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    still_ts INTEGER,
    image TEXT,
    requested_at INTEGER NOT NULL,
    took_ms INTEGER,
    objects TEXT,
    raw TEXT,
    UNIQUE (event_id, provider)
  );
  CREATE TABLE analytics_usage (
    provider TEXT NOT NULL,
    day TEXT NOT NULL,
    calls INTEGER NOT NULL,
    PRIMARY KEY (provider, day)
  );
  `,
  // 4: the analytics summary (spec 2026-09-30-analytics-in-cams-design): the
  // persons, vehicles and pets of an analysis; objects that didn't map.
  `
  ALTER TABLE analyses ADD COLUMN summary TEXT;
  CREATE TABLE analytics_unmapped (
    key TEXT PRIMARY KEY,
    mid TEXT NOT NULL,
    name TEXT NOT NULL,
    count INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  `,
  // 5: when the newest clip of each camera arrived (#93): kept when
  // retention deletes the clip, so "no clip for N hours" and "clips were
  // received before" outlive the clips themselves. Filled by a trigger on
  // every new clip, and here from the clips kept.
  `
  CREATE TABLE clip_arrivals (
    cam TEXT PRIMARY KEY,
    last_received INTEGER NOT NULL
  );
  INSERT INTO clip_arrivals (cam, last_received) SELECT cam, MAX(received_at) FROM clips GROUP BY cam;
  CREATE TRIGGER clips_last_received AFTER INSERT ON clips BEGIN
    INSERT INTO clip_arrivals (cam, last_received) VALUES (NEW.cam, NEW.received_at)
      ON CONFLICT (cam) DO UPDATE SET last_received = MAX(last_received, excluded.last_received);
  END;
  `,
  // 6: where a clip came from (spec 2026-10-02-inventory-design §4, #74):
  // 'ftp' (the camera's upload) or 'camera' (fetched from the SD card by an
  // inventory repair). Only FTP clips count as arrivals: a repaired clip must
  // not hide an FTP stall (#93).
  `
  ALTER TABLE clips ADD COLUMN origin TEXT NOT NULL DEFAULT 'ftp' CHECK (origin IN ('ftp','camera'));
  DROP TRIGGER clips_last_received;
  CREATE TRIGGER clips_last_received AFTER INSERT ON clips WHEN NEW.origin = 'ftp' BEGIN
    INSERT INTO clip_arrivals (cam, last_received) VALUES (NEW.cam, NEW.received_at)
      ON CONFLICT (cam) DO UPDATE SET last_received = MAX(last_received, excluded.last_received);
  END;
  `,
  // 7: still checks (cams #179, spec 2026-10-04-still-checks-design): Vision
  // on a second picked by hand. Not events: no event_id (the events a check
  // sits in are computed when read); one per camera, second and provider;
  // successful calls only; kept retention.eventsDays with their JPEG copy.
  `
  CREATE TABLE still_checks (
    id INTEGER PRIMARY KEY,
    cam TEXT NOT NULL,
    still_ts INTEGER NOT NULL,
    provider TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    requested_via TEXT NOT NULL,
    took_ms INTEGER,
    image TEXT,
    objects TEXT NOT NULL,
    raw TEXT,
    summary TEXT NOT NULL,
    UNIQUE (cam, still_ts, provider)
  );
  CREATE INDEX still_checks_cam_ts ON still_checks (cam, still_ts);
  `,
  // 8: the Archive (spec 2026-10-05-archive-design §1.1): clips kept apart
  // from retention, one row per clip, its files in archive/<cam>/<id>/.
  // AUTOINCREMENT: an id is never reused (cams may hold an old one).
  // expires_at (created_at + retention_days; NULL = forever) is stored so
  // the daily cleanup is one indexed query. metadata: the snapshot taken
  // when the clip was archived (events, analyses, still checks).
  `
  CREATE TABLE archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cam TEXT NOT NULL,
    name TEXT NOT NULL,
    labels TEXT NOT NULL,
    retention_days INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    recorded_from INTEGER NOT NULL,
    recorded_to INTEGER NOT NULL,
    quality TEXT NOT NULL,
    original INTEGER NOT NULL,
    duration_s REAL NOT NULL,
    bytes INTEGER NOT NULL,
    files TEXT NOT NULL,
    source TEXT NOT NULL,
    thumb_from TEXT NOT NULL,
    thumb_at INTEGER,
    created_by TEXT NOT NULL,
    metadata TEXT NOT NULL
  );
  CREATE INDEX archive_created ON archive (created_at);
  CREATE INDEX archive_expires ON archive (expires_at);
  `,
  // 9: several cameras on one proxy (spec 2026-10-05-multi-camera-host-design
  // §5.1): usage per API key (key_id, '' for rows from before) and camera
  // ('' here; adoptLegacyUsage assigns the configured camera at start).
  // stream_log_cam_ts serves the per-camera latest() lookups.
  `
  CREATE TABLE analytics_usage_v9 (
    provider TEXT NOT NULL,
    key_id TEXT NOT NULL,
    cam TEXT NOT NULL,
    day TEXT NOT NULL,
    calls INTEGER NOT NULL,
    PRIMARY KEY (provider, key_id, cam, day)
  );
  INSERT INTO analytics_usage_v9 (provider, key_id, cam, day, calls) SELECT provider, '', '', day, calls FROM analytics_usage;
  DROP TABLE analytics_usage;
  ALTER TABLE analytics_usage_v9 RENAME TO analytics_usage;
  CREATE INDEX stream_log_cam_ts ON stream_log (cam, ts);
  `,
];
