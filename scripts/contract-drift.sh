#!/usr/bin/env bash
# The cams-admin contract drift check (cams-admin spec
# 2026-10-06-cams-admin-phase1-design §15.4): the vendored copy in
# test/contract/cams-admin-v1 must equal cams-admin main's contract/v1
# (SOURCE excluded). Vendoring a new contract = copy + update SOURCE in the
# same PR. Until cams-admin main has contract/v1, the commit in SOURCE is
# the reference.
set -euo pipefail
dir=test/contract/cams-admin-v1
repo=${CAMS_ADMIN_REPO:-https://github.com/klaushofrichter/cams-admin.git}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git clone -q --filter=blob:none --no-checkout "$repo" "$tmp/repo"
ref=origin/main
if ! git -C "$tmp/repo" cat-file -e "$ref:contract/v1/vectors.json" 2>/dev/null; then
  ref=$(awk '{print $2}' "$dir/SOURCE")
  echo "::notice::cams-admin main has no contract/v1 yet: checking against $ref (SOURCE)"
fi
mkdir "$tmp/out"
git -C "$tmp/repo" archive "$ref" contract/v1 | tar -x -C "$tmp/out"
if ! diff -r -x SOURCE "$tmp/out/contract/v1" "$dir"; then
  echo "::error::test/contract/cams-admin-v1 differs from cams-admin $ref contract/v1: vendor the new contract (copy it and update SOURCE)"
  exit 1
fi
echo "contract/v1 matches cams-admin $ref"
