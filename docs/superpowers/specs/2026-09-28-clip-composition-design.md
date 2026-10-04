# Composed clips: pre-roll and post-roll for SD downloads (design)

Status: approved design (Klaus, 2026-09-28); spec for review.
Spans cam-proxy (the composition engine and job API) and cams (the Downloads
modal and the pass-through). The cams plan refers to this file.

## Goal

On the cams Downloads page, **SD** opens a modal. It shows the clip and saves
either the clip as it is, or a **composed** clip that starts earlier or ends
later (or is trimmed) by a chosen number of seconds. Seconds the clip doesn't
cover come from other clips, then the proxy's stills (1 fps), then a
"No recording" card. **Full** stays a direct download of the clip from the
camera, with no modal.

## Decisions (Klaus, 2026-09-28)

| Topic | Decision |
|---|---|
| Full quality | Not composed. Full stays today's direct download from the camera. |
| Pre-/post-roll | Seconds, 0 by default, negative (trim) or positive (extend) |
| Filling | A covering clip first (the chosen one, then any other), else that second's still, else a "No recording" card with the time |
| Length | The result is at most 60 s (since 2026-10-04: 300 s, 120 s at 1080p) |
| Badge | Optional (checkbox, on by default): "STILLS 1 FPS" top left on still and card seconds |
| Output | H.264 MP4, 10 fps; size SD 896×512 (default), 640×360, 1280×720 or 1920×1080 |
| Progress | A progress bar while encoding; Cancel and Close stop it |
| Where | Downloads page SD button only; History's download stays direct |

## The modal (cams)

- The SD button on a Downloads card opens the modal for that clip (only when
  the camera has a cam-proxy in use; otherwise SD stays a direct download).
- **Shows:** the clip's thumbnail, time, length and triggers.
- **Inputs:**
  - Pre-roll and Post-roll: whole seconds, −600…+60 each, 0 by default (since 2026-10-04: −3600…3600; the length limit is what counts).
  - Checkbox "Mark still sections", on.
  - Output size: SD 896×512 · 640×360 · 1280×720 · 1920×1080 (upscaled: larger files, no more detail).
  - A live line "Result: 0:52", or an error "At most 1:00" / "At least 1 s of the clip must remain".
- **Buttons:**
  - Pre = Post = 0 and size SD: **Save** downloads the original clip (today's link).
  - Otherwise **Generate**; Save is disabled until the result is ready.
  - Generating: a **progress bar** (0–100 %, "Queued" while another job runs), and **Cancel**.
  - Done: a small **player** with the result, **Save** (file `<cam>-<YYYY-MM-DD_HH-MM-SS>-composed-<size>.mp4`) and **Generate** again after any change.
  - **Close** (✕, Esc, backdrop) cancels a running job and deletes the result.
- Changing an input after a result invalidates it: Save goes back to disabled
  until Generate runs again.

## Composition (cam-proxy)

### Plan

- **Window:** `[clip.start − pre, clip.end + post]`, in whole seconds. Since 2026-10-04 the rolls apply to the request's `span` when given (the recording the viewer chose; the FTP copy can be longer).
- **Checks:** window length 1…60 s (since 2026-10-04: 1…300 s, 1…120 s at 1080p). The window must overlap the chosen clip by at least 1 s, which is what "trimming" means.
- **The planner** walks the window second by second and assigns each second a source:
  1. **The chosen clip,** if it covers the second.
  2. **Another clip of the same camera** that covers it (earliest start first).
  3. **The still** for that second (`stills` store, the second's slot present).
  4. **A card:** "No recording" and the time `HH:MM:SS` (camera's local time zone, the proxy's `TZ`).
- **Segments:** consecutive seconds from the same clip merge into one segment with an in-point and an out-point. Stills and cards are one segment per second.
- The plan is a pure function (catalog rows + still presence → segments), unit-tested without ffmpeg.

### Encoding

- **One ffmpeg process per job.** It uses a concat filter graph over the segments; no intermediate files except the still JPEGs, which are written to the job folder.
  - **Clip segments:** `-ss/-to` on the clip file, scaled to the output size, fps 10, audio kept.
  - **Still segments:** the JPEG looped for 1 s (`-loop 1 -t 1`), scaled, fps 10, silent audio (`anullsrc`).
  - **Cards:** `color=c=#111:s=<size>:d=1` plus `drawtext` of "No recording" and the time, silent audio.
  - **Badge** (optional): `drawtext` "STILLS 1 FPS" top left, white on a semi-transparent box, on still and card segments only.
- **Output:** `libx264 -preset veryfast -crf 23 -pix_fmt yuv420p`, AAC 64 kb/s, `-movflags +faststart`, 10 fps, the chosen size.
- **Progress:** ffmpeg `-progress pipe:1` `out_time_us` divided by the window length.
- **Fonts:** the container adds `font-dejavu`. The font path is config (`composition.font`, default the DejaVu Sans path).

### Jobs

- **At most one** encoding at a time per proxy. Others wait in a queue of up to 3; beyond that the answer is 429 `busy`.
- **States:** `queued → running → done | failed | cancelled`, with `progress` (0–1), `durationS`, `error`.
- **Clean-up:**
  - A job folder is under `<dataDir>/compositions/<job>/`.
  - It is deleted on `DELETE`, 15 minutes after `done`, or when nobody has polled a queued or running job for 30 s (a closed tab).
  - At start, leftover folders are removed.
- **Budget:** a job may use at most 200 MB of disk (a 60 s 1080p result is far below that). Storage-paused refuses new jobs (503 `storage_paused`).

### API (client token, like the clip routes)

- `POST /api/cameras/{cam}/compositions` `{ clipId, preS, postS, size: 'sd'|'360p'|'720p'|'1080p', badge: boolean }`
  - 201 `{ id, state, durationS }`
  - 400 `invalid` (the limits above)
  - 404 `not_found` (unknown clip)
  - 429 `busy`
  - 503 `storage_paused`
- `GET /api/cameras/{cam}/compositions/{id}` → `{ id, state, progress, durationS, error? }`. Every poll also keeps the job alive.
- `GET /api/cameras/{cam}/compositions/{id}.mp4` → the result (`video/mp4`, `Content-Disposition` left to cams), 409 until `done`.
- `DELETE /api/cameras/{cam}/compositions/{id}` → 204. It cancels (SIGTERM, then SIGKILL after 2 s) and deletes.
- Job ids are random (128-bit, base64url); a job is visible only for its camera.

## cams

- **Pass-through:** `POST/GET/DELETE /api/cameras/:id/compositions…` go to the camera's proxy with its client token. For signed-in users only. A camera without a proxy in use gets 404 `no_proxy`.
  - The proxy's clip id comes from `findProxyClip` for the event, as for proxy downloads.
  - The `.mp4` is streamed with `Content-Disposition: attachment; filename=…`, or `inline` for the player (`?inline=1`).
- **The modal component** is `ComposeDialog.svelte`, and `DownloadList.svelte`'s SD button opens it.
  - It polls every second while queued or running, and stops polling when closed.
  - It sends `DELETE` on Cancel, Close and page unload (`sendBeacon`-free: a `fetch` with `keepalive`).

## Testing

- **cam-proxy unit:**
  - **The planner:**
    - the clip alone;
    - pre-roll from stills;
    - post-roll reaching into the next clip (the 20 s stills + 10 s clip example);
    - overlapping clips;
    - cards where there is nothing;
    - negative values trimming;
    - the 1…60 s limits;
    - clips of another camera ignored.
  - **Jobs:** queue and 429, progress, cancel mid-run, the 30 s unpolled timeout, the 15 min clean-up, and leftover clean-up at start.
- **cam-proxy integration (real ffmpeg):**
  - A tiny generated clip and stills produce a composition.
  - `ffprobe` shows the expected duration (±0.2 s), size, fps 10, H.264 and AAC.
  - A frame from a still second differs from one with the badge off (the badge is drawn).
- **cams:**
  - The pass-through (auth, `no_proxy`, streaming, errors).
  - **e2e with the fake proxy:**
    - SD opens the modal;
    - 0/0 + SD saves the original;
    - Generate shows progress then the player;
    - Save downloads `…-composed-sd.mp4`;
    - Cancel and Close send `DELETE`;
    - Full stays a direct download;
    - a camera without a proxy keeps the direct SD link.

## Out of scope

Full-quality composition, the History page's download, results longer than
60 s, preview tiles as a filler, hardware encoders.

## Risks

- **Pi 4 encoding time:** 60 s at 1080p with veryfast may take about a minute. It's acceptable with the progress bar, and SD is the default. Measured in the integration test on the Mac; on the Pi later.
- **Clip timestamps:** clip start and end times come from the FTP file names (camera clock). Seconds at clip joins may overlap or leave a gap of up to 1 s; the planner works in whole seconds, so this shows at most as a 1 s still.
