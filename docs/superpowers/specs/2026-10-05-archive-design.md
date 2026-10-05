# Archive: clips kept apart from retention (design)

Status: approved by Klaus, 2026-10-05 (the feature and his answers below);
the open points were decided while he was away, each as a ruling (§9). This
spec covers the whole feature; cam-proxy builds §1 to §7, cams builds §8.
The API is fixed in `docs/archive.md` ("API", the binding contract cams is
built against; also handed to the cams session as `archive-api.md`).

## Klaus's feature (2026-10-05)

cams's **Save** dialog gets an **Archive** button. It stores the clip the
dialog would produce (the same composition: clip or second, span, rolls,
size, badge; or the plain original) on the proxy, in an **Archive** that
normal retention never purges. Per clip:

- an editable **name**, default `<date> <time> <camera name>`;
- a **retention** in days, default 365, or forever;
- **labels**: one word each, letters and digits, case-insensitive;
  predefined Pet, Person, Vehicle, SD, 4K, plus custom ones;
- the **metadata**: the window's events with their kinds, the Vision
  analyses and still checks with their objects, camera name and id,
  quality, duration, size, the source window;
- a **thumbnail**: the card thumbnail of #157 (the detection or Vision
  still), else the clip's first frame.

One Archive per proxy (the Pi's `data/archive/`; cam2's cluster proxy too),
on by default everywhere. Outside the storage budget (normal cleanup never
touches it), but archiving refuses a clip that would not fit while keeping
`storage.minFreeBytes` free. A daily cleanup (with the retention run, about
03:30 camera time) removes clips past their retention, one audit record per
clip. A Status card "Archive": count, total size, free disk, oldest and
newest, next cleanup (and how many would go), and a size WARNING (no limit)
when the archive passes `archive.warnPercent` of the disk (new setting,
default 50, validated, audited), also as a health-summary item (problem
when over; the e-paper display shows health items by itself). Maintenance:
"Clear the Archive", confirmed by typing the clip count. Every change is
audited (`archive-add`, `archive-update`, `archive-delete`,
`archive-clear`, `archive-expire`) with the user.

## 0. What is there (read 2026-10-05)

- Compositions (`src/compose/jobs.ts`): one encode at a time, results in
  `data/compositions/<job>/out.mp4`, kept 15 min after the last poll; a
  job knows its plan (window, segments, size, badge), not its request.
- The plain originals: cams's plain Save downloads the SD card's file
  (`sub` for SD, `main` for 4K) through the proxy's recordings API
  (Baichuan into `data/recordings/<cam>/`, the cache, LRU, capped); the
  proxy's own FTP copy (`ftp.stream`: `main` on the Pi, `sub` in the
  cluster) is in `data/clips/`.
- Still checks (#179) set the pattern: own table (migration 7), own folder
  (`data/still-checks/<cam>/`), path guards at the file sink, a stream
  type, audit records, a client-token API with a per-client limiter and
  CSRF for sessions.
- Storage (`src/storage.ts`) walks only its kinds' folders; anything else
  under the data folder is not counted and never deleted by it. The floor
  (`storage.minFreeBytes`, 2 GiB) pauses writing.
- The health summary (#123): one `buildHealth`, items in a fixed order,
  `schema: 1`; additive items keep the schema.
- The catalog is at version 7 on the Pi (still checks, released
  2026-10-04).

## 1. Data model

### 1.1 Table (catalog migration 8)

```sql
CREATE TABLE archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,  -- never reused: cams may hold an old id
  cam TEXT NOT NULL,
  name TEXT NOT NULL,
  labels TEXT NOT NULL,                  -- JSON array, display spelling
  retention_days INTEGER,                -- NULL = forever
  created_at INTEGER NOT NULL,
  expires_at INTEGER,                    -- created_at + days; NULL = forever (indexed: the cleanup)
  recorded_from INTEGER NOT NULL,
  recorded_to INTEGER NOT NULL,
  quality TEXT NOT NULL,                 -- sd 360p 720p 1080p 4k
  original INTEGER NOT NULL,             -- 1: the camera's file as it is
  duration_s REAL NOT NULL,
  bytes INTEGER NOT NULL,                -- clip.mp4
  files TEXT NOT NULL,                   -- JSON {clip:{bytes,crc32}, thumb:{bytes,crc32}|null}
  source TEXT NOT NULL,                  -- JSON (docs/archive.md)
  thumb_from TEXT NOT NULL, thumb_at INTEGER,
  created_by TEXT NOT NULL,              -- client | admin
  metadata TEXT NOT NULL                 -- JSON snapshot: events, analyses, still checks, camera
);
CREATE INDEX archive_created ON archive (created_at);
CREATE INDEX archive_expires ON archive (expires_at);
```

`expires_at` is stored (not computed) so the cleanup and "how many would
go" are one indexed query; a PATCH of the retention rewrites it. The
metadata is a snapshot: retention deletes events after 30 days, the
archive keeps them for a year.

### 1.2 Files

`data/archive/<cam>/<id>/clip.mp4`, `thumb.jpg`, `meta.json` (the metadata
as the API serves it, rewritten on every change: the folder explains
itself in a backup). New clips are assembled in
`data/archive/.incoming/<random>/` and renamed to `<cam>/<id>` inside the
transaction that inserts the row: a crash leaves either nothing or an
orphan folder that the start-up sweep removes (§1.4).

Path guards at every file sink: names come from a fixed set (`clip.mp4`,
`thumb.jpg`, `meta.json`), the camera from the row (pattern-checked), the
id is an integer, and the resolved path must lie inside
`<dataDir>/archive/` (`archivePath()`), else the call throws. No request
value ever becomes a path.

### 1.3 The clip's file

Copied, not hard-linked (ruling 6), with its CRC-32 computed in the same
pass (`zlib.crc32`), so the ZIP needs no second read (§4.4). A copy runs
in an archive job (§2.2).

### 1.4 Start-up and consistency

At start: `.incoming` is emptied; a folder under `archive/<cam>/` whose id
has no row is removed (only an interrupted create or delete leaves one);
a row whose `clip.mp4` is missing stays (it is listed, its video answers
404) and is logged once as `archive_file_missing`.

## 2. Creating a clip

### 2.1 Sources (ruling 1)

| `source.type` | what | when cams uses it |
|---|---|---|
| `composition` | a finished composition job of this camera (state `done`) | any composed result (rolls, sizes, badge, "around this second") |
| `recording` | the SD card's file as it is, fetched over Baichuan unless cached | the plain SD and 4K saves (what Save downloads) |
| `clip` | the proxy's FTP copy as it is | a plain save of the proxy's own copy |

The proxy does not compose for the archive: the Save dialog already ran
the composition with its progress bar; the Archive button sends that job's
id. The composition's request (anchor, clip, span, rolls, size, badge) is
now kept on the job, so the archive records exactly what was asked.

### 2.2 Archive jobs (ruling 2)

`POST /api/cameras/{cam}/archive` always starts an **archive job** and
waits up to 3 s for it: done by then → 201 with the item (a composition of
up to 200 MB copies in about a second on the Pi's SSD); else 202 with the
job, polled at `GET /api/archive/jobs/{id}` or followed by the SSE `add`.
At most 4 jobs in flight (429 `busy`). Unlike compositions, a job runs to
its end without polling (the user asked to keep the clip; a closed tab
must not lose it); `DELETE` cancels; a finished job is kept 15 minutes.

Phases: `fetching` (a recording not cached: the fetcher at **high**
priority, its bytes streamed into the job's own file when the cache can't
keep it, like the clips repair's temp mode; progress = bytes / size),
`copying` (file → `.incoming` with CRC-32; progress), `finishing`
(thumbnail, metadata, row, rename, SSE, audit).

### 2.3 The space check (ruling 5)

Before the job and again before the copy: `needed = size + 1 MiB`
(thumbnail and metadata); refused when `free − needed < storage.minFreeBytes`
→ 507 `insufficient_space {needed, free, minFreeBytes}` and an
`archive-add` failure record. Never a deletion to make room: the archive
is outside the budget, and the budget's own cleanup frees the rest of the
disk on its next run. A copy that hits ENOSPC anyway fails the job
(`insufficient_space`), and its partial files go.

### 2.4 Name, labels, retention

- Name: 1–120 characters after trimming, no control characters; default
  `YYYY-MM-DD HH:MM:SS <camera name>` of the recording's start in camera
  time (ruling 9).
- Labels: ≤ 16, each `^[A-Za-z0-9]{1,24}$`, case-insensitive set; the
  predefined five keep their spelling; the proxy adds none (ruling 10).
- Retention: 1–36500 days or `null` (forever), default 365. Counted from
  the archive time, not the recording time (ruling 11).

### 2.5 The thumbnail (ruling 12, #157)

Best first, the first that exists:
1. `thumbnailAt` from cams (its card's choice), as a still (`from: still`)
   or the analysed still of an event at that second;
2. #157's rule over the window: the analysed JPEG copy of the first event
   whose own kind Vision confirmed (person, vehicle, pet; the copy outlives
   the 7-day stills: `from: analysis`), then the still at the first such
   event's start (`from: still`);
3. a still check in the window that found something (`from: check`);
4. the clip's first frame, ffmpeg, 640 px wide (`from: frame`);
5. none (`from: none`; the thumbnail answers 404).

### 2.6 The metadata snapshot

At the end of the job (events may have ended meanwhile): the camera (id,
name as now, model), the window, the events overlapping it (start ≤ to,
end ≥ from − 5 s; open ones count; recovered ones marked), each with its
latest analysis (provider, status, still second, objects, summary), the
still checks of the window (objects, summary), the proxy version, the
archive time. `eventKinds` and `found` on the item come from it.

## 3. Changing and removing

- `PATCH /api/archive/{id}`: name, labels, retention; an unchanged value
  writes nothing; `archive-update` lists `{field, from, to}`.
- `DELETE /api/archive/{id}`, `POST /api/archive/delete {ids}` (≤ 500): the
  row first, then the folder; one `archive-delete` record per clip.
- Clear (admin, Maintenance): `POST /control/actions/archive-clear {count}`;
  the count must equal the number of clips at that moment (409
  `count_mismatch {count}` otherwise); one `archive-clear` record with the
  count, bytes and ids.
- Daily cleanup (§5): `archive-expire`, one record per clip.
- Each change sends one SSE `archive` message (§7).

## 4. Reading

### 4.1 List and items

`GET /api/archive` (filters: camera, labels (all of them), text, recorded
window, quality; sort by created, recorded, name, size, expires, camera,
quality (by resolution), duration or labels (the first label
alphabetically), ties by recorded time descending, then id (Klaus,
2026-10-05: sortable by date, title, quality, size, camera and the other
data); paging by limit ≤ 500 and offset). `GET /api/archive/{id}`, `/metadata`.

### 4.2 Video

`GET /api/archive/{id}/video`: `sendFile` with Range (206, 416), ETag,
immutable caching; `?download=1` for an attachment named after the clip
(unsafe characters replaced, RFC 5987 `filename*`). Counts in the image
limiter (players send many ranges).

### 4.3 Thumbnail

`GET /api/archive/{id}/thumbnail`: the JPEG, immutable.

### 4.4 ZIP (ruling 7)

`GET /api/archive/zip?ids=…` (≤ 200): a ZIP written while it is sent, no
temp files, `Content-Length` exact (the layout is planned from the sizes
first). Entries are **stored** (video does not compress), with CRC and
sizes in the local headers (the clip's CRC from its row, the JSON and the
JPEG computed in memory), so no data descriptors and any reader, also a
streaming one, works. ZIP64 records only when needed: an entry or an
offset at or past 0xFFFFFFFF, or more than 65534 entries. Names
`<name> (<id>).mp4|.json|.jpg`, UTF-8 (flag 11). A file that vanished or
changed size after planning cuts the response (destroy), never a ZIP with
a wrong length.

### 4.5 Status

`GET /api/archive/status` (client and admin) and `archive` in `GET
/control/status`: count, bytes, forever count, oldest and newest, disk
free and size, percent of disk, `warnPercent`, `warning`, next cleanup and
how many expire by then, last cleanup, labels with counts.

## 5. The daily cleanup (ruling 4)

Its own timer (one tick a minute) runs once per camera day at 03:30 camera
time (`dayStartMs` of the camera day + 3.5 h; UTC without the camera's
time info), and once a minute after start when the proxy was down at
03:30. It deletes the rows with `expires_at ≤ now` and their folders, one
`archive-expire` record per clip (user `system`), one SSE `expire` with
all ids, and an `archive_cleanup` log line. The storage run never touches
the archive (it only walks its kinds' folders); the cleanup is not part of
the storage run, as that one runs every hour and its day logic is UTC.
"Next cleanup" is the next 03:30 camera time after the last run.

## 6. Settings, health, Status card, Maintenance

- `archive.enabled` (true, live): false refuses new clips (503
  `archive_off`); reading, editing, deleting and the cleanup go on.
- `archive.warnPercent` (50, 1–99, live): the warning threshold, in percent
  of the data volume's size. Changes are `config-change` records like any
  setting.
- Health item `archive` after `disk` (present while the archive is on and
  the disk is known): value the percent of the disk (1 decimal), text
  `12 clips, 1.2 GB (0.5 % of disk)`, problem when the percent is above
  `warnPercent`. `thresholds.archiveWarnPercent` is added. Still schema 1
  (additive). The e-paper display lists items as they come.
- Status card "Archive": clips, size, percent of disk (red with "over
  warnPercent" when warning), disk free, oldest and newest, next cleanup
  ("in 9 h, 1 clip expires"), last cleanup.
- Maintenance: "Clear the Archive…" opens the confirmation dialog, which
  shows the count and enables its button only when the typed number equals
  it; disabled while the archive is empty.

## 7. Audit, SSE, security

Audit records (category `file`; details always `id`/`ids`, `cam`, `name`,
`requestedBy` (`token` or `session`), `onBehalfOf` when cams sent it):

| action | type | when | details |
|---|---|---|---|
| `archive-add` | creation | a job ends (done or failed after the input check), or the space check refuses | `source`, `bytes`, `labels`, `retentionDays`, `durationS`, `quality`, `jobId`; failure: `error` |
| `archive-update` | change | PATCH that changed something | `changes: [{field, from, to}]` |
| `archive-delete` | deletion | DELETE, bulk delete (one per clip) | `bytes`, `createdAt` |
| `archive-clear` | deletion | Maintenance | `count`, `bytes`, `ids` |
| `archive-expire` | deletion | daily cleanup (one per clip), user `system` | `retentionDays`, `createdAt`, `expiresAt`, `bytes` |

User: `client` (client token), `admin` (admin token or session),
`system`. `onBehalfOf`: the `X-On-Behalf-Of` header cams sends with the
signed-in person's email (ruling 8).

SSE type `archive`: `{action, ids, items?}`, stored in the stream log.

Security: client token for cams, admin for clear; CSRF header for session
writes (`requireAccess`); a per-client limiter for creates (10/min) and
ZIPs (4/min); ids only, never paths; path guards at every sink; names are
data, never paths (sanitised for file names in downloads); the JSON body
limit stays 64 kB; no secrets in metadata or audit.

## 8. cams (built in parallel, against `docs/archive.md`)

- Save dialog: **Archive** next to Save. Composed: once the job is `done`,
  POST `{source:{type:"composition", id}}`. Plain SD/4K: `{source:{type:
  "recording", id}}` with the SD file Save would download. Fields: name
  (prefilled with the default the proxy would use, shown as placeholder),
  retention (365 days, or forever), labels (the five predefined as toggles,
  preselected from the card's kinds and the size; custom ones typed),
  `thumbnailAt` = the card's #157 thumbnail second. Progress for 202 jobs;
  `insufficient_space` shown with the sizes.
- An Archive page: every proxy's archive merged, filters, rename, labels,
  retention, delete (one, many), play, download one, ZIP of a selection
  (one per proxy), live via SSE `archive`. cams relays through its server
  with the proxy token and adds `X-On-Behalf-Of`.

## 9. Rulings

1. Ruling: three sources (composition id, SD recording, FTP clip), no
   composing by the archive — the dialog already composes with progress;
   the plain originals are the recording Save downloads — cost if wrong: a
   fourth source type that starts a composer job and chains (additive).
2. Ruling: every create is an archive job, answered 201 when done within
   3 s, else 202 + polling; jobs run without polling — one code path in
   cams, a closed tab loses nothing — cost: cams polls a job it could have
   had at once (rare: compositions finish within 3 s).
3. Ruling: one table, one folder per clip, AUTOINCREMENT ids — ids never
   point to another clip later; a folder per clip makes delete one rm —
   cost: none.
4. Ruling: the cleanup is its own daily timer at 03:30 camera time, not
   inside the hourly storage run — the storage run is hourly with UTC days;
   coupling them would delete at a random hour — cost: one more timer.
5. Ruling: the space check is `free − (size + 1 MiB) ≥ minFreeBytes`,
   checked before the job and before the copy; never frees space — the
   archive is outside the budget; deleting stills to fit an archive clip
   would be surprising — cost: a refused archive on a nearly full disk.
6. Ruling: copy, not hard link — a link would make the archive's size
   invisible (shared blocks) and tie it to the clip's file — cost: the
   bytes twice until retention deletes the original (minutes to 7 days).
7. Ruling: stored ZIP with CRCs in the local headers, the clip's CRC
   computed once at archive time; ZIP64 only when needed — any reader, no
   second read of gigabytes on the Pi — cost: 4 bytes per row.
8. Ruling: the person is cams's assertion in `X-On-Behalf-Of`, recorded as
   `onBehalfOf`; `user` stays `client` — the proxy knows tokens, not
   people (still-checks ruling 12) — cost: a forged header can only mislabel
   an audit record of a holder of the client token.
9. Ruling: the default name uses the recording's start in camera time —
   that's what a person looks for; the archive time is `createdAt` —
   cost: none (editable).
10. Ruling: the proxy adds no labels; cams preselects — the dialog shows
    what will be stored — cost: an API client without cams gets no labels.
11. Ruling: retention counts from the archive time — "keep for a year" read
    as "a year from now" — cost: none.
12. Ruling: thumbnail order cams's choice, analysed JPEG, detection still,
    still check, first frame — #157's card picture, the analysed copy
    outlives the 7-day stills — cost: none.
13. Ruling: `archive.enabled` live, default true; `archive.warnPercent`
    1–99, default 50, live — on everywhere as asked; the warning is a
    problem in the health summary only, never a limit — cost: none.
14. Ruling: Clear the Archive is admin-only, by the exact count — a
    confirmation that can't be clicked through, and the count must be the
    current one (a clip added meanwhile refuses) — cost: type again.
15. Ruling: a row whose file is missing stays listed (video 404) —
    deleting user data automatically on a read error is worse — cost: a
    stale row until deleted by hand.
16. Ruling: bulk delete ≤ 500, ZIP ≤ 200 ids, list ≤ 500 per page — bounds
    the work of one request on a Pi — cost: cams pages.
17. Ruling: the archive is not in the storage budget, the storage-daily
    record or the inventory — the archive's own card and status say it —
    cost: none.
18. Ruling: the metadata is snapshotted when archived and served with the
    current item fields — events vanish after 30 days — cost: a later
    analysis of the window's events is not in it.
19. Ruling: one SSE message per change with all ids (bulk, clear, expire) —
    one refresh in cams per action — cost: none.
20. Ruling: the file name in downloads is `<name> (<id>)` in a ZIP and
    `<name>` for one video — unique in a ZIP, readable alone — cost: none.

## 10. Risks

- A 4K recording fetch takes minutes and holds the camera's one download
  slot (viewers queue behind it: high priority, first come). Mitigation:
  progress shown; cancel.
- The Pi's disk: 228 GB; at 50 % the warning shows. No hard limit by
  design (Klaus).
- A ZIP of many 4K clips is many GB; the stream is paced by the client
  (backpressure), no memory growth.

## 11. Tests (no camera, no Vision)

Unit: label/name/retention rules; the ZIP layout (offsets, ZIP64 at a
stubbed 5 GB size, EOCD64 locator); thumbnail order; cleanup timing in
camera time; health item; path guard. API against cam-sim: create from a
composition, a clip and a recording (cam-sim's Baichuan), 507 with a
stubbed statfs, list/filter/sort/paging, PATCH, delete, bulk, Range
requests on `/video`, the ZIP read back by the real `unzip`, also with
forced ZIP64, SSE, audit records, CSRF, auth. Migration 8 on a copy shaped
like the Pi's v7 catalog. Admin UI: the card and the dialog's logic
(vitest), e2e: the card and Clear the Archive.
