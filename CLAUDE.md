# cam-proxy

Camera gateway for one Reolink camera: an upload-only FTPS server for the camera's clips, a stills pipeline (go2rtc + ffmpeg, minute packs and sprites), ONVIF events as SSE, and a client API for cams, plus a control API and admin UI (Svelte). Runs in the cluster next to `cam2` (https://cam-proxy.skylar.technology, LAN only); a Pi next to the real camera is planned. Spec: `docs/superpowers/specs/2026-09-27-cam-proxy-design.md`. Plans: `docs/superpowers/plans/`. Requirements: `docs/requirements.md`.

## Commands

- `npm test`: vitest against cam-sim in process (a release tarball in package.json). Needs ffmpeg, and go2rtc/MediaMTX in `tools/` (`scripts/install-go2rtc.sh`, `scripts/install-mediamtx.sh`).
- `npm run build`: tsc plus the admin UI (vite). `npm run lint:types` and `npm run check` are the type checks for tests and `web/`.
- `npm run test:e2e`: Playwright against a proxy and a cam-sim.
- `npm run schema`: regenerate `config.schema.json` after changing a setting.
- `npx tsx scripts/verify-camera.ts [seconds]`: read-only run against the real camera.
- Node 26 or later (`engines`).

## Branches and releases

- Work on a feature branch, PR to `main` (required checks `test`, `codeql`). `main` publishes `:main` and `:sha-<sha>` and is never deployed.
- To release: PR `main` -> `production`, then merge. The release job pins the image digest in kube-setup, applies it, waits for the rollout and checks that `/health` serves the new version. The version is `vYYYY.MM.DD.N`, generated at release; never store one in the sources.
- The cluster config is `deploy/cluster/config.json` (camera `cam2`, `ftp.stream: "sub"`). Put user-visible changes under `## Unreleased` in CHANGELOG.md.

## Rules that are easy to break

- Secrets: `.env` is for local runs, `.env.cluster` for the cluster instance (different admin tokens). `scripts/sync-secrets.sh --env-file .env.cluster --only all` pushes them. Never print secrets or tokens; put token header files in a temp dir and delete them after use.
- The FTP server must accept what the real camera sends: PASV only, `CWD` without `MKD`, a parallel session for the JPEG (see the Obsidian note *Cameras/Reolink API Behaviour*). cam-sim copies that session; test against both.
- On a Mac with the firewall on, node must be allowed by its real path, or the camera's `TestFtp` answers `-454` (README, "The macOS firewall and node").
- Real camera: settings writes are whole-object Sets only, and log out afterwards.
- Network exposure and cluster manifests belong to kube-setup (`deploy/cluster/REQUEST.md` records what was asked). Manifests: kube-setup `manifests/cam-proxy/`. Ask the kube-setup session; don't edit that repo from here.
- `go2rtc.url` and `server.publicUrl` are reserved settings with no effect yet; keep them documented as such.
- No clips or media go to GitHub before Klaus has reviewed them. `.superpowers/` is gitignored scratch space.
