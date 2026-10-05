# Archive (cam-proxy) Implementation Plan

**Goal:** the proxy side of the Archive (spec
`docs/superpowers/specs/2026-10-05-archive-design.md`, API in
`docs/archive.md`): clips kept apart from retention, with metadata,
thumbnail, labels and their own daily cleanup, the API cams is built
against, a Status card, a health item and "Clear the Archive".

**Architecture:** `src/catalog/archive.ts` (rows, migration 8),
`src/archive/` (`rules.ts` names/labels/retention, `paths.ts` the guard,
`store.ts` the files and the transaction, `metadata.ts` the snapshot and
thumbnail choice, `jobs.ts` the archive jobs, `cleanup.ts` the daily timer,
`zip.ts` the streamed ZIP, `status.ts`), `src/api/archive-api.ts` (client
routes), `/control/status` + `archive-clear` action (admin), the health
item in `src/health/summary.ts`, settings `archive.enabled` and
`archive.warnPercent`, stream type `archive`, the admin UI card and dialog.

**Tech:** node:sqlite, express, `zlib.crc32`, ffmpeg/ffprobe (thumbnail
frame, duration), vitest + supertest against cam-sim, Playwright.

## Tasks (test first, each)

1. **Migration 8 + catalog** — test: open a v7-shaped catalog copy (all
   seven migrations' tables with rows), migrate, rows intact, `archive`
   table and indexes there, version 8; insert/list/filter/sort/paging,
   `expiringBy`, labels facet. Code: `MIGRATIONS[7]`, `src/catalog/archive.ts`.
2. **Rules** — tests for names (trim, 120, control chars), labels
   (pattern, 16, dedupe, predefined spelling), retention (1–36500, null,
   default 365), default name in camera time (DST), the file-name
   sanitiser. Code: `src/archive/rules.ts`.
3. **Path guard + store** — tests: `archivePath` refuses `..`, bad cam,
   non-integer id, other names; commit = insert + rename in one
   transaction (a failing rename leaves no row); start-up sweep (incoming,
   orphan folders; a missing file is kept); delete removes row and folder.
   Code: `src/archive/paths.ts`, `src/archive/store.ts`.
4. **Metadata + thumbnail** — tests: events overlapping the window with
   analyses, still checks, kinds and found; thumbnail order (thumbnailAt,
   confirmed analysis copy, detection still, check, frame, none) with
   stubbed readers. Code: `src/archive/metadata.ts`.
5. **ZIP** — tests: layout offsets and Content-Length; ZIP64 extra fields,
   EOCD64 and locator at a stubbed 5 GB entry (headers parsed back);
   real `unzip -t` / `unzip -p` of a streamed ZIP (plain and forced ZIP64);
   a vanished file destroys the stream. Code: `src/archive/zip.ts`.
6. **Jobs** — tests with stubbed sources: composition copy with CRC,
   progress, ENOSPC → insufficient_space and cleanup, cancel, 4 in flight →
   busy, the recording fetch (cached; fetched into the cache; streamed
   into the job file when the cache can't keep it). Code:
   `src/archive/jobs.ts`; composer keeps the request (`compose/jobs.ts`).
7. **Cleanup** — tests: next run at 03:30 camera time (offset, DST, UTC
   fallback), runs once per camera day, catch-up after start, expired rows
   and folders go, one `archive-expire` per clip, SSE `expire`. Code:
   `src/archive/cleanup.ts`.
8. **API** — tests against cam-sim: auth (401, CSRF), create from a
   composition (201), a clip and a recording (202 → poll), 400s, 404s,
   409 not_ready, 503 archive_off, 507 with a stubbed statfs (and its audit
   record), list filters/sort/paging, GET, PATCH (audit changes, SSE
   update), DELETE, bulk delete, `/video` Range (206 bytes, 416, ETag,
   download name), `/thumbnail`, `/metadata`, ZIP read back by `unzip`,
   status, rate limits, SSE `archive` add. Code: `src/api/archive-api.ts`,
   wiring in `src/proxy.ts`, image limiter regex.
9. **Settings, health, control** — tests: `archive.enabled`,
   `archive.warnPercent` validation and `config-change`; health item
   (absent when off, problem above warnPercent); `/control/status.archive`;
   `archive-clear` (count mismatch 409, 400, audit, SSE). Code:
   `config/schema.ts`, `defaults.ts`, `health/summary.ts`, `control-api.ts`.
10. **Admin UI** — vitest for `web/src/lib/archive.ts` (card lines, the
    dialog's match rule); Status card, Maintenance button and the
    ConfirmDialog's typed confirmation; e2e: the card shows, Clear the
    Archive refuses a wrong count and clears with the right one.
11. **Docs** — `docs/archive.md` (the API contract), README (feature,
    settings, API table), `openapi.yaml`, `docs/audit-log.md`,
    `config.schema.json` (`npm run schema`), CHANGELOG.
12. **Verify** — `npm test`, `npm run lint:types`, `npm run check`,
    `npm run build`, `npm run test:e2e`; PR; CI green.
