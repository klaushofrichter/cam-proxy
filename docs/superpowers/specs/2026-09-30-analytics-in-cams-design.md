# Analytics summary and analytics in cams (design)

Status: design agreed with Klaus in chat (2026-09-30). This is the spec for
review. It spans two repositories: cam-proxy (this spec lives here, because it
defines the interface) and cams.

## Goal

cam-proxy analyses person events with Google Vision (v2026.09.30.4, spec
`2026-09-30-analytics-design.md`). Google reports everything it recognises:
people, but also the ceiling fan, clothing, a monitor, sometimes the same
person twice. This step:

1. **In cam-proxy:** reduces each analysis to a **summary**. It keeps only
   persons, vehicles and pets, one entry per kind, with the best score. The
   full answer stays for debugging.
2. **cam-proxy → cams:** delivers that summary to cams, live and when a day is
   loaded.
3. **In cams:** shows the summary on the event cards as a confidence badge.
   The Timeline is rebuilt on cam-proxy's model, with the analysed still and
   its boxes.

## What we learned (2026-09-30, cam1 on the Pi)

- **Agreement:** Google agreed with the camera on 6 of 7 person events.
- **The miss (15:48:21):**
  - The person sat at the right edge, partly hidden. In the SD still (896 ×
    512) the person is about 40 px tall.
  - The camera's AI sees the 12 MP picture. Google saw only the fan, a
    monitor and an appliance.
- **Duplicates:** Google sometimes returns the same object twice with the same
  box, e.g. Person 0.74 and Person 0.65. Different names can also share one
  box, e.g. "Ceiling fan" and "Mechanical fan".
- **No full-resolution picture of the event's moment is easy to get.** The
  camera's snapshot shows the current moment. The 4K recording can't be
  downloaded from this camera, and FTP uploads carry the SD stream. A
  full-resolution "second look" is left for later (see Later).

## Decisions (Klaus, 2026-09-30)

| Topic | Decision |
|---|---|
| What cams receives | A summary: category (person, vehicle, pet) plus a subtype (Google's class name). Duplicates are merged and the higher score is kept. The raw answer stays in cam-proxy for debugging. |
| Classes | Mapped by Open Images class id (`mid`) in a starting table (below). Unmapped objects are logged so the table can grow after experiments. |
| Disagreement | The camera's label always stands. Vision only adds confidence. "Camera: person, Vision: none" shows as "not confirmed". |
| Delivery | Push: the `analysis` stream message carries the summary. cams also fetches a day's analyses when it loads the day. |
| cams cards | An analytics marker plus the confidence as a percentage, e.g. "Vision 78%". |
| cams Timeline | cam-proxy's model: a minute opens a 60-second view under its hour (tinted). A second opens the large still with boxes. "Open in History" opens History at that second, **paused, without boxes**. The top viewer and "Show in timeline grid" go. |
| Later | The full-resolution second look; other providers; usage from Cloud Monitoring. |

## The classes

Google does not publish the list of objects that object localization can
return. Its documentation says only that each result has a `mid`, a
machine-generated Knowledge Graph id
(https://docs.cloud.google.com/vision/docs/object-localizer). A community
answer in Google's Vision forum says the classes come from Open Images
(https://groups.google.com/g/cloud-vision-discuss/c/Gpo2h-Rw7gA); no Google
staff confirmed this.

Open Images publishes its 600 detection ("boxable") classes, each with a `mid`
(https://storage.googleapis.com/openimages/v5/class-descriptions-boxable.csv).
Every object Google returned for cam1 on 2026-09-30 is in that list with the
same id: Person `/m/01g317`, Ceiling fan `/m/03ldnb`, Mechanical fan
`/m/02x984l`, Clothing `/m/09j2d`. So the list is very likely the one Vision
uses.

- **What it means for us:** there is no "SUV", "Sedan" or "Baby" class. Those
  names come from Google's web detection, a different feature, or from a guess.
  Vehicles come as Car, Truck, Van and so on; animals as Dog, Cat, or the
  generic Animal, Mammal, Carnivore.

**Mapping (by `mid`; subtype = the class name in lower case):**

| Category | Classes |
|---|---|
| person | Person `/m/01g317`, Man `/m/04yx4`, Woman `/m/03bt1vf`, Boy `/m/01bl7v`, Girl `/m/05r655` |
| vehicle | Car `/m/0k4j`, Truck `/m/07r04`, Van `/m/0h2r6`, Bus `/m/01bjv`, Taxi `/m/0pg52`, Ambulance `/m/012n7d`, Limousine `/m/01lcw4`, Motorcycle `/m/04_sv`, Golf cart `/m/0323sq`, Land vehicle `/m/01prls`, Vehicle `/m/07yv9` |
| pet | Dog `/m/0bt9lr`, Cat `/m/01yrx`, Animal `/m/0jbk`, Mammal `/m/04rky`, Carnivore `/m/01lrl` |

- **Unmapped at first:**
  - Human face, which is part of a person, not a separate one.
  - Bicycle: the camera's "vehicle" means motor vehicles.
  - Bird, Horse and other animals: the camera's "pet" means dog and cat.
  - Everything else.
- **Matching:** by `mid`. If a result has no `mid`, match its name
  case-insensitively.
- **Docs:** `docs/analytics-classes.md` holds this table, the source note above,
  and the full 600-class list, so the table can be extended by choosing from
  it.

## cam-proxy

### The summary

For each stored analysis with status `ok`, cam-proxy computes:

```ts
summary: { category: 'person' | 'vehicle' | 'pet'; subtype: string; score: number; box: Box }[]
```

1. Map each object by `mid`. Objects that don't map are left out.
2. **Merge duplicates:** two entries with the same category whose boxes
   overlap by more than 90% (intersection over union) become one entry. The
   higher score and its subtype and box win.
3. **Order:** by score, highest first.

- **Timing:** computed when the analysis is stored and kept with it in the
  new column `analyses.summary`. Analyses stored before this change get
  theirs computed on startup, from their stored objects.
- **Raw data:** the raw answer and the full object list stay unchanged.

### Unmapped objects

- **Stored:** a table `analytics_unmapped (mid, name, count, last_seen)` counts
  every object that did not map, over all analyses.
- **Status page:** a card "Analytics · objects seen, not mapped" lists the 20
  most frequent (name, mid, count) and links to `docs/analytics-classes.md`.
- **Reading and resetting:** `GET /control/analytics/unmapped` returns the
  full list. `DELETE /control/analytics/unmapped` clears it.

### API and stream

- **`GET /api/cameras/{cam}/events`:** `analysis` gains `summary` and `stillTs`
  (`stillTs` is already there). `objects` stays for cam-proxy's own UI.
- **The `analysis` stream message:** carries everything a client needs without
  a further request:

  ```json
  { "eventId": 365, "kind": "person", "start": 1790801301000, "end": 1790801306000,
    "provider": "google-vision", "status": "ok", "reason": null,
    "stillTs": 1790801302000, "summary": [{ "category": "person", "subtype": "person", "score": 0.84, "box": {"x0":0.16,"y0":0.62,"x1":0.23,"y1":0.99} }] }
  ```

  `end` is null while the event is open.
- **`GET /api/cameras/{cam}/analyses?from&to`** (new): the analyses of the
  events that start in the range, in the message's shape, oldest first.
  - At most one day per request; the limit is 1000.
  - cams uses it when it loads a day.

### cam-proxy's UI

- **Events tag:** built from the summary, e.g. "✦ Vision: Person 0.84".
- **Nothing mapped:** "✦ Vision: nothing relevant".
- **Skipped or failed:** unchanged ("✦ not analysed (limit)").
- **Modal:**
  - draws the summary's boxes by default, one label per box and nothing
    hidden;
  - a "Show all objects" switch draws the full list;
  - "Raw answer" is unchanged.
- **Timeline:** the ✦ and the purple mark count only analyses with a
  non-empty summary. An analysis that found nothing relevant keeps the "✦
  Vision" link on the event line.

## cams

### Receiving

- **Live:** the cams server's proxy stream subscribes to `analysis` too.
  Today it subscribes to `camera-event,camera-status,clip`. It relays the
  message to browsers like the others. The server keeps the analyses it has
  received per camera for the current and the previous day.
- **When a day loads:** for a camera with a proxy, the cams server fetches
  that day's analyses from `/api/cameras/{cam}/analyses` and caches them.
  The cache lasts 60 s for today and 1 h for past days, and a received
  message updates it.
- **Missed messages:** after a cams restart, or while the proxy was
  unreachable, the next day load fills the gap.
- **Matching to cards:**
  - A card is a recording `[start, end]`. An analysis belongs to it when its
    event start falls in `[start − 5 s, end]`; the 5 s cover the camera's
    pre-record and clock slack.
  - One card can hold several analyses: person, its motion, another person.
- **The events API:** `GET /api/cameras/:id/events` gains, per card:

  ```ts
  analysis?: {
    best: Record<'person'|'vehicle'|'pet', { score: number; subtype: string } | undefined>;
    notConfirmed: ('person'|'vehicle'|'pet')[]; // camera said it, no ok analysis found it
    stills: { eventId: number; stillTs: number; summary: SummaryEntry[] }[];
  }
  ```

  - `best`: the highest score per category over the card's `ok` analyses.
  - `notConfirmed`: the card's AI triggers that at least one `ok` analysis
    covered but none found.
  - `analysis` is absent when no analysis matched. It is absent too when every
    matched analysis was skipped or failed.

### Event cards

The History list and the Live panel's list use the same component.

- **Agreement:** next to each camera label that `best` confirms, a badge "✦
  Vision 78%" (rounded, purple `#a855f7` as in cam-proxy).
- **Disagreement:** for a category in `notConfirmed`: "✦ Vision: not confirmed"
  (muted). The camera's label stays.
- **Extra finding:** for a category in `best` that the camera did not report,
  a muted "+ Pet 70%". The card's own labels are unchanged.
- **Detail:** the tooltip names the subtype(s), e.g. "Vision: dog 0.70, cat
  0.55".
- **No analysis** (motion only, limit, off, or no proxy): no badge. The card
  looks as it does today.

### Timeline

cams' Timeline takes cam-proxy's model and replaces today's top viewer, "Show
in timeline grid" and its red frame.

- **Minute view:**
  - A minute click opens the 60-second view **inside its hour card**, under
    that hour's thumbnails.
  - It has a tinted background, and nothing scrolls.
  - ◀ ▶ and ← → step within the hour.
  - It names the minute's events (kind, start–end) and frames their seconds
    in the event colours.
- **Marks:**
  - Minutes with an analysis that has a non-empty summary get the purple mark.
  - Minutes with more than one event show "×2" or "×3".
  - The analysed second gets the ✦.
- **Large still:**
  - A second click opens the large still under the minute view.
  - For an analysed second it draws the summary's boxes with labels.
  - A "Show all objects" switch draws the full list, fetched from the proxy's
    analysis record through the cams server.
- **"Open in History":** under the large still. It opens History at that
  second, **paused**, without boxes. It keeps today's shared cursor (the view
  point that History and Live share).
- **Images:** the analysed still is the cam-proxy's still at `stillTs`, served
  as today's stills are, so no new image route is needed.

### Unchanged in cams

The camera's own labels, the Live page's other behaviour, downloads and
settings. Cameras without a proxy show no analytics.

## Testing

- **cam-proxy:**
  - **Unit tests:** mapping by `mid` and by name; merging (>90% overlap, same
    category; different categories on one box stay apart); ordering; the
    summary of today's real answers from cam1, kept as fixtures with no images
    (only the JSON); the backfill; unmapped counting and reset; the
    `/analyses` range endpoint.
  - **e2e (mock server):** the modal shows summary boxes and "Show all
    objects"; the Events tag uses the summary; the Status card lists unmapped
    objects.
- **cams:**
  - **Unit tests:** matching analyses to cards (slack, several per card);
    `best` and `notConfirmed`; the badge states (agree, not confirmed, extra,
    none); the Timeline helpers.
  - **e2e (cams' fake proxy):**
    - A card shows "Vision 84%".
    - A pushed `analysis` message updates the card without a reload.
    - A day load after a restart shows the badge.
    - Timeline: a minute opens under its hour; a second shows the large still
      with a box; "Open in History" lands paused at that second.
- **Compatibility:**
  - cams with an older cam-proxy (no `/analyses`, no `summary`) shows no
    badges and logs nothing but a debug line.
  - cam-proxy with an older cams: the new stream type isn't subscribed to.

## Later

- **Full-resolution second look** when Vision finds no person where the camera
  did: the camera's snapshot, at 4512 × 2512 and about 700 KB, is well within
  Google's limits. It only shows the moment it is taken, and whether Google
  benefits from the size is to be measured.
- **More classes:** e.g. bicycles, other animals, after experiments (cams
  issue #108).
- **Other providers;** usage from Cloud Monitoring.
- **Boxes in History,** if wanted: they only fit the analysed still.
