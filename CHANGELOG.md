# Changelog

## Unreleased

- The stills, previews and clips lists answer `to is before from` for a reversed range, instead of saying the range is missing.
- Docs: a [Raspberry Pi guide](docs/raspberry-pi.md) and `scripts/prepare-pi.sh`, from the first Pi install (cam1, 2026-09-29). The script also turns on the memory cgroup.
- `server.trustProxy` (0–5): the number of reverse proxies in front; rate limits then count clients by X-Forwarded-For (set 1 behind the cluster ingress). Needs a restart.
- Composed clips: stills every 2 s or more hold instead of flickering to cards (the badge names the rate); frames are dropped before scaling; a short clip file fills its part; the 200 MB budget is enforced while encoding; storage paused is checked at run start; a finished result stays while it's polled; failures say "the encoder failed" (ffmpeg's text is logged, not shown); `composition.font` needs a restart.
- FTP: both clips of the repeated autumn DST hour are kept; a publicHost name is looked up again after a minute; an unwritable data folder says which folder and what to do.
- Composed clips: a clip with pre-/post-roll from other clips, stills or "No recording" cards (`/api/cameras/{cam}/compositions`), for cams' Downloads. The container adds the DejaVu font; `composition.font` overrides it.
- One-time sign-in links for the admin UI: `POST /control/login-links` (admin token) returns a code valid once for 60 s; `GET /control/login-link?code=` redeems it for a UI session. cams uses it so a signed-in user needn't paste the token.
- `/api/cameras` reports `publicUrl` (the `server.publicUrl` setting, no longer reserved), so cams can link to the proxy's web UI.
- `GET /api/cameras/{cam}/extent`: the oldest clip, still and preview kept, so a client (cams' History strip) knows how far back it can go.
- Tests: cam-sim v2026.09.28.1.
- Deploy: the cluster's `ftp.stream` is `sub` (clips for cams play in every
  browser).

## v2026.09.27.2

- Deferred minors from the Plan 3 and 4 reviews:
  - FTP server hardening (no leaked passive listeners, TLS pipeline lines,
    log masking, `PROT P` without a certificate, `STOR` while paused);
  - the clip indexer checks that a `.jpg` starts like a JPEG;
  - Clips page fixes (only the newest load fills the page, the events
    window, the list isn't mutated).
- Admin UI: top-bar Refresh, live updates (Timeline, Maintenance's log,
  Refresh on other pages), links to the camera and the repo, and
  `camera.webUiUrl` (the camera model links to its own web page).

## v2026.09.27.1

- Phase 1 (core):
  - `config.json` with overrides and a generated JSON Schema; secrets from
    the environment;
  - the camera client (from cams) with a status poller;
  - ONVIF PullPoint events with re-subscription and a polling fallback;
  - the SQLite catalog, and a stream log with a resumable SSE stream;
  - the client API (bearer tokens), the control API (admin token or UI
    session), stats and Prometheus metrics, retention for rows;
  - the admin UI (status, events, settings, maintenance) and a favicon;
  - `scripts/sync-secrets.sh` and a read-only real-camera check.
- Phase 2 (stills, previews, storage):
  - go2rtc as the single camera connection (installer with pinned checksums);
  - a frame grabber writing a still every second and preview tiles;
  - minute packs and sprite sheets that describe their own settings;
  - storage management (age per kind, size budget, hard floor);
  - stills and previews API, live `still` SSE messages, stats and metrics;
  - the admin UI's Timeline page;
  - verified on the real camera (60 stills a minute, one camera connection).
- Phase 3 (clips):
  - an upload-only FTP(S) server inside the proxy (no dependency);
  - the clip indexer (camera-local names to UTC with the camera's DST rule,
    ffprobe check, snapshots, `clip` stream messages with their events);
  - the camera's FTP test file (`TestFtp`'s `.txt`) is not an index failure;
  - camera FTP setup, test and off actions (whole-object writes);
  - the clips API with HTTP Range, and the admin UI's Clips page;
  - clips in storage management (rows deleted with files, stale partial
    uploads removed);
  - `verify-camera.ts --ftp` and `camera-ftp-off.ts` for the real camera.
- Phase 4 (packaging and cluster deployment):
  - a multi-arch image (linux/amd64, linux/arm64) with go2rtc and ffmpeg,
    running as uid 1000;
  - `build-push` (branch `main`) and `release` (branch `production`)
    workflows;
  - digest-pinned deploy in kube-setup with a served-version check;
  - a container smoke test (`scripts/container-smoke.sh`);
  - `compose.yaml` for the Raspberry Pi.
- CI: tests, e2e, type checks, audit, CodeQL, no media files.
