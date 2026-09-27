# cam-proxy Plan 4: Packaging and cluster deployment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** one multi-arch image of cam-proxy, released from `production` and
deployed to the k3s cluster at `cam-proxy.skylar.technology`, next to cam2,
with cam2 as its camera (stills, events and FTP clips end to end), plus a
compose file for the Pi.

**Architecture:**
- **This repo owns:** the image (`Dockerfile`), the workflows (`build-push`,
  `release` with the deploy job), the secrets script, the cluster
  `config.json` and a written request for kube-setup.
- **kube-setup owns every manifest:** namespace, Deployment, Service, PVC,
  ConfigMap, certificate, route, runner, RBAC, NetworkPolicy. Its session
  makes those changes; this session sends the request and never edits that
  repo.
- **In the cluster** go2rtc and ffmpeg run as child processes inside the one
  container. cam2 uploads its clips to cam-proxy through the ClusterIP
  Service (FTP 2121 and passive 30000-30009). No new LAN exposure is needed
  except the admin UI route, LAN-only like cam2's, which needs Klaus's
  approval. FTP for the real camera through a LAN LoadBalancer comes later
  (issue #4).

**Tech Stack:** as Plans 1–3; Docker buildx (QEMU for arm64), GitHub
Actions, ghcr.io, the self-hosted k3s runner pattern.

**Spec:** §2, §12, §13, §14, §16, §17, §18 (phase 5);
kube-setup `docs/cluster-deployment-requirements.md` (§1–§7, Traps).

## Global Constraints

- The image: `node:26-alpine`, two stages, numeric `USER 1000:1000`, all data
  under `/data`, one image for `linux/amd64` and `linux/arm64`.
- Binaries are pinned: go2rtc v1.9.14 with the SHA-256s from
  `scripts/install-go2rtc.sh`; ffmpeg from Alpine.
- `APP_VERSION`/`BUILD_DATE` come late in the Dockerfile. `CAMPROXY_VERSION`
  is the release version, and `CAMPROXY_TARGET` is `cluster` or `pi`.
- Releases run only from `production`. The version is `vYYYY.MM.DD.N`
  (America/Chicago).
- Only `release.yml` writes `:v*` and `:latest`; `build-push` writes `:main`
  and `:sha-<sha>`.
- The deploy pins the image **by digest** in kube-setup, commits and pushes
  before applying, and polls generation (no `rollout status`).
- The smoke test checks the **served version**.
- Secrets: agents never print values. `sync-secrets.sh` prints key names
  only; Klaus runs it (or allows it).
- Network exposure needs Klaus's explicit approval, obtained in chat and
  recorded in the kube-setup request.
- No media committed.

## Review Focus

1. **The image runs as uid 1000 with a volume owned by root** (a fresh PVC):
   start-up must fail loudly or work, never half-work.
   → `fsGroup` in the request and the smoke test with `--user 1000`.
2. **A deploy reverts a kube-setup change** (apply before push).
   → release.yml order: commit, push, then apply; and the request says the
   same.
3. **The served version doesn't match** (an old pod still answering).
   → The smoke test polls `/health` until `version` equals the release.
4. **A secret in a log** (build args, workflow logs, the kube Secret
   creation). → The sync script test checks the output for values.
5. **go2rtc/ffmpeg missing or the wrong arch in the image.**
   → The container smoke runs both binaries in the built image.

---

### Task 1: `/health` reports the version

**Files:** `src/proxy.ts`, `openapi.yaml`, `test/client-api.test.ts`

- `GET /health` → `{ ok: true, version: VERSION }`. It is still public, and
  the version is not secret: it is in the release notes.
- Test: `/health` without a token gives `{ ok: true, version: 'dev' }`.

### Task 2: Dockerfile, .dockerignore, container smoke test

**Files:** `Dockerfile`, `.dockerignore`, `scripts/container-smoke.sh`,
`.github/workflows/pr-checks.yml` (`container` job)

```dockerfile
# syntax=docker/dockerfile:1
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:26-alpine
ARG TARGETARCH
ARG GO2RTC_VERSION=v1.9.14
RUN apk add --no-cache ffmpeg \
 && case "${TARGETARCH:-amd64}" in \
      amd64) a=amd64; sum=<linux amd64 sha from install-go2rtc.sh> ;; \
      arm64) a=arm64; sum=<linux arm64 sha from install-go2rtc.sh> ;; \
      *) echo "unsupported arch" >&2; exit 1 ;; esac \
 && wget -q -O /usr/local/bin/go2rtc "https://github.com/AlexxIT/go2rtc/releases/download/${GO2RTC_VERSION}/go2rtc_linux_${a}" \
 && echo "${sum}  /usr/local/bin/go2rtc" | sha256sum -c - \
 && chmod 755 /usr/local/bin/go2rtc && go2rtc -version
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
 && node -e "require('sharp')"
COPY --from=build /app/dist ./dist
COPY openapi.yaml CHANGELOG.md config.schema.json ./
RUN mkdir -p /data && chown 1000:1000 /data
ENV NODE_ENV=production CAMPROXY_CONFIG=/data/config.json CAMPROXY_TARGET=cluster
ARG APP_VERSION=dev
ARG BUILD_DATE=
ENV CAMPROXY_VERSION=${APP_VERSION} CAMPROXY_BUILD_DATE=${BUILD_DATE}
USER 1000:1000
VOLUME /data
EXPOSE 8480 2121 30000-30009
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s CMD wget -qO- http://127.0.0.1:8480/health >/dev/null || exit 1
CMD ["node", "dist/src/cli.js"]
```

- **The checksum values** are copied from `scripts/install-go2rtc.sh`, never
  typed from memory.
- **`sharp`:** with `--ignore-scripts`, sharp's optional prebuilt package
  (`@img/sharp-linuxmusl-*`) is still installed as an optionalDependency, and
  the `require('sharp')` line proves it. If it doesn't load, drop
  `--ignore-scripts` for the runtime `npm ci` and write a ruling.
- **The config** in the container: `CAMPROXY_CONFIG=/data/config.json`. The
  cluster mounts its ConfigMap file there, or points `CAMPROXY_CONFIG` at the
  mount. Check how `loadConfig` treats a missing file (defaults) and that
  `dataDir` defaults to `/data` in the image (`CAMPROXY_DATA_DIR`, or
  `server.dataDir` in config.json). Whichever the code supports, record it in
  a ruling.
- **`.dockerignore`:**
  `node_modules dist .git .env* data tools test-results playwright-report coverage .superpowers config.json overrides.json e2e test docs`.
- **`scripts/container-smoke.sh`:**
  1. build the image (host arch, `APP_VERSION=smoke`);
  2. check that `docker run --rm --entrypoint go2rtc img -version`,
     `--entrypoint ffmpeg img -version` and `--entrypoint id img -u` (= 1000)
     work;
  3. run it with throwaway secrets (generated with `openssl rand`, never
     printed), a named volume created fresh (owned by root, like a PVC before
     `fsGroup`) and a minimal `config.json` with `stills.enabled: false`
     (camera host `127.0.0.1:9`: offline is fine);
  4. wait for `/health` to be `{"ok":true,"version":"smoke"}`, `/api/cameras`
     without a token → 401, and with the token → 200;
  5. clean up (container and volume), on failure too (`trap`).

  If the fresh root-owned volume makes start-up fail, the fix is in the
  image or the start-up error message (Review Focus 1). The cluster uses
  `fsGroup: 1000`.
- **CI:** a `container` job in pr-checks runs the script.
- Tests: the script itself (run locally with Docker).
  Expected: `container smoke: ok`.

### Task 3: build-push and release workflows

**Files:** `.github/workflows/build-push.yml`, `.github/workflows/release.yml`

- **`build-push.yml`**: cam-sim's `build-push.yml` with the names changed.
  - Push to `main`: npm ci, the tests (with go2rtc/MediaMTX/ffmpeg installed
    as in pr-checks), then QEMU and buildx.
  - Image `ghcr.io/klaushofrichter/cam-proxy`, `linux/amd64,linux/arm64`,
    tags `:main` and `:sha-${{ github.sha }}`, `APP_VERSION=main`.
- **`release.yml`**: cam-sim's `release.yml` adapted:
  - **build:** the production-only guard and the calendar version as in
    cam-sim. The image is `ghcr.io/klaushofrichter/cam-proxy:v<ver>` and
    `:latest`, multi-arch, with the digest output.
  - **deploy** (`runs-on: [self-hosted, k3s]`):
    - in-cluster kubectl, then clone kube-setup with `KUBE_SETUP_DEPLOY_TOKEN`;
    - `sed` `manifests/cam-proxy/cam-proxy-deployment.yaml` line
      `image: ghcr.io/klaushofrichter/cam-proxy...` to
      `ghcr.io/klaushofrichter/cam-proxy@<digest>`, and `grep -q` that it
      changed;
    - commit `Deploy cam-proxy v<ver>` as `cam-proxy-deploy-bot`, push, **then**
      `kubectl apply -f` that one file;
    - poll `generation`/`observedGeneration`/`updatedReplicas`/`availableReplicas`
      of deployment `cam-proxy` in namespace `cam-proxy` (5 minutes);
    - **Smoke test:** poll
      `curl -sf http://cam-proxy.cam-proxy.svc.cluster.local:8480/health` until
      `version` equals `<ver>` (2 minutes), then
      `curl .../api/cameras` → 401 without a token.
  - **publish:**
    - `gh release create v<ver>` with notes from the CHANGELOG `[Unreleased]`
      section (as cam-sim), plus the git log since the previous tag and the
      image line with its digest;
    - no npm tarball (cams talks to cam-proxy over HTTP).
- **Verification:**
  - `actionlint` on both files (install with `brew install actionlint` if it
    is missing, or `npx --yes @action-validator/cli`);
  - read the diff against cam-sim's files side by side.

  The first real run is Task 6.

### Task 4: sync-secrets to GitHub and the cluster

**Files:** `scripts/sync-secrets.sh`, `.env.example`, `test/sync-secrets.test.ts`, README

- **Options, as cam-sim's script:**
  - `--only github|kube`, `--gh-login`, `--dry-run`, `--rotate KEY`,
    `--env-file`;
  - `KUBE_CONTEXT`, `KUBE_NAMESPACE` (`cam-proxy`) and `KUBE_SECRET`
    (`cam-proxy-secrets`), all from `.env`;
  - `GITHUB_REPO` (`klaushofrichter/cam-proxy`).
- **What it syncs:**
  - **The kube Secret** `cam-proxy-secrets` in `cam-proxy`: the four
    `CAMPROXY_*` keys, created with
    `kubectl create secret generic --from-env-file=<(filtered) --dry-run=client -o yaml | kubectl apply -f -`.
    Values never appear on the command line.
  - **GitHub repo secret** `KUBE_SETUP_DEPLOY_TOKEN` from `.env`'s
    `GITHUB_KUBE_SETUP_PAT` (GitHub refuses names starting with `GITHUB_`).
    The workflows need no other secret.
- **Checks:**
  - it refuses a `.env` that isn't mode 600;
  - it refuses values with an inline `#` comment (the cam-sim first-deploy
    trap).
- **Tests** (bash through vitest, with `kubectl` and `gh` replaced by stub
  scripts on `PATH` that record their arguments and stdin):
  - `--dry-run --only kube` prints the key names and no value;
  - the stub `kubectl` receives the values only on stdin or through the
    env-file, never in argv;
  - a `.env` with mode 644 → exit 1;
  - an inline comment → exit 1.

### Task 5: Cluster configuration and the kube-setup request

**Files:** `deploy/cluster/config.json`, `deploy/cluster/REQUEST.md`,
`compose.yaml` (Pi), README "Deployment"

- **`deploy/cluster/config.json`** (becomes the ConfigMap, no secrets):
  - `camera`: `{ id: 'cam2', name: 'cam2', host: 'cam2.cam-sim.svc.cluster.local:443', protocol: 'https', tlsName: 'cam2.skylar.technology', user: 'proxy', onvifPort: 8000, rtspPort: 554 }`,
    with the ports as cam2's ClusterIP Service exposes them;
  - `server.dataDir: '/data'`;
  - `stills.enabled: true`;
  - `ftp`: `{ enabled: true, publicHost: 'cam-proxy.cam-proxy.svc.cluster.local', tls: true, stream: 'sub' }`.

  The file must validate: add a test in `test/config.test.ts` that loads it
  through `loadConfig` with dummy secrets.
- **cam2 needs a `proxy` user:** `CAMSIM_USERS` in cam-sim's `.env` gets a
  `proxy` entry (admin level), then cam-sim's `sync-secrets.sh --only kube`
  runs and cam2 restarts. The same password goes in `CAMPROXY_CAMERA_PASSWORD`
  in the cluster Secret. This is a secret change on cam2: ask Klaus in chat
  first, or do it if he says so (he did the equivalent for cams). Never
  `source` cam-sim's `.env`.
- **`deploy/cluster/REQUEST.md`**, the request to the kube-setup session. It
  lists exactly:
  - namespaces `cam-proxy` and `cam-proxy-runner`, with the runner,
    `deploy-sa` and a Role with get/watch/patch on deployment `cam-proxy`
    only, and a NetworkPolicy;
  - the Deployment `cam-proxy`:
    - replicas 1, `strategy: Recreate`, a single-line digest-pinned image;
    - `envFrom: cam-proxy-secrets`;
    - the ConfigMap `cam-proxy-config` (from `deploy/cluster/config.json`)
      mounted as a file, with `CAMPROXY_CONFIG` pointing at it;
    - probes httpGet `/health:8480`;
    - securityContext uid/gid 1000, `fsGroup: 1000`, drop ALL, seccomp
      RuntimeDefault;
    - resources requests 100m/256Mi, limits 1000m/1Gi (ffmpeg and go2rtc);
  - a PVC `cam-proxy-data`, 20Gi local-path, **Retain** (clips and the
    catalog are not regenerable);
  - the ClusterIP Service `cam-proxy`: 8480, 2121 and 30000-30009;
  - NetworkPolicy allowances:
    - cam2 (namespace `cam-sim`) → cam-proxy 2121 and 30000-30009;
    - cam-proxy → cam2 443, 8000 and 554;
    - Traefik → 8480;
  - the Certificate and the IngressRoute for `cam-proxy.skylar.technology`:
    LAN-only ipAllowList `192.168.1.0/24`, with the ACME path exempt, as
    cam2's UI route. **This needs Klaus's approval**, obtained in chat and
    quoted in the request;
  - `bootstrap.sh` and `export.sh` entries, and a Services note;
  - order: commit, push, then apply;
  - not now: the FTP LoadBalancer for the real camera (issue #4), which needs
    its own approval.
- **The request goes** to the kube-setup session by cross-session message
  (ListAgents → SendMessage), and as a GitHub issue in kube-setup if no
  session runs.
- **`compose.yaml` for the Pi:**
  - the same image, `network_mode: host`, `restart: unless-stopped`;
  - `/data` bind-mounted at `${CAMPROXY_DATA:-./data}`, secrets from `.env`;
  - `CAMPROXY_TARGET=pi`.

  Ruling to record: go2rtc runs inside the one container on the Pi too (the
  spec had go2rtc's official image as a second container; one image is
  simpler and `go2rtc.url` doesn't exist). It is verified when the Pi
  arrives.
- **Tests:** the config test; `docker compose config` validates
  `compose.yaml`.

### Task 6: Release and verify in the cluster

**Files:** CHANGELOG, README; GitHub settings (no files)

1. **Branch protection on `production`:** check it has test+codeql, strict,
   and no force-push (Plan 1 set it). Add `container` as a required check?
   Keep test+codeql as the standard, and record a ruling.
2. **Secrets:**
   - `sync-secrets.sh --only github` sets `KUBE_SETUP_DEPLOY_TOKEN` (needs
     Klaus's PAT in `.env`: ask for it if it is missing);
   - `--only kube` creates `cam-proxy-secrets` once the namespace exists.
3. **Wait for kube-setup** to report the manifests pushed and applied: the
   runner registered, the PVC bound, the route and certificate ready.
4. **Open the PR `main` → `production`.** Merge only when all checks pass.
   The release runs.
5. **Verify through the cluster** (from the Mac on the LAN):
   - `https://cam-proxy.skylar.technology/health` shows the version;
   - status shows the camera online and ONVIF subscribed;
   - stills arrive (the Timeline);
   - `camera-ftp-setup` → cam2 uploads a clip on a simulated event
     (cam-sim's control API) → the Clips page plays it → `camera-ftp-off`.
6. **Record the results** in the CHANGELOG and README: the deployed URL, and
   what was verified.
