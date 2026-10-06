# kube-setup request: cam-proxy next to cam2

**Status:** applied by kube-setup. cam-proxy is released and running in the
cluster (v2026.09.27.1, v2026.09.27.2); cams uses it for `cam2` (a `proxy`
entry in `cams-cameras`).

2026-10-02: cam-proxy reaches `cam2.cam-sim.svc.cluster.local:9000` (TCP, Baichuan) for recordings. cam-sim asked kube-setup for the cluster-internal Service port 9000 on cam2 (no ingress, LoadBalancer or NodePort) and cam-proxy's egress to it; both are applied (kube-setup 478c0f8 and f9d1e8d). The Pi reaches the real camera's port 9000 on the LAN.

cam-proxy (github.com/klaushofrichter/cam-proxy) is the camera gateway: it
keeps one connection to a camera, stores a still per second, records events,
receives the camera's clips by FTP(S) and serves it all over HTTP/SSE. In the
cluster its camera is cam2. It follows the cam2 pattern: this repo owns the
image, `release.yml` (deploy job) and `scripts/sync-secrets.sh`; kube-setup
owns every manifest below.

Order as always: **commit, push, then apply.**

## 1. Namespaces and the runner

- Namespace `cam-proxy` (the workload) and `cam-proxy-runner`: a repo-scoped
  runner for klaushofrichter/cam-proxy, as `cam-sim-runner`.
  - Labels `[self-hosted, k3s]`.
  - Registration PAT in Secret `runner-pat` (key `token`). The value is
    `CAMPROXY_GITHUB_PAT` in cam-proxy's `.env`. Klaus agreed to it; the
    cam-proxy session can create the Secret without printing it, once the
    namespace exists, if you prefer that to doing it yourself.
  - The runner needs about 512Mi: the deploy job runs kubectl, git and curl
    only, with no Playwright.
- ServiceAccount `deploy-sa` in `cam-proxy-runner`. Role `cam-proxy-deployer`
  in `cam-proxy`: `get`, `watch`, `patch` on `deployments`, `resourceNames:
  [cam-proxy]`. The deploy polls generation; there is no `rollout status`.
- NetworkPolicy for `cam-proxy-runner`: default-deny ingress, as for cam-sim.
- Add both namespaces to `bootstrap.sh` and `scripts/export.sh`.

## 2. Workload (namespace `cam-proxy`)

- **ConfigMap `cam-proxy-config`** from
  [`deploy/cluster/config.json`](config.json), key `config.json`. It holds no
  secrets.
- **Secret `cam-proxy-secrets`:** created by `scripts/sync-secrets.sh
  --env-file .env.cluster --only kube`, keys `CAMPROXY_TOKENS`,
  `CAMPROXY_ADMIN_TOKEN`, `CAMPROXY_CAMERA_PASSWORD`, `CAMPROXY_FTP_PASSWORD`.
  The cam-proxy session runs it once the namespace exists. Please don't
  create it from the kube-setup side.
- **PVC `cam-proxy-data`:** 20Gi, `local-path`, **reclaim policy Retain**. It
  holds clips, stills and the catalog, which are not regenerable.
  local-path doesn't enforce the size (the volume is a host folder, and
  statfs sees the node's disk), so the app caps itself:
  `storage.maxBytes` in the ConfigMap is 17 GiB (85 % of 20Gi). Its hard
  floor (`minFreeBytes`, 2 GiB) is measured on the node's disk.
- **Deployment `cam-proxy`:**
  - replicas 1, `strategy: Recreate` (one RWO volume, one camera session);
  - image on **one line**, digest-pinned; the deploy job seds
    `image: ghcr.io/klaushofrichter/cam-proxy[@:].*`. For the first apply,
    use `ghcr.io/klaushofrichter/cam-proxy:main` or the first release's
    digest;
  - `imagePullPolicy: IfNotPresent`, no pull secret. The ghcr package is
    public: Klaus sets that after the first push, and an anonymous
    `docker pull ghcr.io/klaushofrichter/cam-proxy:main` confirms it before
    this request is applied;
  - env `CAMPROXY_CONFIG=/config/config.json`, `envFrom: secretRef:
    cam-proxy-secrets`;
  - volumes: ConfigMap on `/config` (read-only), PVC on `/data`, emptyDir
    on `/tmp`;
  - ports: 8480 (http), 2121 (ftp), 30000-30009 (ftp passive);
  - probes: liveness and readiness httpGet `/health` on 8480, with
    readiness `initialDelaySeconds: 5` and liveness `initialDelaySeconds: 20`;
  - resources: requests 100m / 256Mi, limits 1000m / 1Gi (go2rtc plus one
    ffmpeg making a still per second);
  - securityContext:
    - pod: `runAsNonRoot`, `runAsUser: 1000`, `runAsGroup: 1000`,
      `fsGroup: 1000`, `seccompProfile: RuntimeDefault`;
    - container: `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`;
    - `readOnlyRootFilesystem: true` works with an `emptyDir` on `/tmp`
      (`medium: Memory`, `sizeLimit: 16Mi`): the app writes to `/data`, and
      go2rtc's generated config (mode 0600) goes to the temp folder.
- **Service `cam-proxy`:** ClusterIP, ports 8480, 2121, and 30000-30009 (ten
  entries, names `pasv-0`…`pasv-9`). cam2 uploads to
  `cam-proxy.cam-proxy.svc.cluster.local:2121`, and passive mode announces
  that name's ClusterIP.
- **NetworkPolicy** (if `cam-proxy` gets default-deny) allowing:
  - into cam-proxy: from Traefik (`kube-system`) to 8480; from namespace
    `cam-proxy-runner` to 8480 (the release smoke test); from namespace
    `cam-sim` (cam2) to 2121 and 30000-30009 (FTP uploads);
  - out of cam-proxy: to pods `app=cam2` in namespace `cam-sim` on the
    **pod ports** 8443, 8000 and 8554 (Service ports 443, 8000 and 554:
    NetworkPolicy matches after the ClusterIP DNAT), and 9000 (Baichuan,
    recordings over TCP; applied by kube-setup on 2026-10-02, kube-setup
    f9d1e8d), and to DNS (UDP/TCP 53 in `kube-system`).

  If `cam-sim` has an egress policy, cam2 must be allowed to reach
  cam-proxy 2121 and 30000-30009.

## 3. The admin UI at `cam-proxy.skylar.technology` (LAN only)

As cam2's `cam2-ui-route.yaml`:
- a Certificate from `letsencrypt-prod` (HTTP-01) for
  `cam-proxy.skylar.technology`;
- an IngressRoute on `websecure`: `` Host(`cam-proxy.skylar.technology`) &&
  !PathPrefix(`/.well-known/acme-challenge/`) `` to Service `cam-proxy:8480`
  (plain HTTP inside the cluster);
- the ipAllowList middleware `192.168.1.0/24`.

The DNS name already exists. **Network exposure approval:** Klaus,
2026-09-27, in the cam-proxy session, answering "OK to publish
`https://cam-proxy.skylar.technology` on the LAN only (allow-list
192.168.1.0/24, Let's Encrypt), no FTP ports on the LAN?": "Ok for all three
questions".

## 4. Not now

- **The real camera (cam1) uploading to the cluster** needs a LAN
  LoadBalancer for 2121 and 30000-30009, as cam2's gateway service
  (`loadBalancerSourceRanges 192.168.1.0/24`). It gets a separate approval
  later (cam-proxy issue #4).
- **cams using cam-proxy:** done. It added a `proxy` entry to
  `cams-cameras` for `cam2`, and cam2 uploads its clips as the sub stream
  (`ftp.stream: "sub"` in [`config.json`](config.json)).

## 5. Also

- The cluster Secret may get an optional `CAMPROXY_AUDIT_TOKEN` later, for
  a poller that reads the audit log (docs/audit-log.md). No action is needed
  now.
- The same for an optional `CAMPROXY_POE_SWITCH_PASSWORD` (the camera
  power-cycle through a PoE switch, docs/poe-switch.md). cam2 is simulated and
  has no switch, so the cluster leaves it unset; `scripts/sync-secrets.sh`
  adds it only when it is set. No action is needed.
- On cam2, a camera user `proxy` (admin level): **done** 2026-09-27. It was
  added to `CAMSIM_USERS`, `cam-sim-secrets` synced, and cam2 restarted
  (rollout restart); login as `proxy` verified.
- A Services note for cam-proxy in the vault.
- Please report back when it is pushed and applied (runner registered, PVC
  bound, certificate ready), so the first release can run.

## 2026-10 multi-camera host (P4 of the multi-camera spec)

Asked of the kube-setup session (Klaus applies; nothing here edits kube-setup).
The guide is [docs/multi-camera-host.md](../../docs/multi-camera-host.md).

1. cams egress: allow the cams pods to reach `192.168.60.0/24` on TCP 443
   (the cameras, over the router's static route to the mini PC) and the mini
   PC's LAN address on TCP 8480 (cam-proxy over HTTP, between P4 and P5:
   Klaus approved 8480 open to the LAN for that time) and on TCP 8443
   (cam-proxy over HTTPS from P5 on; P5 then drops the 8480 rule). Today the
   NetworkPolicy allows cams → cam-proxy:8480 only.
2. The route test from a cluster node and from a pod in the cams namespace
   (docs/multi-camera-host.md §6, step 2): `ping -c 3 192.168.60.13`,
   `curl -vk --connect-timeout 5 https://192.168.60.13/`, `traceroute -n
   192.168.60.13`; and the cluster's pod and service CIDRs (k3s
   `--cluster-cidr`, `--service-cidr`) for host.json's `clusterCidrs`.
3. The `cams-cameras` Secret gets the new cameras' entries (generated by
   cams' `scripts/cameras-config.ts`, P3); Klaus applies it.
