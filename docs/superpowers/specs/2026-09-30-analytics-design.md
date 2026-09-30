# External analytics for camera events (design)

Status: approved by Klaus (2026-09-30).

## Goal

The camera's AI only says, per type, whether an alarm is on: person, vehicle,
pet or motion. It gives no confidence, no position, and no detail. cam-proxy
can send a still of an event to an external image-analysis service and keep
what comes back: the objects found, with a name, a score and a box.

That is a second opinion on the camera's label, shown in cam-proxy's own UI.
cams is not changed. It gets an extra field in the events it reads from
cam-proxy, and it ignores it.

Google Cloud Vision is the first provider. The design allows more, and later
a fallback from one to the next.

## Background (measured 2026-09-29 and 30)

- **Google Vision on 15 cam1 stills** (`~/Development/reolink/roboflow-samples/`):
  - 0.2–0.4 s per request.
  - People found in all four person images.
  - Cars and dogs were found when the tablet showing them was upright;
    upside down or tilted, it mostly reported the tablet.
  - No false person in the empty room.
- **Roboflow on the same stills:** more of the tablet pictures found, but
  more than 5 s per image, and a false person in the empty room.
- **Google's free tier:** 1,000 units per calendar month for each feature.
  Object localization is one feature: one image costs 1 unit. Beyond the free
  tier: $2.25 per 1,000 (Google's price list, checked 2026-09-30; $1.50 is
  the Label Detection price).
- **An API key can't read usage.** Google's own request counts need Cloud
  Monitoring and a service account (see Later).
- **Camera events:** the camera sends a motion event along with every
  person, vehicle and pet event. It names the picture of a clip after the
  detection, 4 s after the clip's start.

## Decisions (Klaus, 2026-09-30)

| Topic | Decision |
|---|---|
| Where | cam-proxy only. cams is unchanged. |
| Providers | A list; Google Vision is the first. |
| Key | Bring your own. It comes only from the environment: `.env`, or the cluster Secret. The UI shows the first and last four characters. |
| Limit | Calls, not money. Per calendar month (default 0 = no calls), plus an optional daily cap (0 = none). Counted per proxy. A note says that proxies sharing a key share one budget. |
| Features | Object localization only: 1 unit per call. |
| Event filter | Person, vehicle, pet (default: person only). Motion-only events are never analysed. |
| Image | cam-proxy's own still, 1 s after the event's start. |
| Storage | A separate table, linked to the event. The event row stays as the camera reported it. |
| Tests | A mock Google server in cam-proxy's test helpers. Real calls never run in CI, only in a manual script. |
| UI | Settings card, Status card, a tag on the Events page, a purple outline on the Timeline, and a modal with the boxes. |

## Configuration

### Settings

The settings live in `overrides.json` and are edited on the Settings page, like
the rest:

```json
"analytics": {
  "kinds": ["person"],
  "providers": [
    { "id": "google-vision", "enabled": false, "monthlyLimit": 0, "dailyCap": 0 }
  ]
}
```

- **`kinds`:** any of `person`, `vehicle`, `pet`, in any order. Anything else
  is rejected with 400, and so is an empty list.
- **`providers`:** one entry per known provider id. Unknown ids are rejected.
  - `enabled` (boolean).
  - `monthlyLimit`: 0–100,000.
  - `dailyCap`: 0–10,000; 0 means no cap.
- **Defaults:** as shown above, so a fresh proxy makes no calls.
- **When changes apply:** a saved change applies at once, with no restart. The
  service reads the running settings on every event.

### Secrets and environment

| Variable | Use |
|---|---|
| `CAMPROXY_GOOGLE_VISION_KEY` | The API key. Missing: the provider can't be enabled, and its card says how to set it. |
| `CAMPROXY_GOOGLE_VISION_URL` | The API's base URL, `https://vision.googleapis.com` by default. Tests and development point it at the mock. |

- **The key is never logged or returned in full.** The API and UI show it
  masked: `AIza…x7Qk` (first four and last four characters). A key shorter
  than 12 characters is shown as `set`.
- **Local `.env`:** it currently names the key `GOOGLE_VISION_KEY`; rename it
  to `CAMPROXY_GOOGLE_VISION_KEY`.
- **Cluster:** cam2's cam-proxy (connected to cam-sim) gets **no key**
  (Klaus, 2026-09-30), so analytics stays off there and can't use up the
  budget. The Secret stays as it is.
- **Pi:** the key goes into `/srv/cam-proxy/.env`.

## Behaviour

### Which events, when

- An event is queued when it **starts** and its kind is in `analytics.kinds`.
  It doesn't wait for the end of the event or the clip, since the still
  already exists.
- Motion events are never queued, even though every AI event comes with one.
- One call per event. A clip with three person events costs three calls.

### The image

- **Target:** the still at `start + 1 s`. That is about when the camera
  detected the subject, and when it takes its own picture.
- **Timing:** the service waits until that still exists: stills are written
  every `stills.intervalS`, so it waits at most 5 s.
- **Missing still:** it takes the nearest one within ±2 s. With none at all,
  the analysis is stored as `skipped`, reason `no_still`, and costs nothing.
- **Copy:** the JPEG used is copied to `data/analytics/<cam>/<eventId>.jpg`.
  Stills are kept for 7 days and events for 30, so without a copy the modal
  would lose its image.

### The queue

- One call at a time, in event order, in memory.
- **Nothing enabled:** when no provider is enabled and has a key, events
  aren't queued at all, and nothing is stored. Switched off, cam-proxy behaves
  as it does today, with no grey tags anywhere.
- **Before each call** the service checks, in this order:
  1. the provider isn't paused;
  2. the month's count is below `monthlyLimit`;
  3. today's count is below `dailyCap`, when one is set.

  If a check fails, the event is stored as `skipped`, with reason `paused` or
  `limit`. It is never retried later. A limit of 0 therefore gives a visible
  "not analysed (limit)" on each event that passes the filter.
- **Counting:** every request that is sent counts, whatever its result.
  Counts are kept per provider per day, in the camera's local date.
- **Timeout:** 10 s per request.

### Errors

| Result | Handling |
|---|---|
| Timeout, network error, HTTP 5xx | One retry after 30 s. If that fails too: `failed`, reason `timeout`, `network` or `http_5xx`. |
| HTTP 400 or 403: invalid key, API not enabled | `failed`, reason `bad_key`. The provider is **paused** until its settings or key change, or the proxy restarts. |
| HTTP 429: quota | `failed`, reason `quota`. The provider is paused for 1 h. |
| Any other HTTP status | `failed`, reason `http_<code>`, with no retry. |
| An unexpected body | `failed`, reason `bad_response`. |

The pause and its reason show on the Status card and in `/control/analytics`.

### After a restart

Events from the last 10 minutes that passed the filter and have no analysis are
queued again. Older ones stay without one.

### Retention

- An analysis is deleted with its event: the foreign key has
  `ON DELETE CASCADE`, and events are kept `retention.eventsDays`.
- The copied JPEG is deleted with it by the storage sweep.
- Usage rows are kept for 400 days: a year of months, for the Status history
  later.

## Providers

```ts
interface AnalyticsProvider {
  id: 'google-vision';
  name: string;                         // "Google Vision"
  analyze(jpeg: Buffer, signal: AbortSignal): Promise<ProviderResult>;
}
interface ProviderResult {
  objects: { name: string; score: number; box: { x0: number; y0: number; x1: number; y1: number } }[]; // box: fractions 0–1
  raw: unknown;                          // the provider's answer, for the modal
}
```

**Google Vision:**
- The request is `POST {base}/v1/images:annotate`, with the key in the
  `X-Goog-Api-Key` header, never in the URL.
- The body asks for `OBJECT_LOCALIZATION` only, with `maxResults` 20.
- `localizedObjectAnnotations[].boundingPoly.normalizedVertices` becomes the
  box: the smallest and largest x and y. Missing coordinates count as 0.
- An error answer, `error.status` or `error.message`, is mapped to the reasons
  in the Errors table.
- `raw` is the response with `localizedObjectAnnotations` only, a few KB.

## Storage

Migration: two new tables. `events` is unchanged.

```sql
CREATE TABLE analyses (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,          -- ok | skipped | failed
  reason TEXT,                   -- null for ok
  still_ts INTEGER,              -- the still used
  image TEXT,                    -- path of the copied JPEG
  requested_at INTEGER NOT NULL,
  took_ms INTEGER,
  objects TEXT,                  -- JSON: [{name, score, box}]
  raw TEXT,                      -- JSON
  UNIQUE (event_id, provider)
);
CREATE TABLE analytics_usage (
  provider TEXT NOT NULL,
  day TEXT NOT NULL,             -- YYYY-MM-DD, camera-local
  calls INTEGER NOT NULL,
  PRIMARY KEY (provider, day)
);
```

## API

- **`GET /api/cameras/{cam}/events`** (client token): each event gets
  `analysis`: `{provider, status, reason, objects}` or `null`. Objects come
  without `raw`.
- **`GET /api/cameras/{cam}/events/{id}/analysis`:** the whole record,
  including `raw`, `stillTs`, `requestedAt` and `tookMs`. 404 without one.
- **`GET /api/cameras/{cam}/events/{id}/analysis.jpg`:** the analysed image.
  404 without one.
- **Event stream:** a new message type, `analysis`, with
  `{eventId, provider, status, reason, objects}`, sent when an analysis is
  stored. The Events and Timeline pages update from it.
- **`GET /control/analytics`** (admin): per provider:
  - `enabled` and the masked key (`keyMasked`, or `null`);
  - `month: {calls, limit}` and `today: {calls, cap}`;
  - `paused: {reason, until} | null`;
  - `lastCall: {at, tookMs, status} | null` and `lastError`.
- **`PUT /control/settings`:** takes `analytics` like the other sections. The
  validation is the one in Configuration.
- **Docs:** `openapi.yaml`, the README and the CHANGELOG describe all of it.

## Web UI

Analytics has its own colour, purple (`#a855f7`), in both themes. Red, blue,
green and amber stay reserved for the event kinds.

### Settings: the "Analytics" card

- **Event kinds:** checkboxes for person, vehicle and pet. A note under them:
  "Motion-only events are never analysed."
- **One sub-card per provider**, Google Vision first:
  - an on/off switch;
  - the key, `AIza…x7Qk`, or "Not set: add `CAMPROXY_GOOGLE_VISION_KEY` to
    the environment and restart";
  - the monthly limit and the daily cap;
  - the estimate, for example "1,000 a month: free (Google's first 1,000 a
    month are free, then $2.25 per 1,000)";
  - the note: "The limit counts this proxy's calls only. Proxies that share a
    key share Google's budget: keep their limits' total within it."
- The switch is disabled while there is no key.

### Status

- One card per provider, for example: "Google Vision: 23 of 1,000 this
  month · 4 today · last 14:02 (0.3 s)".
- It adds "Paused: invalid key", or "Last error: …", when there is one.
- With no provider enabled: a single card, "Analytics: not enabled".

### Events page

An analysed event gets a tag after its duration:

- **`ok`:** "✦ Vision: Person 0.78, Car 0.81", at most three names, highest
  score first. With nothing found: "✦ Vision: nothing found".
- **`skipped` or `failed`:** a grey "✦ not analysed (limit)", or its reason.

Clicking the tag opens the modal. A skipped or failed tag opens it too; the
modal then shows only the reason.

### Timeline

- **Hour grid:**
  - A minute with an analysed event keeps its event-colour frame and gets a
    second, purple outline.
  - A minute with more than one event shows "×2" or "×3" in the corner.
  - Both appear whether or not analytics is on.
- **Minute view:**
  - Each analysed still gets a purple highlight and a small ✦. Clicking it
    opens the modal instead of the plain still.
  - Its event line gets a "✦ Vision" link.
  - If the analysed still falls into another minute, the event line's link
    still opens the modal.

### The modal

- **Image:** the analysed image, with each box drawn over it (an SVG
  overlay) and labelled with its name and score.
- **Objects:** a table of name and score.
- **Details:**
  - the camera's own event: kind and start–end;
  - the provider;
  - when it ran and how long it took;
  - the status and reason.
- **Raw answer:** a "Raw answer" section, collapsed.
- **Closing:** ✕, Esc, or a click outside. Focus stays inside the modal while
  it is open.

## Testing

- **Mock Google server** (`test/helpers/vision-mock.ts`):
  - serves `POST /v1/images:annotate` and checks the key header;
  - answers with a scripted list: objects, an HTTP status, or a delay;
  - counts the calls.

  The unit tests and e2e point `CAMPROXY_GOOGLE_VISION_URL` at it.
- **Unit tests:**
  - settings validation;
  - the filter: person only, and motion never;
  - choosing the still: +1 s, ±2 s, none;
  - the checks before a call, in order;
  - monthly and daily counting across a month's end and a DST change;
  - each error mapping, the retry, the pause and its end;
  - the queue after a restart;
  - the migration and the cascade on event deletion;
  - the masked key;
  - mapping Google's vertices to a box, including missing coordinates.
- **e2e** (cam-sim + the mock):
  - saving the Settings card;
  - a cam-sim person event gets analysed;
  - the tag on the Events page;
  - the Timeline's purple outline and ×2;
  - the modal with its boxes;
  - Status counts the call;
  - with the limit at 0, no call reaches the mock.
- **Real Google:** `scripts/analytics-live.ts` sends given images, with its own
  limit (default 5). It is never run in CI. It prints the time and the objects
  per image.

## Later (not in this work)

- **Google's own count** from Cloud Monitoring (the Vision request count for
  the project), with a service account and the Monitoring Viewer role as a
  second secret. The Status card would show the whole project's count, and
  the limit would apply to it. The metric and the role are to be checked then.
- **More providers,** and switching to the next when one is paused or at its
  limit.
- **More than one still per event,** such as the start and the middle.
- **A mock inside cam-sim,** for a free end-to-end loop on cam2 in the cluster.
- **Showing the analysis in cams.**
