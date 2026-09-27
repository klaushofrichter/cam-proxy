# Camera gateway: design note (draft)

**Status:** idea, not started. Written 2026-09-26 during the cams project. It becomes its own repository once cams is reasonably complete.

**Decisions so far (2026-09-26):**
- **An add-on to cams.** cams keeps working without the gateway, and gains features once it exists: a better history timeline, clips via FTP intake, and live SSE events.
- **No FTP solution inside cams.** Clip intake waits for the gateway.
- **cams keeps its direct camera implementation,** including recording downloads, even though the camera currently refuses downloads.
- **Frigate is skipped as a platform.** We reuse components and ideas (§14).

**Author:** Klaus Hofrichter, with Claude.

## 1. Why

The Reolink RLC-1224A (firmware v3.2.0.6011) turned out to be fragile to talk to directly:

- **Search:** only one runs at a time. An overlapping one fails (`rspCode -54`) or returns nothing.
- **Download:** one at a time. About 150 KB/s. It can break outright: since 2026-09-26 every download is refused, including in the camera's own web UI, through power cycles and an SD format.
- **Settings:** a partial Set command resets every key it leaves out, in the saved configuration, from the next restart on.
- **Sessions:** logins are limited, and every client that logs in uses one up.
- **No SSE, no WebRTC.** Webhook support is unconfirmed.

A small **gateway** next to the camera would own the camera connection. It would store what matters (stills, events, clips) and offer a clean API, so that apps such as cams don't depend on the camera's quirks.

## 2. Goals

1. **Stills.** A low-resolution still every second, kept for about 7 days, as the basis of a history browser that can scrub any moment, not only events.
2. **Previews.** Fast preview images for that browser, cheap to load while scrubbing.
3. **Events.** Camera events come in by webhook where supported, or via ONVIF or the Reolink push protocol, and are stored with their AI information.
4. **Searchable metadata that can change later.**
   - An AI event may arrive after its frames are stored.
   - External services may add results later, such as a scene description.
5. **External analysis.** Selected frames (motion, person, …) go to an **external** service. No analysis runs on the Pi. The results come back as metadata.
6. **SSE to clients for events: a core requirement.** Every client (cams, other web apps, scripts) can subscribe to a live stream of camera events, new stills, annotations and clips, and resume after a disconnect without losing anything. The camera itself can't do this. See §11.
7. **WebRTC** pass-through for live video (go2rtc or MediaMTX).
8. **FTP intake.** The camera pushes each recorded clip to the gateway. This replaces the camera's Download command.
9. **Three targets.** It runs on a **Raspberry Pi 4B** (4 GB, SSD) and in the **k3s cluster**, both production. It also runs on **this Mac**, for development only. See §15.
10. **Management web UI.** A simple built-in page for status, configuration and maintenance (§15).
11. **Metrics.** A Prometheus endpoint that can be scraped: disk usage, image counts, event and SSE figures, camera health (§15).
12. **Security.** A bearer token, and nothing else (§15).

**Scope:** one camera on the Pi, and a design that doesn't prevent more.

## 3. Hardware

- **Raspberry Pi 4B, 4 GB,** 64-bit OS (Raspberry Pi OS Lite or Debian arm64).
- **Samsung 850 EVO SSD** on a **StarTech USB3S2SAT3CB** USB-3-to-SATA adapter, on a blue USB 3 port.
  - This combination usually works well. If the disk drops under load, disable UAS for that adapter with `usb-storage.quirks=<vid>:<pid>:u` in `cmdline.txt`. Get `vid:pid` from `lsusb`.
  - Boot from the SSD too (Pi 4 USB boot) and leave the SD card out.
  - The 850 EVO draws little power, so the Pi's USB port is enough. Use the official 3 A power supply.
- **Network:** wired Ethernet, on the same LAN as the camera and the cluster.

**Load estimate (one camera):**
- **Sub stream:** decoding the H.264 896×512 stream at 10 fps is comfortable, in software or with the Pi's V4L2 hardware decoder.
- **Main stream:** 4K H.265. The Pi only passes it through and never decodes it. Transcoding it on a Pi 4 is not feasible.

## 4. Architecture

```
                 ┌──────────────── Raspberry Pi 4 (or cluster / Mac) ─────────────────┐
 camera ──RTSP──▶│ go2rtc  ── single connection per stream, restream ─┬─▶ WebRTC/MSE ─┼─▶ browsers
   │             │                                                   └─▶ frame grabber│
   │  webhook /  │ gateway (API, SSE, catalog, outbox, FTP intake)                     │
   ├─ ONVIF / ──▶│   ├─ frame grabber (ffmpeg): 1 fps → stills + preview sprites       │
   │  Baichuan   │   ├─ event intake → events + annotations                            │
   ├─ FTP push ─▶│   ├─ FTP(S) server → clips on SSD                                   │
   │             │   ├─ outbox worker → external analysis ──HTTPS──▶ (describer…)      │
   └─ HTTP API ◀─│   └─ camera control (settings, search) — the only camera client     │
                 │ SSD: /data/{stills,previews,clips}/YYYY/MM/DD, catalog.sqlite       │
                 └──────────────────────────────────────────────────────────────────────┘
```

- **go2rtc** holds exactly one RTSP connection per camera stream and restreams it. The frame grabber and every WebRTC viewer read from go2rtc, so the camera always sees one client.
- **The gateway process** handles the API, SSE, catalog, outbox, FTP intake and camera control. It is the only client of the camera's HTTP API. The Reolink client from cams (`server/reolink/`) moves here:
  - token handling;
  - serialized searches;
  - one transfer at a time;
  - whole-object settings writes;
  - the measured quirks from `cams/docs/reolink-api.md`.

## 5. Stills and previews

**Source:** the camera's **sub stream** via go2rtc (RTSP). The RLC-1224A has no third, lower-resolution stream, so the sub stream is the lowest available. Snapshots (`cmd=Snap`) are 4512×2512 JPEGs of about 700 KB and take about 1 s each, far too heavy for one per second.

**One long-running ffmpeg process** produces two outputs from the same decode:

| Output | Size | Rate | Use | Storage/day |
|---|---|---|---|---|
| **still** | 896×512 JPEG, about 30–50 KB | 1/s | the frame shown when you stop on a moment; the image sent to external analysis | about 3–5 GB |
| **preview tile** | 160×90 JPEG, about 3–5 KB | 1/s | the scrubbing strip in the history browser | about 0.3–0.5 GB |

**Grouping instead of 86,400 files a day:**
- **Stills: one pack per minute.** A pack is the 60 JPEGs concatenated, plus a small offset table. That can be a sidecar file or a header. Reading one still is one seek plus one read. The result is 1,440 files a day, in day folders.
- **Previews: one sprite sheet per minute.** It is a single JPEG holding the 60 tiles in a grid, for example 10×6. This is the "storyboard" technique video sites use for scrub previews. The browser loads one image per minute of timeline and crops the right tile, with no request per second: scrubbing an hour takes 60 cached requests.
- **Expiry:** delete a day folder. There is no per-row delete or database fragmentation.
- **Rejected alternatives:**
  - *Images as database rows:* the catalog gets large, backups heavy, and deletes fragment it.
  - *A 1-fps video instead of JPEGs:* 5–10× smaller, but every frame read needs a decode, which is too slow on a Pi for interactive scrubbing.

## 6. Catalog (metadata)

**SQLite in WAL mode:** a single file with no server. It has JSON functions and FTS5 full-text search built in, backs up by copying the file, and runs identically on the Pi, in the cluster and on the Mac. Consider Postgres only if many services write heavily at the same time, or for pgvector later.

**Images never go into the database.** The catalog points into the packs and sprites.

```sql
frames(ts INTEGER PRIMARY KEY,          -- unix seconds (camera = cam id column if >1 camera)
       pack TEXT, offset INTEGER, length INTEGER,
       sprite TEXT, tile INTEGER)

events(id INTEGER PRIMARY KEY, cam TEXT, source TEXT,      -- camera-webhook | onvif | ftp | …
       type TEXT, start_ts INTEGER, end_ts INTEGER, raw JSON)

annotations(id INTEGER PRIMARY KEY, cam TEXT,
            start_ts INTEGER, end_ts INTEGER,               -- a moment or a range
            source TEXT,                                    -- camera | describer | …
            kind TEXT,                                      -- person | motion | scene_description | …
            value JSON, confidence REAL, model TEXT,
            created_at INTEGER)
-- indexes: annotations(kind, start_ts), annotations(source, start_ts), events(start_ts)
-- FTS5 table over annotation text (descriptions) for free-text search

clips(id INTEGER PRIMARY KEY, cam TEXT, start_ts INTEGER, end_ts INTEGER,
      path TEXT, stream TEXT, size INTEGER)                 -- from FTP intake

outbox(id INTEGER PRIMARY KEY, frame_ts INTEGER, rule TEXT, target TEXT,
       status TEXT, attempts INTEGER, next_try INTEGER, UNIQUE(frame_ts, rule, target))
```

**Annotations are append-only.** New or better information is a new row; nothing is overwritten.

- An AI event that arrives after its stills are stored becomes an annotation on that time range.
- An external description adds a `source='describer'` row. A later, better service adds its own row, and both remain available.
- "What did source X say?" is a simple query. A result can be superseded by preferring the newest row for a given `(source, kind)`.

**Search examples:**
- "stills 14:00–14:05";
- "person with confidence > 0.8 today";
- "everything the describer said containing 'van'", via FTS;
- "events with a clip".

## 7. Events

**Intake**, in order of preference; check what this firmware supports:
1. **Webhook** from the camera, if its firmware offers HTTP push. This is not confirmed for the RLC-1224A. Check it under Settings → Notification or in `GetAbility`.
2. **ONVIF events** (PullPoint subscription). ONVIF is enabled on the camera.
3. **Reolink "Baichuan" push** on TCP 9000. Home Assistant's `reolink_aio` implements it.
4. **Polling** `GetMdState` / `GetAiState` as a fallback.

Every event becomes an `events` row, plus annotations for its AI types. The event time range links it to its stills.

## 8. External analysis (not on the Pi)

- **Selection rules** decide which stills go out. Examples:
  - stills inside motion or person events;
  - the first, peak and last still of each event;
  - at most one still every N seconds per event.

  Rules run on annotations, so they also react to late events.
- **Outbox:** each job is `(frame, rule, target)`, unique, so a retry never duplicates. A worker sends jobs over HTTPS with limited concurrency and exponential backoff.
- **Results** come back either in the response or by webhook to the gateway. They are stored as annotations with `source`, `kind`, `model`, `value` and `confidence`, and pushed over SSE.
- **Controls:**
  - a daily budget or rate limit;
  - an on/off switch per target;
  - the privacy rule that images leave the house, so send them only to trusted services.
- **Re-analysis:** a new model can re-describe old stills without losing the earlier results.

## 9. Clips (FTP intake)

Measured on 2026-09-26: the camera's FTP feature is a **client**. It uploads to a server we run. It has no FTP server of its own.

- With `SetFtpV20` enabled (FTPS only by default; plain FTP when `onlyFtps: 0`), it uploaded each motion clip as `…/YYYY/MM/DD/Den_00_YYYYMMDDHHMMSS.mp4`.
- The clip was main stream: H.265 4512×2512 at 20 fps, with AAC audio. 24 s took 7 MB, and the `moov` atom is at the start, so the file is seekable.
- It also uploaded a full-resolution JPEG named after the start time.
- The file names carry **no trigger information**, unlike the SD-card names. Match clips to events and annotations by start time.
- The capability list says the sub stream is supported (`ftpSubStream`); try `streamType: 1`.

**Plan:**
- Run an FTPS server in the gateway (pyftpdlib or vsftpd), writing to `/data/clips/YYYY/MM/DD/`.
- Index each upload into `clips`, and serve it with HTTP Range requests.
- Delete clips after 7 days.
- Main-stream clips: about 10 GB for 7 days at today's event rate. Sub-stream clips: about 1 GB.

**Camera gotchas:**
- Write the **whole** `Ftp` object: partial writes reset other keys.
- The camera refuses `server: ""` (`rspCode -4`), so "disabled" means `enable: 0` with a server set.

## 10. Live video

- go2rtc pulls RTSP (or the camera's RTMP) once and serves WebRTC, MSE and RTSP to clients.
- **WebRTC works for the H.264 sub stream in all browsers.**
- The main stream is H.265 4K, which most browsers can't play over WebRTC, and the Pi can't transcode it. Keep it on HTTP-FLV/MSE (the path cams uses today) for HEVC-capable browsers such as Safari and Chrome on macOS.

## 11. SSE event stream (core requirement)

The gateway turns the camera's events into a live Server-Sent Events stream for any number of clients. The camera's events arrive by webhook, ONVIF or Baichuan push, or polling.

**An event log, not just a fan-out.** Everything a client may care about is first written to an append-only `stream_log` table, then pushed to connected clients:

```sql
stream_log(id INTEGER PRIMARY KEY AUTOINCREMENT,   -- the SSE id: monotonic, never reused
           ts INTEGER, cam TEXT, type TEXT,          -- event | annotation | clip | still | camera-status
           data JSON)
-- retention: e.g. 7 days (same as stills); index (cam, type, id)
```

- **Resume after a disconnect.** Every message carries `id: <stream_log.id>`. On reconnect, browsers send `Last-Event-ID` automatically, and a `?since=<id>` query does the same for other clients. The gateway replays everything newer from `stream_log`, then continues live. A phone waking up, a Wi-Fi drop or a gateway restart loses nothing within the retention window.
- **Too far behind.** If the requested id is older than the retention window, the gateway sends `event: reset` with the oldest available id, and the client reloads its view through the REST API.
- **Types:**

  | `event:` | When | `data` |
  |---|---|---|
  | `camera-event` | the camera reports motion or AI (start and end) | `{cam, eventId, kind: person\|vehicle\|pet\|motion, phase: start\|end, ts, confidence?}` |
  | `annotation` | any annotation added, including late AI and external descriptions | `{cam, annotationId, source, kind, start_ts, end_ts, value, confidence}` |
  | `clip` | an FTP clip received and indexed | `{cam, clipId, start_ts, end_ts, stream, size, url}` |
  | `still` | a new still; **opt-in only**, because it fires every second | `{cam, ts, url, previewSprite, tile}` |
  | `camera-status` | the camera goes online or offline, or the gateway loses the stream | `{cam, online, reason}` |

- **Filters** set in the query:
  - `GET /api/stream?cam=cam1&types=camera-event,annotation&kinds=person,vehicle`
  - Stills are off unless `types=still` is set explicitly.
- **Keep-alive.** A comment line (`: ping`) every 15 s keeps proxies and NAT from closing idle connections. Send `retry: 3000`.
- **Fan-out and backpressure.**
  - Keep one in-memory bus for live delivery.
  - Give each client a bounded queue. A client that can't keep up is disconnected, then reconnects and replays from its `Last-Event-ID`, so slow clients never block fast ones and never lose events.
  - Cap the number of connected clients (the Pi is small).
- **Auth: a bearer token only** (§15). A browser's built-in `EventSource` can't send an `Authorization` header, so there are two ways to connect:
  - **Server-side relay (the main case).** cams subscribes server-side with the bearer token and relays the stream to its own browsers behind its Google login. The token never reaches a browser.
  - **Direct from a browser.** The management UI and other direct web clients use a fetch-based SSE client (e.g. `@microsoft/fetch-event-source`), which sends `Authorization: Bearer` and resumes with `Last-Event-ID` like `EventSource`.

  No tokens in URLs.
- **Through proxies:**
  - Send `Content-Type: text/event-stream`, `Cache-Control: no-store`, `X-Accel-Buffering: no`, and flush after every message.
  - When cams relays the stream through the cluster (Traefik/Knative), the request timeout (cams already has 600 s for live) closes it now and then. That's fine: the client reconnects with `Last-Event-ID` and loses nothing.
- **cams usage:** Recordings and Live subscribe to `camera-event`, `annotation` and `clip`. They replace today's 60-second polling of the recordings list: new events show up at once, and descriptions appear on existing events as they arrive.
- **With Frigate (§14):** Frigate publishes events over MQTT, not SSE. The gateway would subscribe to Frigate's MQTT, write those into `stream_log` like any other source, and serve them over SSE, so clients never see the difference.

## 12. API sketch

```
GET  /api/cameras
GET  /api/cameras/:id/stills?from&to            → [{ts, url}]
GET  /api/cameras/:id/stills/:ts.jpg            → one still (from its pack)
GET  /api/cameras/:id/previews?date             → [{minute, spriteUrl, cols, rows, tileW, tileH}]
GET  /api/cameras/:id/events?from&to&kind
GET  /api/cameras/:id/annotations?from&to&kind&source&q
POST /api/annotations                            (external services, authenticated)
GET  /api/cameras/:id/clips?from&to  ·  /clips/:id(.mp4, Range)
GET  /api/stream?cam&types&kinds&since   (SSE, see §11; resumes from Last-Event-ID)
POST /hooks/camera/:id                           (camera webhook intake)
```

**Auth:** `Authorization: Bearer <token>` on every endpoint except `/health` and `/metrics` (§15). The gateway sits on the LAN only; cams in the cluster reaches it over the LAN.

## 13. Relationship to cams (pick and choose)

This is Klaus's direction (2026-09-26): **a mix at first.**

- Where the gateway provides a feature, cams uses the gateway. First candidates:
  - stills and previews for the history browser;
  - event history with annotations;
  - clips from FTP intake, replacing the broken camera download.
- cams keeps talking to the camera directly for everything the gateway doesn't cover yet: live FLV, settings, device info.
- Once the gateway covers everything cams needs, cams can switch to **gateway-only**, and the gateway becomes the camera's only client.
- cams needs a "gateway offline" state per feature, and falls back to the camera where that still makes sense.

## 14. Build vs. Frigate

**Frigate** (github.com/blakeblackshear/frigate, **MIT license**, with an optional paid Frigate+ model service) is an open-source NVR in a single Docker container.
- **What it has:**
  - go2rtc restreaming;
  - continuous and event recording in segments;
  - object detection (CPU, Coral, OpenVINO, Hailo, …);
  - events with snapshots and clips;
  - an SQLite database, HTTP API and MQTT;
  - a web UI with a review timeline and low-res preview videos;
  - in newer versions, GenAI descriptions that send images to an **external** LLM (OpenAI, Gemini or Ollama), and semantic search.
- **On a Pi 4:** it runs (64-bit only). One sub stream decodes fine. Object detection on the CPU is slow, so a Coral USB is the usual answer, or turn detection off.

**Fit:**

| Need | Frigate |
|---|---|
| One camera connection, WebRTC | ✅ via go2rtc |
| Clips without the camera's Download | ✅ it records itself |
| History browser with previews | ✅ review timeline and preview videos (video-based, not stills) |
| External scene descriptions | ✅ GenAI feature, partly; tied to its own tracked objects |
| Stills every second, stored and searchable | ❌ not its model |
| Camera-native AI events (webhook/ONVIF/Baichuan) as the source | ⚠️ limited; it uses its own detector |
| General, append-only, searchable metadata from any service | ❌ |
| **SSE event stream for clients (core requirement)** | ❌ MQTT only. The gateway bridges MQTT to SSE with resume (§11). |
| Reolink settings control, whole-object writes | ❌ |
| FTP intake | ❌ (not needed if Frigate records) |

**Could we run Frigate on the Pi and extend it?**
- **Forking Frigate:** possible, but it's a large, fast-moving Python and React codebase. Keeping a fork current would be a permanent cost, and much of what we'd add (the stills model, the annotation store, Reolink control) doesn't match its design.
- **Frigate next to a slim gateway:** realistic. Frigate does recording, restreaming, previews and possibly detection and GenAI descriptions. The gateway reads Frigate's API and MQTT and adds:
  - the 1-per-second stills and sprites (read from Frigate's go2rtc);
  - the annotation catalog and external-analysis outbox;
  - SSE;
  - Reolink control.

  Resource use on the Pi 4 is the open question.
- **From scratch with go2rtc:** the original plan. It's smaller, fits the stills and annotations model exactly, and uses less on the Pi. It's more work up front for recording and preview UI that Frigate already has.

**Decision (Klaus, 2026-09-26): skip Frigate as a platform.** Build the gateway ourselves around proven components, and use Frigate's code only as a reference, to avoid known traps.

**Reusable components:**

| Component | Use | Why it saves effort |
|---|---|---|
| **go2rtc** (MIT, single binary, arm64) | the one camera connection; restreaming; WebRTC/MSE to browsers; RTSP for the frame grabber | Solves reconnects, codec negotiation and WebRTC; Frigate relies on it too |
| **ffmpeg** | frame grabber (1 fps stills plus preview tiles in one decode) | Standard; can use the Pi's V4L2 hardware decoder |
| **reolink_aio** (Home Assistant, MIT, Python) | *reference* for the Baichuan push protocol (TCP 9000) and ONVIF event parsing, the ability flags and quirks | Years of real-camera fixes; port the logic we need, or run a tiny sidecar |
| **cams `server/reolink/`** (ours) | the HTTP API client: tokens, one search at a time, one transfer at a time, whole-object writes | Carries everything measured on this camera |
| **Frigate source** (MIT) | *reference only*: segment recording, preview generation, retention jobs, go2rtc config, how it handles camera disconnects | Learn from its solutions without taking on the platform |
| **SQLite** (WAL, JSON1, FTS5) | catalog and `stream_log` | No server; the same everywhere |
| An FTP(S) server library (e.g. pyftpdlib) or vsftpd | clip intake | Proven; FTPS support |

**Traps to avoid**, from cams and from what Frigate users report:
- **Camera connections:** never open more than one stream per camera stream; go2rtc restreams. Never poll Snap at 1 Hz.
- **Camera settings writes:** only whole objects. Partial Set commands reset other keys at the next restart.
- **Camera API calls:** search one at a time, download one at a time. The download function can break permanently, so don't depend on it; FTP intake plus the camera's own recording is safer.
- **Codecs:** H.265 over WebRTC fails in most browsers, and a Pi 4 can't transcode 4K, so use the H.264 sub stream for WebRTC.
- **USB SSD:** some USB-to-SATA adapters drop out under UAS; the fix is the `usb-storage.quirks` kernel setting. Always use a proper power supply.
- **Storage:** no per-frame files or rows (use packs and sprites); expire by deleting day folders; keep the catalog small (no images in it).
- **SSE:** buffering by proxies (set `X-Accel-Buffering: no`, flush every message), idle timeouts (15 s pings), and lost events on reconnect (the `stream_log` plus `Last-Event-ID`).

## 15. Targets, packaging, management, metrics, security

### Targets

| Target | Role | Storage | Notes |
|---|---|---|---|
| **Raspberry Pi 4B** (4 GB, 64-bit OS) | **production**: the gateway next to the camera | Samsung 850 EVO over USB 3 (StarTech USB3S2SAT3CB) | Boot from the SSD. Watch for the UAS quirk (§3). |
| **k3s cluster** | **production**: the alternative host, or a second instance | a PVC (local-path) | Deploy through kube-setup, like cams. The camera must reach the FTP intake on the LAN (a LoadBalancer or NodePort). |
| **This Mac** (Apple Silicon) | **development only** | a local folder | With the cams mock camera, extended for RTSP and FTP. Also the place to try things against the real camera on the LAN. |

### Packaging: container vs. native

- **The container is the primary form.** The cluster needs it anyway.
  - Build one multi-arch image (linux/arm64 and linux/amd64), configured only through environment variables, with data in one mounted `/data` volume.
  - go2rtc runs as a second container (or a sidecar in the cluster), from its official arm64 and amd64 image.
  - ffmpeg is in the gateway image (Alpine's package, as in cams).
- **On the Pi, the same image runs under Docker (compose)** with `restart: unless-stopped`, host networking for FTP passive ports and go2rtc's WebRTC, and `/data` on the SSD. Docker on a Pi 4 costs little. Hardware decoding (`/dev/video*` V4L2) can be passed in if the frame grabber needs it; software decoding of the 896×512 sub stream is fine.
- **Native option.** The same code can also run natively as a systemd service on the Pi and as a plain process on the Mac. This is possible if the gateway is written in a language with simple native builds (Go: one static binary; or Node with a bundled runtime). Keep native as the fallback if Docker on the Pi turns out to be a problem (for example SD-card wear or memory). Don't build native first.
- **The Mac runs development builds only:** `docker compose up`, or natively with the dev server and hot reload. Nothing on the Mac is treated as production: no uptime or backup expectations.
- **One configuration model** for all three targets: environment variables, a `.env` file for compose and the Mac, and a Secret or ConfigMap in the cluster.

### Management web UI

This is a small built-in web page at `/manage`, served by the gateway itself. It uses the same bearer token, entered once and kept in the browser's session storage. It is not a second app.

- **Status:**
  - the camera (online, last event, stream health, the breaker state for any camera downloads);
  - go2rtc streams;
  - the frame grabber (running, frames per minute, last frame);
  - FTP intake (last upload);
  - the external-analysis outbox (queued, failed, today's budget).
- **Storage:**
  - disk used and free, per data type (stills, previews, clips, catalog);
  - retention settings, and what the next clean-up will delete.
- **Live check:** the latest still, and the SSE stream as a scrolling event log, to see that things flow.
- **Configuration**, where it is safe at runtime:
  - camera connection;
  - retention days;
  - frame rate;
  - selection rules and the external-analysis target and budget;
  - FTP on/off.

  Anything security-relevant (the token itself, credentials) stays in environment variables and Secrets, not in the UI.
- **Maintenance:**
  - run retention now;
  - re-index clips;
  - test the camera connection;
  - send the camera's FTP test;
  - download a catalog backup.

Keep it deliberately plain: a few server-rendered pages or one small Svelte page, with no build-heavy SPA.

### Metrics (Prometheus)

`GET /metrics` in Prometheus text format, scraped by the cluster's Prometheus. The Pi is on the LAN, so add a scrape job for it. Unauthenticated, but it exposes counts only, never image data or event content.

| Metric | Type | Labels |
|---|---|---|
| `gateway_disk_bytes` | gauge | `kind` = stills \| previews \| clips \| catalog |
| `gateway_disk_free_bytes`, `gateway_disk_size_bytes` | gauge | `mount` |
| `gateway_stills_total` | counter | `cam` |
| `gateway_stills_stored` | gauge | `cam` (count within retention) |
| `gateway_frame_grabber_up` | gauge | `cam` |
| `gateway_last_still_timestamp_seconds` | gauge | `cam` (alert if stale) |
| `gateway_events_total` | counter | `cam`, `source`, `kind` |
| `gateway_annotations_total` | counter | `source`, `kind` |
| `gateway_clips_total`, `gateway_clips_stored`, `gateway_last_clip_timestamp_seconds` | counter / gauge | `cam`, `stream` |
| `gateway_sse_clients` | gauge |   |
| `gateway_sse_messages_total` | counter | `type` |
| `gateway_sse_replayed_total` | counter | (messages sent on resume) |
| `gateway_outbox_jobs` | gauge | `status` = queued \| failed \| done_today |
| `gateway_outbox_requests_total` | counter | `target`, `result` |
| `gateway_camera_up` | gauge | `cam` |
| `gateway_camera_request_seconds` | histogram | `cam`, `cmd` |
| `gateway_camera_errors_total` | counter | `cam`, `code` |
| `gateway_retention_deleted_total` | counter | `kind` |
| `gateway_build_info` | gauge | `version`, `target` = pi \| cluster \| dev |

Alongside the existing cams alerts in Grafana:
- disk above 85 %;
- no still for 2 minutes;
- camera down for 5 minutes;
- outbox failures rising;
- no FTP clip for a day when events happened.

### Security: a bearer token only

- **Every endpoint** except `/health` and `/metrics` needs `Authorization: Bearer <token>`. That includes the API, SSE, the management UI's API calls, and clip and still URLs. No sessions, cookies, OAuth or user accounts.
- **Tokens:**
  - random (at least 32 bytes), from the environment (`GATEWAY_TOKENS`, a comma list, so a token can be rotated without downtime);
  - compared in constant time;
  - never logged, never accepted in URLs.
- **Clients:**
  - **cams** holds a token in its cluster Secret and calls the gateway server-side (API and SSE relay).
  - **Browsers** never get the token, except in the management UI, where the operator types it in.
  - **External analysis services** that post results back get their own token.
- **Camera-facing endpoints** can't carry a bearer token: the FTP intake and the camera webhook. They are protected differently:
  - FTP(S) uses its own username and password (FTPS preferred) and only accepts uploads.
  - The webhook URL contains a long random path segment, and only accepts event payloads.
  - Both are reachable on the LAN only.
- **Transport:**
  - On the Pi, the gateway listens on the LAN. Use TLS when reached across hosts: go through the cluster's ingress, or give the Pi its own certificate. At minimum, keep it off the router's port forwards.
  - The Mac development build may run plain HTTP on localhost.
- **Health:**
  - `/health` checks only the process;
  - the camera state is in the status API;
  - retention runs as a job.
- **Backups:** `catalog.sqlite` via `.backup` (downloadable from the management UI). Stills and clips are expendable after 7 days.

## 16. Open questions

1. Does this camera's firmware send webhooks (HTTP push)? If not: ONVIF or Baichuan?
2. Sub-stream FTP uploads (`streamType: 1`): check that they work and what the clips look like.
3. Retention per data type: stills, previews, clips and catalog may differ.
4. The external analysis target and budget: which service, cost per image, privacy.
5. Frigate spike results: resource use on the Pi 4, and whether its preview timeline is enough.
6. More than one camera later: path layout and naming already carry a camera id.
7. SSE scale: expected number of simultaneous clients, and whether a message broker is needed beyond the in-process bus. For one Pi and a few clients: no.
8. Language and runtime: Node/TypeScript (to reuse the cams Reolink client directly) or Go (small static binary, which suits native Pi builds). The container-first plan works with either.
9. TLS for the Pi: a cluster-issued certificate pushed to the Pi (like the camera's) or a private CA.
