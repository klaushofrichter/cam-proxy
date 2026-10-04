# Still checks, phase 1 (cam-proxy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, test first. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client (cams) can ask Google Vision about any second that has a still (`POST /api/cameras/{cam}/still-checks {at}`), read the results back by range or id (with the analysed JPEG), and see them live (`still-check` stream message). Checks are stored apart from events, share the Vision budget, have their own daily cap, are audited per request and counted daily, and are kept 30 days with their JPEG.

**Architecture:** A new table `still_checks` (migration 7) with its catalog module `src/catalog/still-checks.ts` (insert, image, lookups, range, the linked events computed on read, retention). `AnalyticsService.check(at, via)` runs the limits, the reuse, the one-in-flight rule and the call (no retry, 10 s), stores the row and the JPEG copy (`data/analytics/<cam>/check-<id>.jpg`), counts the outcome in `analytics_usage` and appends the stream message. A new router `src/api/still-checks-api.ts` maps outcomes to HTTP answers, writes the `still-check` audit record, and serves the list, one check, its image and the client-side analytics usage. Retention deletes old checks and keeps the union of both tables' images.

**Tech Stack:** Node 26+, TypeScript, Express 5, express-rate-limit, `node:sqlite`, Svelte 5 (one field), Vitest, Playwright. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-04-still-checks-design.md` (§1, §2, §3.7, §5.1, §6, §7 cam-proxy, §9, §12 rulings 23–34).

## Global Constraints

- Catalog version 6 → 7, additive only (one table, one index). Never edit migrations 1–6.
- `POST /api/cameras/{cam}/still-checks` `{at}`; answers 201 `{check, reused:false}`, 200 `{check, reused:true, source}`, 400 `invalid`, 404 `no_still` / `not_found`, 409 `analytics_off {reason}`, 429 `limit {reason}` / `busy` / `rate_limited`, 503 `analytics_paused {reason, until}`, 502 `provider_failed {reason}`.
- `at`: a JSON safe integer, `% 1000 === 0`, `<= now`, `>= dayStart(now − stillsDays·DAY)`; the still is found by number only (`listStills(at, at)`); the image path comes from the row id and is checked with `resolve` + `startsWith(<analytics dir> + sep)` before any read.
- Client token or admin; cookie sessions need `X-CamProxy-UI` (requireAccess). POST limiter 20/min.
- Tests never call Google: the fake provider (unit) and `test/helpers/vision-mock.ts` (API, e2e).
- CHANGELOG under `## Unreleased`; no version numbers. Stage files explicitly; never stage `tools/`.

## Tasks

### Task 1: migration 7 and the catalog module

**Files:** `src/catalog/migrations.ts`, `src/catalog/still-checks.ts` (new), `test/catalog-still-checks.test.ts` (new), `test/catalog.test.ts`, `test/catalog-analyses.test.ts` (version 6 → 7).

- [ ] Test: a version 6 catalog built from migrations 1–6 as released (the Pi's shape: events incl. recovered, analyses with images, usage, unmapped, clips ftp/camera, arrivals, stream log) opens at version 7 with every row intact, the trigger still working, and an empty `still_checks` with its index and UNIQUE (cam, still_ts, provider).
- [ ] Test: `insertCheck` returns the row with id; a second insert for the same (cam, ts, provider) throws; `setCheckImage`; `checkById`; `checkAt(cam, ts)`; `checksInRange(cam, from, to, limit)` oldest first, capped at 1000; `deleteChecksBefore(ts)`; `checkImages()`.
- [ ] Test: `linkedEvents(cam, ts, summary, maxOpenMs)`: an open event (counted `maxOpenMin` from its start), an ended one (end inclusive), one ended before, a recovered one, two kinds at once (person confirmed, motion never), another camera ignored.
- [ ] Implement; run; commit.

### Task 2: the `checksPerDay` setting

**Files:** `src/config/defaults.ts`, `src/config/schema.ts`, `config.schema.json` (`npm run schema`), `config.example.json`, `test/analytics-config.test.ts`.

- [ ] Test: default 10; 0 and 1000 accepted; 1001, -1, 1.5 refused with `analytics.googleVision.checksPerDay: must be from 0 to 1000`.
- [ ] Implement; regenerate the schema; commit.

### Task 3: retention keeps check images, deletes old checks

**Files:** `src/storage.ts`, `test/storage.test.ts`.

- [ ] Test (the regression the design found): a check row with `check-<id>.jpg` and an analysis image both survive a run; an orphan file goes; a check older than `eventsDays` is deleted with its image; a dry run counts `stillChecks` and deletes nothing.
- [ ] Implement (keep-set = `analysisImages ∪ checkImages`; `deleted.stillChecks`); commit.

### Task 4: `AnalyticsService.check()`

**Files:** `src/analytics/service.ts`, `test/analytics-still-checks.test.ts` (new).

- [ ] Tests with the fake provider: stored (row, JPEG named from the row id, stream message `still-check` with events, usage +1 on `google-vision` and `google-vision:check`); reused row (no call, `check-reused` count); reused automatic analysis (`source: 'event'`, no row); refusals in order — off/no_key/checks_off (409), no_still (404), paused (503), month, day, checks (429 limit) — each counted `check-refused` except no_still; busy for another second while one runs; the same second joins (one call); timeout → `provider_failed timeout` without retry, counted; bad_key pauses the event queue too; stop during a call → `aborted`, no row; a failed image copy keeps the row with `image: null`.
- [ ] Implement; commit.

### Task 5: the API router and the stream type

**Files:** `src/api/still-checks-api.ts` (new), `src/stream/log.ts` (type), `src/proxy.ts` (mount, image bucket), `test/still-checks-api.test.ts` (new).

- [ ] Tests (proxy + cam-sim + vision mock; stills injected through the store when go2rtc is present, else a fake stills side is not possible → the store-dependent tests `skipIf(!go2rtc)` like stills-api): 400 shapes (`at` missing, string, fraction, not whole second, future, too old); 404 unknown camera; 404 `no_still`; 409 off; 201 then 200 reused; GET list (range ≤ 31 days, 400 otherwise), GET one (objects, raw, requestedAt, tookMs), GET jpg (immutable), 404 for unknown id / other camera / bad id; `GET …/analytics` (no key in it); audit records (`still-check`, outcome, cost); 401 without token; 403 `csrf` for a cookie session without the header; POST limiter 429 `rate_limited`.
- [ ] Implement; commit.

### Task 6: activity-daily counts

**Files:** `src/audit/daily.ts`, `src/proxy.ts`, `test/audit-daily.test.ts`.

- [ ] Test: `activityDaily` details carry `analytics.checks: {calls, reused, refused, failed}`; the message unchanged when there were none, "N still checks" when there were.
- [ ] Implement; commit.

### Task 7: admin UI field

**Files:** `web/src/components/AnalyticsSettings.svelte`.

- [ ] A "Still checks per day (0 = off)" row like the daily cap; `npm run check`, `npm run build`; commit.

### Task 8: e2e

**Files:** `e2e/still-checks.spec.ts` (new) using the e2e harness's vision mock.

- [ ] Script one answer; enable Vision with limits; pick a still from `/stills`; POST → 201; the stream carries `still-check`; POST again → 200 reused; GET list contains it; GET jpg 200. Restore settings.

### Task 9: docs and the contract

**Files:** `docs/analytics.md` ("Still checks"), `README.md` (settings, API), `openapi.yaml`, `docs/audit-log.md`, `CHANGELOG.md`; the contract for cams in the session scratchpad.

- [ ] Write; `test/openapi.test.ts` passes; commit.

### Task 10: verify and PR

- [ ] `npm test`, `npm run lint:types`, `npm run check`, `npm run build`, `npm run test:e2e`; push; PR to `main` (not merged).
