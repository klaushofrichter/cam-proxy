# The Archive

Clips kept apart from retention: cams's Save dialog has an **Archive**
button that stores the clip it would produce on the proxy, with a name,
labels, a retention (365 days by default, or forever), the metadata of its
window and a thumbnail. Normal retention and the storage budget never touch
the Archive; its own daily cleanup removes clips past their retention.
Design and rulings: [the spec](superpowers/specs/2026-10-05-archive-design.md).

## Operating it

- **Where:** `<dataDir>/archive/<camera id>/<id>/` holds `clip.mp4`,
  `thumb.jpg` (when there is a thumbnail) and `meta.json` (the metadata as
  `GET /api/archive/{id}/metadata` serves it, rewritten on every change).
  The rows are in the catalog's `archive` table (migration 8). New clips are
  assembled in `archive/.incoming/` and moved into place with their row in
  one transaction; a start removes leftovers there and folders without a row.
- **Settings:** `archive.enabled` (true; false refuses new clips, everything
  else goes on) and `archive.warnPercent` (50, 1–99): above that share of
  the data volume the Status card says WARNING and the health summary's
  `archive` item is a problem (the e-paper display shows it). No limit.
- **Space:** a clip is refused (507 `insufficient_space`) when it would not
  leave `storage.minFreeBytes` free. The Archive is not part of the storage
  budget (`storage.maxPercent`): the budget's cleanup frees the rest of the
  disk, never the Archive.
- **Daily cleanup:** at 03:30 camera time (UTC until the camera's time is
  known), and within a minute of a start that came after 03:30: clips whose
  `expiresAt` has passed go, one `archive-expire` audit record each.
- **Status page:** the Archive card (clips, size, share of the disk, disk
  free, oldest, newest, next cleanup and how many expire then, last cleanup).
- **Maintenance page:** "Clear the Archive…" asks for the number of clips;
  the proxy refuses another number (`count_mismatch`).
- **Audit:** `archive-add`, `archive-update`, `archive-delete`,
  `archive-clear`, `archive-expire` ([audit-log.md](audit-log.md)).
- **Backups:** copy `<dataDir>/archive/` and the catalog together.

## API (the contract cams is built against)

### 0. General

- One Archive per proxy (the Pi's `data/archive/`, cam2's cluster proxy).
  cams merges the archives of the proxies it knows; ids are per proxy.
- Auth: every path below needs `Authorization: Bearer <client token>` (cams's
  token). The admin token or the admin UI session also work; a session's
  writes need `X-CamProxy-UI: 1` (else 403 `{error:"csrf"}`). Tokens never in
  URLs (a `?token=` answers 400 `token_in_url`).
- **Who:** cams sends `X-On-Behalf-Of: <the signed-in person's email>` on
  every write (POST, PATCH, DELETE). It goes into the audit record as
  `onBehalfOf` (as cams asserts it; not verified by the proxy). 1 to 254
  printable ASCII characters, no spaces; anything else is ignored (not an
  error).
- Ids are integers (`id`), never reused (SQLite AUTOINCREMENT). No path ever
  comes from a request.
- Errors are JSON `{error, detail?}`. Codes used here:
  - 400 `invalid` `{detail}`: a bad request (nothing written, nothing audited)
  - 404 `not_found`: unknown camera, id, composition, clip; 404
    `unknown_recording`: the SD card has no such recording
  - 409 `not_ready` `{state}`: the composition isn't `done`
  - 409 `count_mismatch` `{count}`: Clear the Archive with the wrong count (admin only)
  - 429 `rate_limited` (per client limiter), 429 `busy` (4 archive jobs in flight)
  - 503 `archive_off` (`archive.enabled` is false: no new clips; reading,
    editing, deleting still work), 503 `camera_offline` (a recording not
    cached while the camera is offline), 503 `recordings_unavailable`
    `{reason: "busy"}` with `Retry-After` (the camera's Search is busy) or 502
    `recordings_unavailable` `{reason: "search_failed"}`
  - 507 `insufficient_space` `{needed, free, minFreeBytes}` (bytes): the clip
    would not fit while keeping `storage.minFreeBytes` free
- Rate limits per client and minute: POST archive 10, ZIP 4; the rest share
  the general limit (6000/min); video and thumbnail files share the image
  limit (1200/min).

### 1. The item (`ArchiveItem`)

```jsonc
{
  "id": 12,
  "cam": "cam1",                  // the camera id when archived
  "cameraName": "Den",            // the camera's name when archived
  "name": "2026-10-05 14:03:22 Den",
  "labels": ["Person", "SD"],
  "retentionDays": 365,           // null = forever
  "createdAt": 1759690000000,     // unix ms
  "expiresAt": 1791226000000,     // createdAt + retentionDays days; null = forever
  "recordedFrom": 1759689000000,  // the clip's window, unix ms
  "recordedTo": 1759689030000,
  "durationS": 30,                // the file's duration (ffprobe), 0.1 s precision
  "quality": "sd",                // "sd" | "360p" | "720p" | "1080p" | "4k"
  "original": false,              // true: the camera's own file, as it is
  "bytes": 4123456,               // clip.mp4
  "source": { ... },              // see §2 (what it was made from)
  "eventKinds": ["person", "motion"], // kinds of the events in the window
  "found": ["person"],            // categories Vision found (analyses + still checks)
  "thumbnail": { "from": "analysis", "at": 1759689008000 }, // from: analysis | check | still | frame | none
  "createdBy": "client",          // client | admin
  "urls": {
    "video": "/api/archive/12/video",
    "thumbnail": "/api/archive/12/thumbnail",
    "metadata": "/api/archive/12/metadata"
  }
}
```

`source` in the item:
- composition: `{"type":"composition","jobId":"…","anchor":"clip","clipId":345,"span":{"start":…,"end":…}|null,"preS":-2,"postS":5,"size":"720p","badge":true}`
  or `{"type":"composition","jobId":"…","anchor":"at","at":…,"preS":10,"postS":10,"size":"sd","badge":true}`
- clip: `{"type":"clip","clipId":345,"stream":"main"}` (the proxy's FTP copy)
- recording: `{"type":"recording","recording":"RecM02_20261005_140320_140350_…mp4","stream":"main"}` (the SD card's file)

`quality`: a composition's `size`; an original's stream (`sub` → `"sd"`,
`main` → `"4k"`).

#### Names and labels

- `name`: 1 to 120 characters after trimming, no control characters.
  Default `"<YYYY-MM-DD> <HH:MM:SS> <camera name>"` of `recordedFrom` in the
  camera's local time (its time settings and DST rule; UTC when the camera
  was never read).
- `labels`: at most 16, each 1 to 24 letters or digits (`^[A-Za-z0-9]+$`).
  Case-insensitive: duplicates are dropped (the first spelling wins), and
  the predefined labels get their own spelling (`pet` → `Pet`, `4k` → `4K`).
  Predefined: `Pet`, `Person`, `Vehicle`, `SD`, `4K`. The proxy adds no
  label by itself; cams preselects.
- `retentionDays`: whole days 1 to 36500, or `null` (forever). Default 365.

### 2. Create: `POST /api/cameras/{cam}/archive`

Body:
```jsonc
{
  "source": { "type": "composition", "id": "<22-char job id>" }
         // | { "type": "clip", "clipId": 345 }
         // | { "type": "recording", "id": "RecM02_…mp4" },
  "name": "Fox at the door",      // optional (default above)
  "labels": ["Pet"],              // optional (default [])
  "retentionDays": 365,           // optional; null = forever
  "thumbnailAt": 1759689008000    // optional: a still second for the thumbnail (cams's card choice)
}
```
- `composition`: a finished composition of this camera (`POST
  /api/cameras/{cam}/compositions`, state `done`); the file the Save dialog
  would download. 404 when unknown or gone (results live 15 min after the
  last poll), 409 `not_ready` `{state}` while queued or running, or when
  failed or cancelled.
- `clip`: the proxy's FTP copy as it is (`GET /api/cameras/{cam}/clips`).
- `recording`: the SD card's file as it is (the plain SD or 4K save), fetched
  over Baichuan when not in the recordings cache (one download at a time per
  camera, at high priority, like a viewer's).

Answer: always the **archive job** (`ArchiveJob`):
- **201** `{..., "state":"done", "archiveId":12, "item":{ArchiveItem}}` when
  it finished within 3 s (a composition or a small clip, usually);
- **202** `{..., "state":"queued"|"running"}` otherwise: poll `GET
  /api/archive/jobs/{jobId}` (every 1 to 2 s), or wait for the SSE `archive`
  `add`.

```jsonc
// ArchiveJob
{ "id": "<22-char job id>", "cam": "cam1", "state": "queued" | "running" | "done" | "failed" | "cancelled",
  "phase": "fetching" | "copying" | "finishing" | null,
  "progress": 0.42, "bytes": 123456, "size": 293000000,
  "archiveId": 12, "item": { ... },          // when done
  "error": "insufficient_space", "detail": "…" // when failed: insufficient_space, camera_offline,
                                               // unknown_recording, fetch_failed, source_gone, store_failed, cancelled
}
```
- 400 `invalid` (bad body), 404 (`not_found`, `unknown_recording`), 409
  `not_ready`, 429 (`rate_limited`, `busy`), 503 (`archive_off`,
  `camera_offline`), 507 `insufficient_space` `{needed, free, minFreeBytes}`
  checked before anything is copied (and again by the job).
- A job runs to its end without polling (unlike compositions); `DELETE
  /api/archive/jobs/{jobId}` cancels (204; 404 when unknown). A finished job is
  kept 15 minutes.

`GET /api/archive/jobs/{jobId}` → 200 `ArchiveJob`, 404 `not_found`.

### 3. List: `GET /api/archive`

Query (all optional):
| param | meaning |
|---|---|
| `cam` | camera id |
| `labels` | comma-separated; items with **all** of them (case-insensitive) |
| `q` | text in the name (case-insensitive, substring) |
| `from`, `to` | unix ms: `recordedFrom` within [from, to] |
| `quality` | comma-separated qualities |
| `sort` | `created` (default), `recorded`, `name`, `size`, `expires`, `cam`, `quality`, `duration`, `labels` |
| `order` | `desc` (default) or `asc` |
| `limit` | 1 to 500 (default 100) |
| `offset` | 0 or more (default 0) |

→ 200 `{ "total": 37, "offset": 0, "limit": 100, "items": [ArchiveItem…] }`.

Sort keys: `created` (`createdAt`), `recorded` (`recordedFrom`), `name`
(case-insensitive), `size` (`bytes`), `expires` (`expiresAt`; forever counts
as the latest: last in `asc`, first in `desc`), `cam` (camera id), `quality`
(by resolution: `360p` < `sd` (896×512) < `720p` < `1080p` < `4k`),
`duration` (`durationS`), `labels` (the item's alphabetically first label,
case-insensitive; items without labels last in both orders). Ties: by
`recordedFrom` descending, then `id` descending (stable across pages).

### 4. One item

- `GET /api/archive/{id}` → `ArchiveItem`
- `PATCH /api/archive/{id}` body any of `{name, labels, retentionDays}` (same
  rules; `name: ""` is invalid; `labels` replaces the list) → 200
  `ArchiveItem`. An unchanged PATCH answers 200 and audits nothing.
  `retentionDays` counts from `createdAt` (a new value can expire it at the next
  cleanup).
- `DELETE /api/archive/{id}` → 204
- `POST /api/archive/delete` body `{"ids":[1,2,3]}` (1 to 500 ids) → 200
  `{"deleted":[1,3], "notFound":[2]}`
- `GET /api/archive/{id}/video` → `video/mp4`, Range requests (206, 416),
  `ETag`, `Cache-Control: private, max-age=604800, immutable`.
  `?download=1` adds `Content-Disposition: attachment` with the name
  (`<name>.mp4`, unsafe characters replaced; RFC 5987 `filename*`).
- `GET /api/archive/{id}/thumbnail` → `image/jpeg` (404 when the item has none: `thumbnail.from` `none`)
- `GET /api/archive/{id}/metadata` → `ArchiveMetadata`:

```jsonc
{
  "schema": 1,
  "item": { ArchiveItem without urls },  // current name, labels, retention
  "camera": { "id": "cam1", "name": "Den", "model": "RLC-1224A" | null },
  "window": { "from": …, "to": … },     // = recordedFrom/recordedTo
  "events": [ { "id": 5, "kind": "person", "source": "onvif", "start": …, "end": … | null, "recovered": false,
                "analysis": { "provider": "google-vision", "status": "ok", "stillTs": …,
                              "objects": [ {"name","mid","score","box"} ], "summary": [ {"category","score",…} ] } | null } ],
  "stillChecks": [ { "id": 3, "stillTs": …, "provider": "google-vision", "objects": [...], "summary": [...] } ],
  "proxy": { "version": "2026.10.05.1" },
  "archivedAt": …
}
```
Events: those overlapping the window (start ≤ to and end ≥ from − 5 s).
The snapshot is taken when the clip is archived: events and analyses
deleted later by retention stay in it.

### 5. ZIP: `GET /api/archive/zip?ids=1,2,3`

- 1 to 200 ids. Any unknown id → 404 `{error:"not_found", missing:[…]}`
  (nothing streamed).
- Streamed, no temp files: `application/zip`, `Content-Length` exact,
  `Content-Disposition: attachment; filename="archive-<cam>-<YYYYMMDD-HHMMSS>.zip"`.
- Per clip three entries, stored (no compression), UTF-8 names:
  `<name> (<id>).mp4`, `<name> (<id>).json` (the metadata as in §4),
  `<name> (<id>).jpg` (when it has a thumbnail). Names have `/ \ : * ? " < > |`
  and control characters replaced.
- ZIP64 when the archive or an entry passes 4 GB (any unzip from the last
  15 years reads it; macOS Archive Utility and Windows Explorer do).
- A clip deleted while the ZIP streams cuts the download (the browser shows
  a failed download).

### 6. Status: `GET /api/archive/status`

```jsonc
{
  "enabled": true,
  "count": 37, "bytes": 912345678,
  "forever": 2,                         // items without expiry
  "oldestCreatedAt": … | null, "newestCreatedAt": … | null,
  "disk": { "free": …, "size": … },     // the data volume
  "percentOfDisk": 0.4,                 // bytes / disk size × 100, 1 decimal
  "warnPercent": 50,                    // archive.warnPercent
  "warning": false,                     // percentOfDisk > warnPercent
  "minFreeBytes": 2147483648,
  "nextCleanupAt": …,                   // the next daily cleanup, ~03:30 camera time
  "expiringAtNextCleanup": 1,
  "lastCleanup": { "at": …, "removed": 0, "bytes": 0 } | null,
  "labels": [ { "label": "Person", "count": 12 }, … ]   // predefined first (also at 0), then custom by count
}
```

### 7. SSE: type `archive`

On `GET /api/stream` (opt in with `types=…,archive`; the default types
include it). Stored in the stream log, so a resume never misses one.

`event: archive`, `data: {"cam": "cam1", "action": "add"|"update"|"delete"|"clear"|"expire", "ids": [12], "items": [ArchiveItem…]}`
- `items` with `add` and `update` only.
- `clear` and `expire` carry every removed id.

### 8. Admin only (the proxy's Maintenance page)

`POST /control/actions/archive-clear` `{"count": 37}` → 200 `{"cleared": 37,
"bytes": …}`; 409 `count_mismatch` `{count}` when `count` isn't the
current number of clips; 400 without a count.

### 9. What cams has to build (summary)

- Save dialog: an **Archive** button next to Save. Composed result: POST
  `source.type=composition` with the job id once `done`. Plain SD / 4K:
  POST `source.type=recording` with the SD file id (what Save would
  download), or `clip` when only the proxy's FTP copy is offered. Name field
  (prefilled with the default, editable), retention (days, default 365, or
  forever), labels (Pet, Person, Vehicle, SD, 4K + custom), `thumbnailAt`
  from the card's #157 choice. Show `insufficient_space` with sizes.
- An Archive page listing all proxies' archives (merge by `createdAt`),
  filters (labels, camera, text, dates), edit name/labels/retention, delete
  (one and bulk), play (`/video`, Range), download one (`?download=1`) or
  a ZIP of the selected (per proxy). Relay each through cams's server with
  the proxy's token; send `X-On-Behalf-Of`.
- Live updates from SSE `archive`.
