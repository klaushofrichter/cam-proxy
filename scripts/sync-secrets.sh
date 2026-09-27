#!/usr/bin/env bash
# Keeps cam-proxy's secrets in an env file and syncs them to GitHub Actions
# and the cluster. Prints key names only, never values. Klaus runs the sync
# (or allows it).
#
#   scripts/sync-secrets.sh [--only local|github|kube|all] [--dry-run]
#                           [--rotate KEY]... [--env-file PATH]
#
# local (default): fill the env file — generates CAMPROXY_TOKENS (one client
#   token; add more comma-separated), CAMPROXY_ADMIN_TOKEN and
#   CAMPROXY_FTP_PASSWORD when missing. CAMPROXY_CAMERA_PASSWORD is set by
#   hand: the password of the proxy's user on its camera.
# github: GITHUB_KUBE_SETUP_PAT as the repo secret KUBE_SETUP_DEPLOY_TOKEN
#   (GitHub refuses names starting with GITHUB_), for the release's deploy.
# kube: Secret $KUBE_SECRET (cam-proxy-secrets) in $KUBE_NAMESPACE (cam-proxy),
#   context $KUBE_CONTEXT, with the four CAMPROXY_* values.
#
# The cluster's camera is cam2, so its values live in their own file:
#   scripts/sync-secrets.sh --env-file .env.cluster --only all
set -euo pipefail
umask 077

ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
DRY=0
ONLY=local
ROTATE=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --only) ONLY="$2"; shift ;;
    --rotate) ROTATE+=("$2"); shift ;;
    --env-file) ENV_FILE="$2"; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "sync-secrets: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
case "$ONLY" in local|github|kube|all) ;; *) echo "sync-secrets: --only must be local, github, kube or all" >&2; exit 2 ;; esac
for r in "${ROTATE[@]+"${ROTATE[@]}"}"; do
  case "$r" in CAMPROXY_TOKENS|CAMPROXY_ADMIN_TOKEN|CAMPROXY_FTP_PASSWORD) ;;
    *) echo "sync-secrets: can rotate only CAMPROXY_TOKENS, CAMPROXY_ADMIN_TOKEN, CAMPROXY_FTP_PASSWORD (not $r)" >&2; exit 2 ;;
  esac
done

die() { echo "sync-secrets: $*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || { [ "$DRY" = 1 ] && die "$ENV_FILE not found"; touch "$ENV_FILE"; chmod 600 "$ENV_FILE"; }
perms=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")
case "$perms" in *00) ;; *) die "$ENV_FILE is readable by others (mode $perms); run: chmod 600 $ENV_FILE" ;; esac

# Values never go on a command line (ps shows argv): awk reads them from ENVIRON.
raw() { K="$1" awk 'index($0, ENVIRON["K"] "=") == 1 { print substr($0, length(ENVIRON["K"]) + 2); exit }' "$ENV_FILE"; }
has() { grep -q "^$1=." "$ENV_FILE"; }
# An inline comment would become part of the value (it broke cam-sim's first deploy).
get() {
  local v
  v=$(raw "$1")
  if [[ "$v" =~ [[:space:]]# ]]; then die "$1 has an inline comment; put comments on their own line"; fi
  printf '%s' "$v"
}
put() {
  local tmp
  tmp=$(mktemp "$ENV_FILE.XXXXXX")
  K="$1" V="$2" awk '
    index($0, ENVIRON["K"] "=") == 1 { print ENVIRON["K"] "=" ENVIRON["V"]; done = 1; next }
    { print }
    END { if (!done) print ENVIRON["K"] "=" ENVIRON["V"] }' "$ENV_FILE" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}
rotating() { local r; for r in "${ROTATE[@]+"${ROTATE[@]}"}"; do [ "$r" = "$1" ] && return 0; done; return 1; }
say() { if [ "$DRY" = 1 ]; then echo "would $*"; else echo "$*"; fi; }

# Check every value first, so a bad line stops the run before anything changes.
for key in CAMPROXY_TOKENS CAMPROXY_ADMIN_TOKEN CAMPROXY_CAMERA_PASSWORD CAMPROXY_FTP_PASSWORD GITHUB_KUBE_SETUP_PAT KUBE_CONTEXT KUBE_NAMESPACE KUBE_SECRET GITHUB_REPO; do
  get "$key" >/dev/null
done

# 1. Generated values.
for key in CAMPROXY_TOKENS CAMPROXY_ADMIN_TOKEN CAMPROXY_FTP_PASSWORD; do
  if ! has "$key" || rotating "$key"; then
    if [ "$DRY" = 1 ]; then echo "would generate $key"; else put "$key" "$(openssl rand -hex 32)"; echo "generated $key"; fi
  fi
done
has CAMPROXY_CAMERA_PASSWORD || echo "missing CAMPROXY_CAMERA_PASSWORD (set it by hand: the password of the proxy's camera user)"

REPO=$(get GITHUB_REPO); REPO=${REPO:-klaushofrichter/cam-proxy}
NS=$(get KUBE_NAMESPACE); NS=${NS:-cam-proxy}
SECRET=$(get KUBE_SECRET); SECRET=${SECRET:-cam-proxy-secrets}
CONTEXT=$(get KUBE_CONTEXT)

# 2. GitHub Actions secret, the value on stdin.
if [ "$ONLY" = github ] || [ "$ONLY" = all ]; then
  pat=$(get GITHUB_KUBE_SETUP_PAT)
  [ -n "$pat" ] || die "set GITHUB_KUBE_SETUP_PAT in $ENV_FILE (the kube-setup deploy token)"
  say "set github secret KUBE_SETUP_DEPLOY_TOKEN on $REPO"
  if [ "$DRY" = 0 ]; then
    printf '%s' "$pat" | gh secret set KUBE_SETUP_DEPLOY_TOKEN --repo "$REPO" >/dev/null
  fi
fi

# 3. The Kubernetes Secret, from a private temporary env file.
if [ "$ONLY" = kube ] || [ "$ONLY" = all ]; then
  [ -n "$CONTEXT" ] || die "set KUBE_CONTEXT in $ENV_FILE (there is no default context)"
  has CAMPROXY_CAMERA_PASSWORD || die "set CAMPROXY_CAMERA_PASSWORD in $ENV_FILE first"
  say "apply kubernetes secret $SECRET in $NS (context $CONTEXT): CAMPROXY_TOKENS, CAMPROXY_ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD, CAMPROXY_FTP_PASSWORD"
  if [ "$DRY" = 0 ]; then
    tmp=$(mktemp)
    trap 'rm -f "$tmp"' EXIT
    for key in CAMPROXY_TOKENS CAMPROXY_ADMIN_TOKEN CAMPROXY_CAMERA_PASSWORD CAMPROXY_FTP_PASSWORD; do
      printf '%s=%s\n' "$key" "$(get "$key")" >> "$tmp"
    done
    kubectl --context "$CONTEXT" -n "$NS" create secret generic "$SECRET" --from-env-file="$tmp" --dry-run=client -o yaml \
      | kubectl --context "$CONTEXT" apply -f - >/dev/null
  fi
fi
