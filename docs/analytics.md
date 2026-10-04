# Analytics

How cam-proxy asks Google Vision for a second opinion on the camera's person,
vehicle and pet events, what it keeps, and how the result reaches the admin
UI and cams. The class table it maps Google's objects to is in
[analytics-classes.md](analytics-classes.md). Settings, keys and costs are
summarized in the README, section "Analytics (optional)".

## What it is for

The camera labels an event as person, vehicle, pet or motion with its own AI.
Analytics sends one still of the event to Google Vision's object localization
and keeps what Google sees. The camera's label always stands. Vision only
adds a confidence ("Vision 78%"), or says it found nothing ("not confirmed").

Measured on cam1 (2026-09-30):
- **Agreement:** Google agreed with the camera on 6 of 7 person events.
- **The miss:** a person seated at the image edge, about 40 px tall in the
  896 × 512 SD still. The camera's AI works on the 12 MP picture.
- **Noise:** Google reports everything it recognizes, such as ceiling fans,
  clothing and monitors. It sometimes reports the same person twice, with the
  same box.

## The flow, per event

1. **Which events.** An event of a kind switched on in Settings: person by
   default, and vehicle and pet when switched on. Motion-only events are never
   analysed. After a restart, events of the last 10 minutes that were never
   analysed are queued too.
2. **The still.** The still 1 s after the event's start, where the detection
   is. Otherwise the nearest still within ±2 s. cam-proxy waits up to 5 s for
   it to arrive. With no still, the analysis is *skipped* (`no_still`).
3. **Limits.** A call is made only while both the monthly limit and the daily
   cap allow it, counted in camera time. Otherwise the analysis is *skipped*
   (`limit`).
4. **The call.** `POST https://vision.googleapis.com/v1/images:annotate` with
   the JPEG and `OBJECT_LOCALIZATION`, `maxResults: 20`. It times out after
   10 s.
   - A network error, a timeout or a 5xx is retried once after 30 s.
   - A 400, 401 or 403 pauses analytics (`bad_key`) until an analytics
     setting changes (for example, switch analytics off and on in Settings),
     a new key is set in Settings, or the proxy restarts.
   - A 429 pauses it for an hour (`quota`).
   - Events that arrive while paused are *skipped* (`paused`).
   - No call is made for an event that retention removed meanwhile. A call
     that failed and wasn't retried (switched off, or the proxy stopping) is
     stored as *failed*.
5. **Stored.** Each event's analysis is kept in the catalog:
   - the status (`ok`, `skipped` or `failed`) and the reason;
   - the still's time;
   - the full object list and Google's raw answer;
   - the **summary** (below).

   The analysed JPEG is copied to `data/analytics/<cam>/<eventId>.jpg`, so it
   outlives the 7-day stills. An analysis is deleted with its event (30 days).
6. **Sent.** An `analysis` message goes out on the event stream (below).

## The summary

The summary is what clients use. The full object list stays for debugging and
the admin UI's "Show all objects".

1. **Map.** Each object is mapped to a category by its Open Images class id
   (`mid`), or by name when there is no `mid`, using the table in
   [analytics-classes.md](analytics-classes.md). The categories are `person`,
   `vehicle` and `pet`; the subtype is the class name in lower case (`man`,
   `van`, `dog`). Objects that don't map are left out of the summary.
2. **Merge.** Two entries of the same category whose boxes overlap by more than
   90% (intersection over union) become one: the higher score, with its
   subtype and box. Different categories on one box stay apart, so a person
   holding a dog picture gives two entries.
3. **Order.** The entries are ordered by score, highest first.

The summary is computed when the analysis is stored. Analyses stored before
v2026.09.30.5 get theirs on the first start (the log says
`analytics_summaries_backfilled`), and until then it is computed when read.
Skipped and failed analyses have an empty summary.

An entry: `{ "category": "person", "subtype": "person", "score": 0.84, "box": { "x0": 0.16, "y0": 0.62, "x1": 0.23, "y1": 0.99 } }`.
Box coordinates are fractions of the image, from the top left.

## Objects that don't map

Every object of an `ok` analysis that doesn't map is counted per class id (or
name), with the time it was last seen. The startup backfill counts nothing,
so a restart doesn't inflate the list.

- **Status page:** the card "Analytics · objects seen, not mapped" lists the
  20 most frequent.
- **Control API:** `GET /control/analytics/unmapped` lists all of them;
  `DELETE` clears the list.

This is where candidates for the class table come from. To add a class, see
[Extending](analytics-classes.md#extending).

## Still checks

A still check is Vision on a second picked by hand (cams #179, spec
`docs/superpowers/specs/2026-10-04-still-checks-design.md`): cams's Timeline
sends any second that has a still, not only an event's. The result is a
**check**, stored apart from the events and their analyses.

1. **The request.** `POST /api/cameras/{cam}/still-checks` `{"at": <unix ms>}`
   with the client token (or as an admin; a session needs `X-CamProxy-UI`).
   `at` is a still's time: a whole second, not in the future, not older than
   the stills kept (`retention.stillsDays`). The still must exist (else
   404 `no_still`).
2. **A stored answer first.** A second checked before is answered from its
   check (`200`, `reused: true`, `source: "check"`); a second an automatic
   analysis already sent from its analysis (`source: "event"`, `id: null`,
   `eventId`). No call, no cost. There is no "check again": Vision answers the
   same image the same way.
3. **Limits, in order.** Vision off, no key, or `checksPerDay` 0: 409
   `analytics_off` (`reason` `off`, `no_key`, `checks_off`). Paused: 503
   `analytics_paused`. Then 429 `limit` with `reason` `month` (the monthly
   limit), `day` (the daily cap; both shared with the automatic analyses), or
   `checks` (`analytics.googleVision.checksPerDay`, default 10 a camera day,
   so checks can't spend the cap the person events need). One check at a
   time: another second meanwhile is 429 `busy`; the same second waits for
   the running call and gets its answer. At most 20 requests a minute per
   client.
4. **The call.** As for events, but with no retry (the user is waiting): a
   network error, timeout (10 s) or 5xx is 502 `provider_failed` with the
   reason, counted, and nothing is stored, so pressing again can work. A 400,
   401 or 403 pauses analytics (`bad_key`) for the events too (one key); a
   429 pauses it for an hour (`quota`).
5. **Stored.** Successful checks only, in the `still_checks` table: the
   second, the objects, the raw answer and the summary (the same mapping as
   above; unmapped objects are counted too). The JPEG is copied to
   `data/still-checks/<cam>/check-<id>.jpg` (its own folder, apart from the
   analyses' images), so a check outlives the 7-day
   stills. Checks are kept as long as events (`retention.eventsDays`, 30 days).
6. **The events it sits in** are computed when read, never stored: the
   camera's events with start ≤ second ≤ end (an open one counted
   `events.maxOpenMin` from its start). A person, vehicle or pet event is
   `confirmed` when the check found its category; a motion event never is.
   A check never says "not confirmed".
7. **Sent.** A `still-check` stream message for each new check (not for
   stored answers).
8. **Counted.** Every call in the usage (`month`, `today`) next to the
   automatic ones, and the checks per day apart (`checks.today`). Each
   request past the input check writes a `still-check` audit record, and
   `activity-daily` counts the day's checks.

Ask `GET /api/cameras/{cam}/analytics` for the budget (`enabled`, `paused`,
`month`, `today`, `checks`); it never shows the key. Reads:
`GET /api/cameras/{cam}/still-checks?from&to` (at most 31 days, oldest
first), `GET …/still-checks/{id}` (with the raw answer) and
`GET …/still-checks/{id}.jpg`.

## Where it shows

**cam-proxy's admin UI:**
- **Events:** a tag per event, e.g. "✦ Vision: Person 0.84", "✦ Vision:
  nothing relevant", or "✦ not analysed (limit)". A click opens the
  analysis: the still with the summary's boxes, a "Show all objects" switch,
  and the raw answer.
- **Timeline:** a purple mark on minutes with a relevant finding, and ✦ on
  the analysed second.
- **Status:** usage this month and today, and the unmapped objects.
- **Settings:** the switches, the limits, and a cost estimate for the monthly
  limit.

**cams** (cams.skylar.technology):
- **Event cards (History and Live):** a badge next to the camera's label.
  - "✦ Vision 84%" when Vision agrees with the label.
  - "✦ Vision: not confirmed" when an analysis of that kind found none.
  - "+ Pet 70%" for a finding the camera didn't label.
- **Timeline:** the same marks as cam-proxy's, and the analysed still with
  boxes.

## API

| What | Where |
|---|---|
| An event's analysis, short | `analysis` on `GET /api/cameras/{cam}/events`: status, reason, still time, summary, objects |
| An event's analysis, full | `GET /api/cameras/{cam}/events/{id}/analysis` (with the raw answer) and `…/analysis.jpg` |
| A day of analyses (for cams) | `GET /api/cameras/{cam}/analyses?from&to`: the analyses of events that start in the range, oldest first. At most one day and 1000 items |
| Live | the `analysis` stream message: `{ eventId, kind, start, end, provider, status, reason, stillTs, summary, objects }`. `end` is null while the event is open |
| State and usage | `GET /control/analytics`, and `analytics` in `GET /control/status` |
| Unmapped objects | `GET` / `DELETE /control/analytics/unmapped`, and the top 20 as `analyticsUnmapped` in `/control/status` |
| Still checks | `POST /api/cameras/{cam}/still-checks` `{at}`; `GET …/still-checks?from&to`, `…/still-checks/{id}`, `…/still-checks/{id}.jpg`; the `still-check` stream message: `{ id, stillTs, provider, summary, objects, events, imageUrl, requestedAt, tookMs }` (see [Still checks](#still-checks)) |
| The budget, for clients | `GET /api/cameras/{cam}/analytics`: `{ enabled, paused, month, today, checks }`, no key |

The stream keeps 7 days of messages, so a client resuming after the upgrade
can replay older `analysis` messages without kind, start, still time or
summary. Treat a missing `summary` as unknown, not as "nothing found". The
full contract is in [openapi.yaml](../openapi.yaml).

## Privacy and cost

- **Privacy:** Vision receives one SD still (896 × 512) per analysed event or
  still check, and nothing else.
- **Key:** the key lives in the environment (`CAMPROXY_GOOGLE_VISION_KEY`,
  in `/srv/cam-proxy/.env` on the Pi). It is never in config.json, the UI
  (masked), logs or the API.
- **Key from the Settings page:** an admin can set or override the key at
  runtime (`PUT /control/secrets/google-vision-key`). It is used from the next
  call on and lifts an invalid-key pause, lives in memory only, and a restart
  of the process restores the environment's key (or none). The provider state
  reports `keySource` (`env`, `manual` or `none`) and the masked key; each set
  is audited as `secret-override` with the first and last four characters.
- **Cost:** Google's first 1,000 images a month are free, then $2.25 per 1,000
  (checked 2026-09-30).
- **Limits:** the monthly limit and the daily cap are cam-proxy's own count.
  Proxies that share a key share Google's budget.
- **Where it runs:** cam1's proxy on the Pi has the key. cam2's proxy in the
  cluster has none, so analytics is off there. The Settings field can give
  it one until its next restart.

## Testing

- **Tests:** they never call Google. Unit tests use a fake provider, and e2e
  uses a mock server (`test/helpers/vision-mock.ts`, scripted through
  `POST /script`).
- **Fixture:** the real 15:26 answer from cam1 is kept as JSON only, with no
  image (`test/fixtures/vision-cam1-2026-09-30.json`).
- **Live check, by hand only:**
  `CAMPROXY_GOOGLE_VISION_KEY=… npx tsx scripts/analytics-live.ts a.jpg`
  sends up to `LIMIT` (default 5) images. Never run it in CI.

## Later

- **Full-resolution second look:** when Vision finds no person where the
  camera did. The camera's snapshot is 4512 × 2512, but it shows the moment
  it is taken, not the event.
- **More classes:** after experiments, e.g. bicycles and other animals (cams
  issue #108).
- **Detail settings:** zones, and a minimum confidence.
- **Other providers;** usage from Google Cloud Monitoring.
