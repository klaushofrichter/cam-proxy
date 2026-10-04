# Still checks: Vision on any second (cams #179)

Design, 2026-10-04. No product code yet. Repos: cam-proxy (storage, calls,
compositions) and cams (Timeline, Video, relay). Written to be split into
`docs/superpowers/specs/2026-10-04-still-checks-design.md` in both repos.

---

## One page for Klaus

**What:** under the Timeline's large still, **"✧ Check with Vision"** sends
that second's still to Google Vision and shows the boxes and the object list
in place. The result is a **still check**, not an event.

**Feasible?** Yes, all of it, with small changes. The stills, the Vision
client, the limits and the composer are there. Nothing needs new hardware or
disk (a check is ~140 KB; 300 a month is ~40 MB, the Pi has 192 GB free).

**Key rulings** (details in §9):
1. **Own table** `still_checks` (catalog migration 7), not the `analyses`
   table: that one is one-row-per-event and an upsert would overwrite the
   automatic result.
2. **The event link is computed when read** (the events around the second),
   never stored: late event ends and recovered events link by themselves.
3. **Confirms only.** A check that finds the card's kind turns its badge to
   "✦ Vision 84%" like an automatic one. It never says "not confirmed" and
   never adds "+ Pet" to a card.
4. **Same second twice = the stored answer**, no new call. A second the
   automatic analysis already sent is answered from that analysis.
5. **Budget:** the same monthly limit and daily cap as the automatic ones,
   plus a **manual cap of 10 a day** (new setting), so checks can't starve
   the person events. Today: 14 of 1000 used this month.
6. **Kept 30 days** (like events) with its own JPEG copy, so it outlives the
   7-day stills.
7. **Shown separately:** ✧ (hollow) on the seconds and a dotted corner on
   the minute tiles; a "Checks" list on the Timeline with ◀ ✧ ▶ to step
   between them; on the Video page later as its own sidebar mode, never in
   the event list.
8. **Save clip around this:** a new composition anchor `at` (a second
   instead of a clip). Each second uses an FTP clip when one covers it, else
   the 1 fps still, the way compositions already work. Default −10/+10 s,
   adjustable up to 300 s (120 s at 1080p).

**Measured on the Pi (v2026.10.04.1):** a Vision call took 597 ms; a
still is 140 KB; FTP clips covered 17% of the last day (0.5–3.5% over the
week). So **most "around this" saves will be stills-based**, which the
composer already encodes (the "1 FPS" badge).

**Blockers:** none. Everything open is ruled below; the rulings are cheap to
reverse except the table shape (§1).

**Phases:**
1. cam-proxy: the table, `POST/GET still-checks`, limits, audit, stream
   message, retention fix, docs. (One PR, a release.)
2. cams: the button, the result in place, the marks, the day's list, the
   steps, card confirmation.
3. cam-proxy + cams: compositions with `at` and "Save clip around this".
4. Later, if wanted: the Video page's "Checks" mode, the admin UI's tags.

---

## 0. What is there today (read, and measured)

**cam-proxy**
- `analyses` (migration 3/4): `event_id NOT NULL REFERENCES events ON DELETE
  CASCADE`, `UNIQUE (event_id, provider)`, columns status, reason,
  still_ts, image, requested_at, took_ms, objects, raw, summary.
  `saveAnalysis` is an upsert on `(event_id, provider)`. `analysesFor`,
  `analysesInRange`, `unanalysed` (catch-up) and `countAnalysesByStatus`
  (the daily audit) all assume one analysis per event.
- `annotations` (migration 1): created empty "for the external-analysis
  phase", never used; stream type `annotation` reserved, never sent.
- `AnalyticsService`: one queue, one call at a time; limits `monthlyLimit`
  and `dailyCap` counted in `analytics_usage` per camera day; pauses
  `bad_key` (until a settings change, a new key or a restart) and `quota`
  (1 h); retry once after 30 s on network/timeout/5xx; the analysed JPEG is
  copied to `data/analytics/<cam>/<eventId>.jpg`.
- Retention (`storage.ts`): events after `eventsDays` (30), their analyses by
  cascade; then **every file in `data/analytics/<cam>/` that no `analyses`
  row names is deleted.** (A new table must join that keep-set, or its
  JPEGs vanish within the hour; see §1.4.)
- Stills: 1 per second, packs per minute, `readStill(ts)` builds the path
  from the number only (`minutePath`), 7 days (`stillsDays`), the current
  minute from memory.
- Compositions: `POST /api/cameras/{cam}/compositions` needs `clipId` (the
  anchor) plus optional `span`; `compositionWindow` requires ≥ 1 s of the
  span; `planComposition` picks per second: the clip, another clip, the
  still (held for the stills interval), else a "No recording" card. The
  ffmpeg runner already encodes still runs (10 fps output, 1 fps content,
  badge names the rate). Limits 300 s (120 s at 1080p), one encode at a
  time, 3 queued, results kept 15 min, ffmpeg at nice 10.
- Auth: client token (cams) or admin; `/control/analytics` is admin-only,
  so cams can't read the usage today. CSRF header for cookie sessions.
  Express limiter 6000/min (1200/min images).

**cams**
- Timeline: hour grid of minute tiles, the minute view's seconds (✦ on an
  automatically analysed second with a finding), the large still
  (`TimelineStill`: boxes, "Show all objects", #158), ◀ 1 s ▶ steps (#159)
  with a gap overlay.
- Cards are the camera's SD recordings; `attachAnalyses` gives a card the
  analyses whose event starts in [card start − 5 s, card end], computes
  `best` per category and `notConfirmed`, and the analysed stills for the
  Vision dialog (◀ ▶ through a card's stills).
- `AnalysisStore` keys live `analysis` messages **by eventId**: a second
  message with the same eventId replaces the first.
- The SSE relay passes `camera-event`, `clip`, `reset`, `camera-status` and
  `analysis` as `change` hints; unknown types are dropped.
- Save dialog: plain 600 s; generated 300 s, 120 s at 1080p
  (`server/clipLimits.ts` mirrors cam-proxy); cams keeps its own copy of the
  job ids (CodeQL request-forgery); names in camera-local time from the
  event id.
- Limits: API 600 / 5 min, images 20000 / 5 min, `requireSameOrigin` on
  writes.

**Measured on the Pi** (read-only GETs, 2026-10-04):

| What | Value |
|---|---|
| Vision usage | month 14 / limit 1000; today 2 / cap 30; not paused |
| Automatic analyses, last 8 days | 12, 0, 1, 12, 0, 0, 0, 0 per day (26; 18 with a finding) |
| Person events, 7 days | 34 (motion ~1000 in the last day) |
| Vision call (`tookMs`) | 597 ms |
| A still / an analysis JPEG | 143 KB / 136 KB |
| An analysis row as JSON | ~0.6 KB with 1 object (≤ ~5 KB with 20) |
| FTP clip coverage | 17% of the last 24 h; 0.86 GB of clips over 7 days |
| Disk | 192 GB free of 245 GB; budget 150 GB, 26 GB used; stills ~3.4 GB/day |
| Catalog | 3.4 MB |
| Request latency (lists) | 3–40 ms |

---

## 1. Data model and storage

### 1.1 A new table

```sql
-- 7: still checks (cams #179): Vision on a second picked by hand. Not
-- events; one per camera, second and provider; kept retention.eventsDays.
CREATE TABLE still_checks (
  id INTEGER PRIMARY KEY,
  cam TEXT NOT NULL,
  still_ts INTEGER NOT NULL,      -- the still's own time (a slot boundary)
  provider TEXT NOT NULL,         -- 'google-vision'
  requested_at INTEGER NOT NULL,
  requested_via TEXT NOT NULL,    -- 'token' (cams) or 'session' (admin UI)
  took_ms INTEGER,
  image TEXT,                     -- data/analytics/<cam>/check-<id>.jpg
  objects TEXT NOT NULL,          -- JSON [{name, mid, score, box}]
  raw TEXT,                       -- JSON, the provider's answer
  summary TEXT NOT NULL,          -- JSON SummaryEntry[]
  UNIQUE (cam, still_ts, provider)
);
CREATE INDEX still_checks_cam_ts ON still_checks (cam, still_ts);
```

- **Only successful calls are rows.** A refused or failed check is
  answered, audited and counted (a call that reached Google is in
  `analytics_usage`), but not stored, so trying again later is possible and
  "the same second twice" never returns a failure from yesterday.
- **No status/reason columns:** there is nothing but `ok` to store.
- **No `event_id`** (§1.2).
- The summary uses the same `summarize()` (class map, IoU merge, order),
  and unmapped objects are counted like the automatic ones.

Ruling: new table, not `analyses` — `analyses.event_id` is NOT NULL with a
per-event UNIQUE upsert; a check inside an event would overwrite (or be
overwritten by) the automatic result, and catch-up, the daily counts and the
day list would all need "but not manual" filters. SQLite can't drop NOT NULL
without rebuilding the table — cost if wrong: a later merge migration (copy
rows), about a day's work.

Ruling: not the unused `annotations` table — it has no still time, image,
objects or raw columns; packing them into `value` would make it a JSON blob
store — cost if wrong: none (it stays empty; it can be dropped in a later
migration).

### 1.2 The link to an event, and what "confirms" means

- **Linked events** are computed when read: the events of the camera with
  `start_ts ≤ still_ts ≤ COALESCE(end_ts, start_ts + events.maxOpenMin)`
  (camera events are per kind, so a second can sit in a motion and a person
  event at once). Index `events_cam_start` makes this cheap (the list is at
  most 1000 checks).
- **Confirms:** a linked event of kind person, vehicle or pet is confirmed by
  a check whose summary has that category (any score, as for the automatic
  analyses, whose summary already drops unmapped classes). A motion event
  is never "confirmed" (Vision has no "motion").
- The API returns `events: [{id, kind, confirmed}]` per check, and the
  stream message carries the same at creation time.

Ruling: compute, don't store — an event still open when the check is made,
an event recovered later by the inventory repair (#75), and the event's end
all change the answer; a stored `event_id` would be stale in exactly those
cases — cost if wrong: one join per list; storing it later is an additive
column.

**In cams** the cards are SD recordings, not proxy events, and cards already
take analyses by time. A check belongs to the card whose span contains its
`stillTs` (the same `cardFor` with the still time, no 5 s slack needed). It
confirms the card's triggers it finds (§3.6).

### 1.3 Retention

- Rows go with `still_ts < now − retention.eventsDays` (30 days), in the
  same retention run that deletes events. Not by cascade: there is no FK.
- The JPEG is copied at creation, so a check outlives its 7-day still. The
  Timeline shows the copy (`…/still-checks/{id}.jpg`), not the pack.
- After day 7 a check stays findable and viewable, but "Save clip around
  this" has no stills left there (§4.4).

Ruling: 30 days, the events' retention — a check is the "why" of a second,
and its neighbours (the event, the card) live 30 days too; one knob less
— cost if wrong: a new `retention.checksDays` setting, additive.

### 1.4 The image files (a required fix)

`storage.ts` deletes every file in `data/analytics/<cam>/` that no
`analyses.image` names. The keep-set becomes the union of
`analyses.image` and `still_checks.image`. File name `check-<rowid>.jpg`:
from the row id, never from the request. The copy is written after the row
exists (`INSERT … RETURNING id`, then write, then `UPDATE image`), and a
failed copy keeps the row without an image (as `storeOk` does): the result
was paid for.

### 1.5 Migration and versions

- Migration 7 (catalog version 6 → 7), additive only: one table, one index.
- A rollback to an older cam-proxy logs `catalog_newer_than_code` and runs;
  the table is ignored, its images are deleted by the old retention (they
  are unknown to it). Acceptable: the checks are information only.
- cams talks to an older proxy: `POST still-checks` answers 404 → the button
  says "this camera gateway is too old for checks" (from the `GET
  analytics` 404, §5.1).

### 1.6 Backup, inventory, audit

- **Backup:** there is none of the catalog today; nothing changes. The
  checks are in `catalog.sqlite` and `data/analytics/`, like the analyses.
- **Inventory:** no new kind. There is nothing to compare a check with
  (the camera knows nothing about it). The events inventory must not count
  checks: it doesn't, they are not events.
- **Audit:** a record per check request, `still-check`, category `host`,
  type `access`, user `client` or `admin`,
  `requestedBy` (`token` or `session`), `details: {stillTs, outcome:
  ok|reused|refused|failed, reason, cost: 0|1, tookMs, found: ['person']}`.
  Never the image or the key. `activity-daily` gains
  `analytics.checks: {calls, reused, refused, failed}` for the day.
  A refused request (400, 404) writes nothing, like elsewhere.

Ruling: audit every check that reaches the limits (each one can cost
money, and it is a user's action, unlike the automatic analyses, which are
counted daily) — cost if wrong: a few records a day; dropping them is a
one-line change.

The issue says "audited like other analyses": automatic analyses are only
counted in `activity-daily`; the checks get both the per-request record and
the daily count.

### 1.7 The Pi's disk

140 KB image + ≤ 5 KB row per check. At the manual cap (10 a day) for 30
days: ≤ 300 checks, ≤ 45 MB. Against 192 GB free and stills growing
~3.4 GB a day this is noise. The storage accounting doesn't count the
`analytics` folder (its kinds are stills, previews, clips, recordings,
catalog, audit). Ruling: leave it uncounted (45 MB at most,
already true for the analyses' images) — cost if wrong: a seventh kind in
the storage stats.

---

## 2. Triggering and budget

### 2.1 Who

Any signed-in cams user (the allow-list), through cams with the client
token; an admin through the cam-proxy admin UI later (phase 4). No new
role. cams passes nothing about the user to the proxy.

Ruling: no user identity at cam-proxy — the proxy has one client (cams);
cams logs who asked (its logger, with the e-mail it already has); the
proxy's audit says `requestedBy: token` — cost if wrong: an optional `by`
field later.

### 2.2 Limits, in order

A check is refused with **429 `limit`** and `reason`:
1. `off` → actually 409 `analytics_off` when Vision is switched off or has
   no key (cam2 in the cluster today).
2. `paused` → 503 `analytics_paused` with `bad_key` or `quota`, and
   `until`.
3. `month`: month usage ≥ `monthlyLimit`.
4. `day`: `dailyCap` > 0 and today's usage ≥ it.
5. `checks`: today's checks ≥ `analytics.googleVision.checksPerDay`
   (new, default 10, 0 = checks off, 0–1000).

Checks count in `analytics_usage` with the automatic calls (one Google bill,
one monthly limit). Their own count for (5) is a second usage row,
`provider = 'google-vision:check'`, bumped next to the main one for every
call made (ok or failed). Ruling: the second usage row — it survives restarts,
`pruneUsage` already cleans it, and it reads like the existing usage —
cost if wrong: nothing visible.

Ruling: a separate daily cap for checks, default 10 — with the Pi's
`dailyCap` 30 and a busy person day (12 analyses on day −3), unrestricted
checks could spend the cap at noon and the evening's person events would be
skipped `limit` — cost if wrong: one setting to raise.

### 2.3 Rate limits

- cam-proxy: one check call in flight per camera; a second request for a
  different second while one runs answers 429 `busy` (the automatic queue
  is not shared, so it never waits behind a user). The same second while
  in flight joins the running call (one call, both get the answer).
- cam-proxy route limiter: 20 / minute on `POST still-checks`.
- cams: per signed-in user 6 / minute and 60 / day on the POST (its own
  memory store; the ksvc is pinned to one replica, like the others).

### 2.4 Cost display

cams shows, next to the button: "14 of 1000 this month · 2 of 10 checks
today". From a new client-token `GET /api/cameras/{cam}/analytics` (the
public part of `/control/analytics`: enabled, paused, month, today,
checksToday; never the key or its mask). Over the free tier (1000/month)
the text adds "(about $0.0023 a check beyond 1000 a month)"; the price is
the one in docs/analytics.md, as a constant next to the text.

### 2.5 Idempotence

- A check row exists for `(cam, ts)`: 200 with it, `reused: true`, no call,
  no usage. The audit record says `reused`.
- An automatic analysis has `still_ts = ts` and status ok: 200 with that
  one, `source: 'event'`, `reused: true`. (Same image, same answer.)
- No "check again" button. Ruling: Vision answers the same image the same
  way (the cancelled "Check another still" in #179 is the same finding) —
  cost if wrong: a `force` flag later, which costs a call.

### 2.6 The call and its failures

- The still: `ts` must be an exact still time (`listStills(ts, ts)`),
  else 404 `no_still` (the gap overlay already disables the button). The
  current minute works (`readStill` reads it from memory).
- Timeout 10 s, **no retry** (the user is waiting; the button can be
  pressed again). A network error, timeout or 5xx: 502
  `provider_failed`, `reason: network|timeout|server`. The call counted.
- 400/401/403: pauses analytics `bad_key` for everyone, as today (it is the
  same key). 429: the hour's `quota` pause.
- The automatic queue's `stop()` also aborts a running check; it is then
  not stored (no row), but counted.

---

## 3. Showing and navigating

### 3.1 The button

Under the large still, in the bar with ◀ 1 s ▶: **"✧ Check with Vision"**.
- Disabled, with the reason as its title and in a small line: "Vision is
  off for this camera", "Vision is paused (invalid key)", "Monthly limit
  reached (1000)", "Today's checks are used (10)", "No still for this
  second", "Checking…".
- Already checked (or analysed with the event): the button reads "✧
  Checked 14:03:22" and only opens the result (no call).
- Pressing it: "Checking…", then the result replaces the plain still in
  place: the boxes (`TimelineStill` with the summary), "Show all objects"
  (#158), a line "Vision: Person 84%, Dog 61%" or "Vision: nothing
  relevant", and for a linked event "confirms the Person event 14:03:18".

### 3.2 Marks

- Seconds: ✧ (hollow star) for a check, ✦ stays for an automatic
  analysis; a second with both shows ✦.
- Minute tiles: a dotted purple corner for a minute with a check (any
  result, so a "nothing relevant" check is found again); the solid purple
  edge stays the automatic analyses' "Vision found something".
- The legend line under the heading names both.

Ruling: every check marks, even "nothing relevant" — the user asked for
it and wants to find it again; the automatic marks only show findings
because there are many — cost if wrong: a filter.

### 3.3 The list

Timeline header: a **"Checks (n)"** chip. Pressed, a list of the day's
checks opens above the hour grid: time, findings ("Person 84%" or
"nothing relevant"), the linked event ("in Person 14:03:18–14:03:40") or
"outside any event". A row opens that second (the minute view and the
large still, as a deep link `?t=` does).

The Video page: not in phase 2. Phase 4: a "Checks" mode of its sidebar
(a toggle next to the kind chips, exclusive: the list shows checks
instead of events), never mixed into the event list, the counts, the
event filter or the live panel.

Ruling: Timeline first — the button lives there, and the Timeline is
"seconds", the Video page is "recordings" — cost if wrong: the list
component moves to the Video sidebar (it is self-contained).

### 3.4 Opening one

- On the Timeline: the large still with boxes (above).
- From a card's Vision badge (Video page): the existing Vision dialog
  steps through the card's analysed stills; checks join that list, marked
  "✧ checked by hand 14:03:22". The object list (#158) loads from
  `GET …/still-checks/{id}` instead of `…/analyses/{eventId}`.

### 3.5 Prev / next

In the large still's bar: **◀ ✧** and **✧ ▶**: the previous and next
check of the day (disabled at the ends). Keyboard: Shift+← / Shift+→
(plain arrows stay the 1 s steps, #159). Across days: phase 4, the list
endpoint already takes up to 31 days.

### 3.6 Cards (confirmation in cams)

`attachAnalyses` gets the day's checks too. A check whose `stillTs` lies in
the card's span:
- for each category in the card's triggers that the check found: it counts
  for `best` (the "✦ Vision 84%" badge), shown as the automatic one's;
- a category the card doesn't have: ignored on the card (the check's own
  list and the Timeline show it);
- a check never produces `notConfirmed`.

Ruling: confirm-only on cards — "not confirmed" from a still the user
picked (maybe a second where the person had left) would be wrong more often
than right; "+ Pet" from a hand-picked second would put Vision's guesses on
the camera's cards — cost if wrong: a few lines in `attachAnalyses`.

### 3.7 Live updates

- cam-proxy sends a new stream type **`still-check`**: `{ id, stillTs,
  provider, summary, objects, events: [{id, kind, confirmed}] }`. Not
  `analysis`: cams's `AnalysisStore` keys `analysis` by eventId, so a check
  would replace the automatic result of the same event in the live map.
- cams's relay passes `still-check` as a `change` hint; the Timeline (any
  day, not only today) and the Video page reload the day's checks; the
  open still updates in place (like #109's live refresh).
- Replay: the stream keeps 7 days; an older cams ignores the type.

### 3.8 Untouched

The e-paper display (`/api/local/health`), the health summary, the stall
check (#93), the camera comparison (inventory), the event counts and
`activity-daily`'s event numbers, the camera itself. Nothing is pushed to
the camera.

---

## 4. Downloads around a check

### 4.1 Feasibility

Compositions need a clip today only as the **anchor** (the window's
reference and the "at least 1 s of the clip" rule). The rest already does
what is needed: per second, the clip that covers it (any clip, earliest
first), else the still (held for the stills interval), else a card. The
ffmpeg runner encodes still runs at 10 fps output with the "1 FPS" badge.
So the change is small:

- API: `POST /api/cameras/{cam}/compositions` takes **either** `clipId`
  (as today) **or** `at` (unix ms, a whole second).
- Plan: with `at`, the span is `{start: at, end: at + 1000}`;
  `compositionWindow(span, preS, postS, maxS)` unchanged (pre/post ≥ 0
  keep the second; a negative roll can't cut it away because of the 1 s
  rule). `planComposition` gets `clip` optional; `covering` searches all
  clips in the window.
- New refusal: a plan with no clip and no still second (all cards) →
  404 `nothing_to_compose` ("no recording or still around this second"),
  instead of encoding a video of cards.
- `at` within the last `retention.stillsDays + 1` days, else 404 the
  same way (nothing can be there).

Encoding time: a 21 s stills-only clip at SD is a few seconds on the Pi
(the spec's estimate is ~2.5 min for 300 s at SD); peak memory doesn't grow
with the length.

### 4.2 The dialog

The existing Save dialog (ComposeDialog) in a third mode, "around a
second": title "Save clip around 14:03:22", pre-roll and post-roll in
seconds (defaults 10 and 10 → 21 s), sizes SD/360p/720p/1080p (no 4K and no
plain save: there is no single recording to save as is), the same length
rule and words from `clipLimits.ts` with a 1 s "clip". A line says what
the clip will be made of, from a cheap planning call: "FTP clip 14:03:15–
14:03:40, stills before" or "stills only (1 per second)". Ruling: that line
comes from `POST …/compositions` with `dryRun: true` (answers the plan's
counts, no job) — cost if wrong: drop the line.

Entry points: under the large still ("Save clip around this", next to the
check button; it works on any second, checked or not), and in a check's
list row.

Ruling: on any second, not only checked ones — the mechanism doesn't
depend on the check, and "save that minute" (issue text) is useful
everywhere on the Timeline — cost if wrong: hide the button.

### 4.3 Naming

`<cam>-<YYYY-MM-DD_HH-MM-SS>-around-<size>.mp4` in the camera's local
time (cams has the camera's zone from its time settings,
`server/recordings/clipNames.ts`), e.g.
`cam1-2026-10-04_14-03-22-around-sd.mp4`.

### 4.4 Limits

- 300 s (120 s at 1080p), the existing constants; one encode at a time,
  3 queued, 429 `busy`; storage paused → 503.
- Stills are kept 7 days and FTP clips 7 days: after that, a check's
  "around this" has nothing (404 `nothing_to_compose`); the button is
  disabled with "Stills and clips are kept 7 days" when the second is older
  than `/extent`'s oldest still and clip.
- The SD card's recordings (Baichuan) are not a composition source.
  Ruling: not in this design — compose reads local files only; a
  recording would first have to be fetched into the cache, a separate
  feature — cost if wrong: an "around this" that uses the SD card is a
  follow-up issue.

---

## 5. API sketch

### 5.1 cam-proxy (client token unless noted)

| Method, path | Body / query | Answers |
|---|---|---|
| `POST /api/cameras/{cam}/still-checks` | `{ ts }` (unix ms, a still's time) | 201 `{check, reused:false}`; 200 `{check, reused:true, source:'check'\|'event'}`; 400 `invalid`; 404 `no_still`; 409 `analytics_off`; 429 `limit` {reason: month\|day\|checks}, `busy`, `rate_limited`; 503 `analytics_paused` {reason, until}; 502 `provider_failed` {reason} |
| `GET /api/cameras/{cam}/still-checks` | `from`, `to` (≤ 31 days), `limit` ≤ 1000 | `[{id, stillTs, provider, summary, events:[{id,kind,confirmed}]}]`, oldest first |
| `GET /api/cameras/{cam}/still-checks/{id}` | | the above plus `objects`, `requestedAt`, `tookMs`, `raw` |
| `GET /api/cameras/{cam}/still-checks/{id}.jpg` | | the analysed JPEG, immutable |
| `GET /api/cameras/{cam}/analytics` | | `{enabled, paused, month:{calls,limit}, today:{calls,cap}, checks:{today,cap}}` |
| `POST /api/cameras/{cam}/compositions` | `at` instead of `clipId`; `dryRun` | as today; 404 `nothing_to_compose` |
| stream `still-check` | | §3.7 |

`check` = `{ id, stillTs, provider, summary, objects, events }`. Also in
`openapi.yaml`, `docs/analytics.md` (a "Still checks" section),
`docs/audit-log.md`, the README's analytics settings, `config.schema.json`
(`analytics.googleVision.checksPerDay`).

The admin UI (phase 4): ✧ on the Timeline, and the checks in the Status
page's usage line.

### 5.2 cams

| Method, path | Does |
|---|---|
| `POST /api/cameras/:id/still-checks` `{ts}` | `requireSameOrigin`, per-user limit, relays; logs who |
| `GET /api/cameras/:id/still-checks?from&to` | relays, parsed with `parseSummary` |
| `GET /api/cameras/:id/still-checks/:checkId` | the objects (never `raw`, as for analyses) |
| `GET /api/cameras/:id/still-checks/:checkId.jpg` | streamed (`relayImage`), joins `IMAGE_PATH` |
| `GET /api/cameras/:id/analytics` | relays the usage for the button |
| `POST /api/cameras/:id/compositions` `{at, preS, postS, size, badge, timeZone}` | validates `at` (safe integer, whole second, not in the future, ≤ 8 days back), `resultLength(1, pre, post, max)`; relays; remembers the job id as today |
| SSE relay | adds `still-check` to the passed types |

---

## 6. Security

- **Auth:** client token (cams) or admin; the audit token can't (as
  `requireAccess('client')` does today). Cookie sessions need the CSRF
  header (`x-camproxy-ui`); cams's own `requireSameOrigin` on its POST.
- **Input:** `ts` and `at` by regex `^\d{1,15}$` / `Number.isSafeInteger`,
  then `ts % 1000 === 0`; the still is located by `minutePath(dataDir,
  'stills', cam, minuteOf(ts))` — numbers only, no request string in a
  path (CodeQL js/path-injection). The image file name comes from the row
  id. `{id}` by `^\d{1,12}$`, then a row lookup with `cam` checked.
- **cams → proxy URLs** are built from parsed numbers (as `stills/:file`
  today; CodeQL js/request-forgery). Composition job ids stay cams's own
  copies.
- **Rate limits:** §2.3; plus the budget is a hard stop.
- **Privacy:** Vision receives one SD still per check, nothing else, as
  documented. The key never leaves the proxy; the new `analytics` client
  endpoint has no key mask.
- **Abuse:** a script with a cams session could spend at most 10 calls a
  day (the checks cap) and never the monthly limit beyond its setting.

---

## 7. Tests (test doubles only, never Google)

cam-proxy
- Unit: the service's `check(ts)` with the fake provider: stored, reused
  (row; automatic analysis), each refusal in order (off, paused, month, day,
  checks), busy, joined in-flight call, timeout without retry, bad_key
  pauses the queue too, stop during a call; the image name from the row id;
  a failed copy keeps the row.
- Unit: migration 7 on a catalog with data; retention deletes old checks
  and keeps their images while the row lives (the keep-set union, the
  regression this design found); `pruneUsage` on the second usage row.
- Unit: the event link (open event, ended, recovered, two kinds at once,
  motion never confirmed).
- Unit: `planComposition` with `at` (clip covers all; part; none → stills;
  nothing → refusal), `compositionWindow` table extended.
- API: 400/404/409/429/503 shapes, the audit records, `activity-daily`.
- e2e: the vision mock (`test/helpers/vision-mock.ts`) scripted for one
  answer; check a second through the API; the stream message.

cams
- Server: the relay routes (status pass-through, parsing, limits,
  same-origin, `at` validation, names); the SSE type.
- `attachAnalyses` with checks: confirms, never `notConfirmed`, ignores
  other categories.
- Timeline: the button's states (each disabled reason), the result in
  place, the marks, the list, ◀ ✧ ▶ and Shift+arrows, the live refresh.
- ComposeDialog's "around" mode: defaults, limits, the dry-run line.
- livestack e2e (cams → cam-proxy → cam-sim) with the vision mock, never
  the real key; the real camera's proxy only for a manual look.

---

## 8. Phases

1. **cam-proxy: still checks** — migration 7, the service method, the
   endpoints, `checksPerDay`, the stream type, the audit record and daily
   count, the retention keep-set, docs and openapi. Release, update the Pi.
2. **cams: Timeline checks** — the button with its states and usage, the
   result in place, ✧ marks, the Checks list, ◀ ✧ ▶, live refresh, card
   confirmation in `attachAnalyses`, the Vision dialog listing checks.
3. **Around a second** — cam-proxy `at` and `dryRun` in compositions and
   `nothing_to_compose`; cams's dialog mode, the entry points, names.
   (Independent of 1–2; could go first if the download is wanted sooner.)
4. **Later** — the Video page's Checks mode, cross-day ◀ ✧ ▶, the admin
   UI's ✧ and usage line, an "around this" from the SD card.

---

## 9. Rulings (all)

1. Ruling: new table `still_checks` — `analyses` is one-per-event with an
   upsert and four queries that assume it — cost if wrong: a merge
   migration later.
2. Ruling: leave `annotations` unused — wrong columns — cost: none.
3. Ruling: the event link computed when read — open, recovered and ended
   events stay right — cost: a join; a column can be added later.
4. Ruling: store successful checks only — no stale failures, retry possible
   — cost: failures only in the audit log.
5. Ruling: confirm-only on cards, never "not confirmed", never "+ X" — a
   hand-picked second is no sample of the event — cost: a few lines.
6. Ruling: reuse for the same second (row or automatic analysis), no "check
   again" — same image, same answer — cost: a `force` flag.
7. Ruling: shared monthly limit and daily cap, plus `checksPerDay` (10) —
   protects the automatic person analyses — cost: one setting.
8. Ruling: one check call in flight, no retry, 10 s timeout — the user is
   waiting — cost: a press again.
9. Ruling: kept 30 days with its JPEG copy — like events — cost: an extra
   setting.
10. Ruling: analytics folder stays out of the storage kinds — ≤ 45 MB —
    cost: a stats kind.
11. Ruling: per-request audit record `still-check` plus a daily count — a
    user's action that may cost money — cost: a few records a day.
12. Ruling: no user identity at the proxy; cams logs who — one client —
    cost: an optional field.
13. Ruling: new stream type `still-check`, not `analysis` — cams keys
    `analysis` by eventId — cost: none.
14. Ruling: ✧ hollow marks for checks, every check marks — distinct from ✦,
    findable — cost: CSS.
15. Ruling: the list on the Timeline first; the Video page's mode later —
    cost: moving a component.
16. Ruling: Shift+←/→ for ◀ ✧ ▶ — plain arrows are #159's — cost: a key.
17. Ruling: compositions anchored by `at`, the same planner — clips where
    they cover, stills else — cost: none (additive).
18. Ruling: refuse an all-cards composition (404 `nothing_to_compose`) —
    a video of "No recording" helps nobody — cost: a message.
19. Ruling: "Save clip around this" on any second — the mechanism doesn't
    need a check — cost: hide it.
20. Ruling: no SD-card source for "around this" now — a separate fetch
    feature — cost: a follow-up issue.
21. Ruling: defaults −10/+10 s, no 4K, no plain save in "around" mode —
    no single file to save as is — cost: a default.
22. Ruling: the dry-run plan line in the dialog — tells "stills only"
    before the wait — cost: drop it.

## 10. Risks

- **Retention deleting the check images** (the keep-set): covered by a
  regression test in phase 1; the most likely bug.
- **Budget surprise:** a busy day's automatic analyses and checks share
  `dailyCap` 30; with `checksPerDay` 10 the automatic ones keep ≥ 20.
  Over the free 1000 a month the cost is $2.25 per 1000; worst case at the
  current settings is the monthly limit (1000), i.e. free.
- **A `bad_key` from a check pauses the automatic analyses** too: right
  (same key), but a user sees "paused" after their check; the message says
  how it lifts.
- **Two cards over one second** (a recording repeating the previous one's
  end): `cardFor` already picks one; the check confirms only that one.
- **Pi load:** a check is a 140 KB upload and a 600 ms call; an "around"
  composition is the existing encoder at nice 10, one at a time.
- **Stills-only clips look like slideshows** (1 fps); the badge says so.
  The dialog's plan line sets the expectation.
- **Clock zones:** names in camera time, the Timeline in the browser's
  (as today); a viewer in another zone sees different clocks in the name
  and the page — existing behaviour of the Save dialog.

## 11. Questions for Klaus

None blocking. Two to confirm when convenient (each has a ruling above):
- `checksPerDay` default 10 (§2.2)?
- "Save clip around this" on every second, not only checked ones (§4.2)?

---

## 12. Rulings during the build (phase 1, cam-proxy)

Made while building phase 1 unsupervised; each is cheap to change before
cams phase 2 ships.

23. Ruling: the request body is `{at}` (unix ms), not `{ts}` as the §5.1
    table said — the brief for phase 1 names it `at`, and phase 3's
    compositions use `at` for "a second" too: one name for one thing — cost
    if wrong: a field rename before cams uses it.
24. Ruling: a second the automatic analysis already sent creates **no row**;
    the answer is `200 {check, reused: true, source: 'event'}` with
    `check.id: null`, `check.eventId` and `check.imageUrl` pointing at the
    analysis image — no duplicate row or image, and the still-checks list
    stays "checks made by hand" (cams loads the analyses already) — cost if
    wrong: copy the analysis into a row on reuse.
25. Ruling: `at` is checked before anything else: a safe integer, a whole
    second, not in the future, and not older than the stills kept
    (`retention.stillsDays`, from the start of that UTC day, as retention
    deletes them) → otherwise 400 `invalid`. A stored check of an older
    second is read with `GET` — cost if wrong: move the stored-answer lookup
    before the window check.
26. Ruling: `checksPerDay: 0` answers 409 `analytics_off` with
    `reason: 'checks_off'` (`off` for Vision switched off, `no_key` for no
    key) — 0 is a switch, not a used-up limit — cost: a reason string.
27. Ruling: the daily counts (`activity-daily` `analytics.checks`) are kept
    as extra `analytics_usage` rows: `google-vision:check` (calls made),
    `google-vision:check-reused`, `…:check-refused`, `…:check-failed`
    — they survive restarts and are pruned with the usage; the monthly
    limit reads only `google-vision` — cost: none visible.
28. Ruling: a request for the second already in flight waits for that call
    and answers like a reuse (`200`, `reused: true`, `source: 'check'`), or
    the same failure; its audit record has `cost: 0` — cost: none.
29. Ruling: the client-token `GET /api/cameras/{cam}/analytics` (§2.4) is
    in phase 1: cams phase 2 needs it for the button, and it is additive —
    cost: none.
30. Ruling: a check's own call that Google answers 400/401/403 or 429
    answers 502 `provider_failed` with `reason: 'bad_key'` / `'quota'` (the
    call was made and counted) and pauses analytics as today; requests after
    it get 503 `analytics_paused` — cost: none.
31. Ruling: a check aborted by `stop()` answers 502 `provider_failed`
    `reason: 'aborted'` and stores nothing (counted) — cost: none.
32. Ruling: the admin UI's Analytics card gets a "Still checks per day"
    field next to the daily cap (every analytics setting has one there);
    the rest of the admin UI stays phase 4 — cost: a field.
33. Ruling: the POST has its own limiter, 20 per minute per client on top
    of the general one, counting the requests that pass the input check
    (a malformed one costs nothing and is in the general limit); the image
    `GET …/still-checks/{id}.jpg` counts in the image bucket (1200/min) like
    the analysis image — cost: none.
34. Ruling: retention reports `deleted.stillChecks` (rows) next to
    `deleted.events`, so the run result and the metric show them — cost: a
    label.
