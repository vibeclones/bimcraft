#!/usr/bin/env bash
# Keep skipped.json: the versions upstream has that this mirror does not host, each with the reason.
#   skip.sh sync <file> [reason]   for every version named in <file> (tag or version per line): if its v<ver>/ folder is
#                                  missing record the reason, if it exists drop any old record
#   skip.sh add <ver> <reason>     record one skipped version
#   skip.sh del <ver>              forget one
set -euo pipefail
f=skipped.json
[ -f "$f" ] || echo '{}' > "$f"
put() { jq --arg v "$1" --arg r "$2" '.[$v] = $r' "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }
drop() { jq --arg v "$1" 'del(.[$v])' "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }
case "${1:-}" in
  sync)
    reason="${3:-It could not be built, or the release has no browser version.}"
    while read -r t; do
      [ -n "$t" ] || continue; v="${t#v}"
      if [ -d "v$v" ]; then drop "$v"; else put "$v" "$reason"; fi
    done < "$2" ;;
  add) put "$2" "$3" ;;
  del) drop "$2" ;;
  *) echo "usage: skip.sh sync|add|del ..." >&2; exit 2 ;;
esac
# An empty record needn't be a file.
[ "$(jq 'length' "$f")" -eq 0 ] && rm -f "$f" || true
