#!/usr/bin/env bash
# Mirror an upstream project's web builds into v<version>/ folders, then refresh latest/ and versions.json.
# Mirrors every stable release that has a web zip, newest first, and stops when the next one would not fit under the
# size cap (the oldest versions are the ones left out).
# Env: UPSTREAM (owner/repo), NAME (app name, e.g. photocraft)
#      TAG_STRIP (optional: regex for the part of a release tag before the version, default 'v'; e.g. 'modelcraft-v')
#      ASSET_RE (optional: regex for the browser zip's name, when it isn't <name>-web-<version>.zip)
#      LEGACY_NAME (optional: an earlier name that older release zips use)
#      TAG (optional: mirror just this release), LIMIT (how many recent releases to look at, default 40),
#      CAP_MB (published-site size cap, default 800)
set -euo pipefail

: "${UPSTREAM:?}" "${NAME:?}"
LIMIT="${LIMIT:-40}"
CAP_MB="${CAP_MB:-800}"

if [ -n "${TAG:-}" ]; then
  tags="$TAG"
else
  if [ "$LIMIT" = taste ]; then
    # Thin the history toward the past (see pick.py) instead of taking a hard cutoff.
    tags=$(gh release list -R "$UPSTREAM" --limit 400 --exclude-drafts --exclude-pre-releases --json tagName,publishedAt | python3 scripts/pick.py)
    # Releases the thinning left out are recorded, so the full history is accounted for.
    for t in $(gh release list -R "$UPSTREAM" --limit 400 --exclude-drafts --exclude-pre-releases --json tagName -q '.[].tagName'); do
      echo "$tags" | grep -qx -- "$t" || [ -d "v${t#v}" ] || bash scripts/skip.sh add "${t#v}" "Left out to stay within our storage limit; we keep a spread of versions."
    done
  else
    tags=$(gh release list -R "$UPSTREAM" --limit "$LIMIT" --exclude-drafts --exclude-pre-releases --json tagName -q '.[].tagName')
  fi
fi

for tag in $tags; do
  ver=$(printf '%s' "$tag" | sed -E "s/^${TAG_STRIP:-v}//")
  if [ -d "v$ver" ]; then bash scripts/skip.sh del "$ver"; continue; fi
  if [ -n "${capped:-}" ]; then bash scripts/skip.sh add "$ver" "Left out to stay within our storage limit."; continue; fi
  # A project renamed partway through its history can name older zips after its old name (LEGACY_NAME).
  asset=""; zip_bytes=""
  if [ -n "${ASSET_RE:-}" ]; then
    # The project names its browser zip its own way: take the first asset matching this regex.
    read -r asset zip_bytes < <(gh api "repos/$UPSTREAM/releases/tags/$tag" --jq "[.assets[] | select(.name | test(\"$ASSET_RE\"))][0] | select(. != null) | [.name, .size] | @tsv" 2>/dev/null || true) || true
  fi
  for n in $( [ -z "$asset" ] && echo "$NAME ${LEGACY_NAME:-}" ); do
    asset="$n-web-$ver.zip"
    zip_bytes=$(gh api "repos/$UPSTREAM/releases/tags/$tag" --jq ".assets[] | select(.name == \"$asset\") | .size" 2>/dev/null || true)
    [ -n "$zip_bytes" ] && break
  done
  if [ -z "$zip_bytes" ]; then echo "No web zip on $tag, skipping"; bash scripts/skip.sh add "$ver" "The author published no browser build for this release."; continue; fi
  # Unpacked, a web build is about 2.4 times its zip. Stop once the next one would not fit.
  size=$(du -sm --exclude=.git . | cut -f1)
  need=$(( zip_bytes * 24 / 10 / 1048576 ))
  if [ $((size + need)) -gt "$CAP_MB" ] && [ -n "$(find . -maxdepth 1 -type d -name 'v[0-9]*' | head -n1)" ]; then
    echo "Stopping at $tag: ${size} MB now + about ${need} MB would pass the ${CAP_MB} MB cap"
    bash scripts/skip.sh add "$ver" "Left out to stay within our storage limit."
    capped=1
    continue
  fi
  tmp="$(mktemp -d)"
  if ! gh release download "$tag" -R "$UPSTREAM" -p "$asset" -D "$tmp"; then echo "Download failed for $tag, skipping"; bash scripts/skip.sh add "$ver" "Its browser build could not be downloaded."; rm -rf "$tmp"; continue; fi
  unzip -q "$tmp/$asset" -d "$tmp/x"
  # The zip wraps everything in one top-level folder.
  src="$tmp/x"
  if [ "$(find "$tmp/x" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ] && [ -d "$(find "$tmp/x" -mindepth 1 -maxdepth 1)" ]; then
    src="$(find "$tmp/x" -mindepth 1 -maxdepth 1)"
  fi
  if [ ! -f "$src/index.html" ]; then echo "$asset has no index.html, skipping"; bash scripts/skip.sh add "$ver" "Its browser build has no index.html, so it can't be opened."; rm -rf "$tmp"; continue; fi
  mkdir "v$ver"
  cp -a "$src/." "v$ver/"
  rm -rf "$tmp"
  bash scripts/skip.sh del "$ver"
  echo "Mirrored $tag"
done

# Newest first.
versions=$(find . -maxdepth 1 -type d -name 'v[0-9]*' -printf '%f\n' | sed 's/^v//' | sort -rV)
[ -n "$versions" ] || { echo "No versions"; exit 0; }
latest=$(echo "$versions" | head -n1)

mkdir -p latest
cat > latest/index.html <<EOF
<!doctype html><meta charset="utf-8"><title>$NAME</title><meta http-equiv="refresh" content="0; url=../v$latest/"><link rel="canonical" href="../v$latest/"><a href="../v$latest/">Open $NAME $latest</a>
EOF

echo "$versions" | jq -R . | jq -s --arg latest "$latest" '{latest: $latest, versions: .}' > versions.json

# A new release can push an old one over the cap; drop the oldest until it fits.
bash scripts/prune.sh
cat versions.json
