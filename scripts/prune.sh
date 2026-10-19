#!/usr/bin/env bash
# Keep the published site under a size cap by dropping the oldest version folders (never the newest one).
# GitHub Pages limits a published site to about 1 GB, so the cap leaves room to spare.
# Env: CAP_MB (default 800)
set -euo pipefail

CAP_MB="${CAP_MB:-800}"
removed=0
while :; do
  size=$(du -sm --exclude=.git . | cut -f1)
  [ "$size" -le "$CAP_MB" ] && break
  count=$(find . -maxdepth 1 -type d -name 'v[0-9]*' | wc -l)
  [ "$count" -le 1 ] && break
  oldest=$(find . -maxdepth 1 -type d -name 'v[0-9]*' -printf '%f\n' | sed 's/^v//' | sort -V | head -n1)
  echo "Site is ${size} MB, over the ${CAP_MB} MB cap: dropping v${oldest}"
  rm -rf "v${oldest}"
  [ -f scripts/skip.sh ] && bash scripts/skip.sh add "$oldest" "Dropped to stay within our storage limit." || true
  removed=$((removed + 1))
done

# Keep versions.json in step with the folders that are left.
if [ "$removed" -gt 0 ] && [ -f versions.json ]; then
  keep=$(find . -maxdepth 1 -type d -name 'v[0-9]*' -printf '%f\n' | sed 's/^v//' | jq -R . | jq -s .)
  jq --argjson keep "$keep" '.versions |= map(select(. as $v | $keep | index($v)))' versions.json > versions.tmp
  mv versions.tmp versions.json
fi
echo "Site size: $(du -sm --exclude=.git . | cut -f1) MB (cap ${CAP_MB} MB), versions kept: $(find . -maxdepth 1 -type d -name 'v[0-9]*' | wc -l)"
