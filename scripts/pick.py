#!/usr/bin/env python3
"""Choose which upstream releases to host, thinning out toward the past.

stdin: JSON list of {tagName, publishedAt} (from `gh release list --json tagName,publishedAt`).
stdout: the tags to keep, newest first, one per line.

Taste: recent releases are kept densely, older ones sparsely.
  - the newest release is always kept, and so is the oldest one (a relic, for fun)
  - the last release of each major version is kept (the "stable" landmarks)
  - everything else is bucketed by age, and only the last release in each bucket survives:
      under a week old: one per day;  under a month: one per 3 days;
      under 3 months: one per week;   under a year: one per month;  older: one per quarter
  - but none of this applies while the whole history fits under the size cap (CAP_MB, default 800; sizes are
    estimated from the versions already hosted). Thinning only starts when space runs out, and then the biggest
    gaps in the timeline are filled back in up to what fits, so the history is never thinner than it must be
"""
import json, os, re, sys
from datetime import datetime, timezone

rels = json.load(sys.stdin)
now = datetime.now(timezone.utc)
for r in rels:
    r["d"] = datetime.fromisoformat(r["publishedAt"].replace("Z", "+00:00"))
rels.sort(key=lambda r: r["d"], reverse=True)

def major(tag):
    m = re.match(r"^\D*(\d+)", tag)
    return m.group(1) if m else None

def bucket(r):
    days = (now - r["d"]).days
    if days < 7:   return ("d", days)
    if days < 30:  return ("3d", days // 3)
    if days < 90:  return ("w", days // 7)
    if days < 365: return ("m", days // 30)
    return ("q", days // 91)

keep, seen, seen_major = set(), set(), set()
for r in rels:  # newest first, so the first hit in a bucket/major is its latest release
    b, mj = bucket(r), major(r["tagName"])
    if b not in seen:
        seen.add(b); keep.add(r["tagName"])
    if mj is not None and mj not in seen_major:
        seen_major.add(mj); keep.add(r["tagName"])
if rels:
    keep.add(rels[0]["tagName"]); keep.add(rels[-1]["tagName"])
# A young or fast-moving project has many releases in a short time, which the age buckets would thin too hard.
# Top up to a budget by repeatedly adding the release that sits in the biggest gap between kept neighbours,
# so the extra versions spread evenly along the timeline.
def hosted_mb():
    """Average unpacked size of the versions already hosted in the current folder (40 MB if there are none)."""
    sizes = []
    for d in os.listdir("."):
        if re.match(r"v\d", d) and os.path.isdir(d):
            sizes.append(sum(os.path.getsize(os.path.join(a, f)) for a, _, fs in os.walk(d) for f in fs) / 1048576)
    return sum(sizes) / len(sizes) if sizes else float(os.environ.get("EST_MB", "40"))

# How many versions fit under the size cap. Thinning only starts when the whole history would not fit.
BUDGET = int(os.environ.get("BUDGET", 0)) or max(5, int(float(os.environ.get("CAP_MB", "800")) * 0.9 / max(hosted_mb(), 1)))
if len(rels) <= BUDGET:
    keep = {r["tagName"] for r in rels}
while len(keep) < min(BUDGET, len(rels)):
    kept = [i for i, r in enumerate(rels) if r["tagName"] in keep]
    best, gap = None, -1
    for a, b in zip(kept, kept[1:]):
        if b - a < 2:
            continue
        mid = (a + b) // 2
        g = (rels[a]["d"] - rels[b]["d"]).total_seconds()
        if g > gap:
            best, gap = mid, g
    if best is None:
        break
    keep.add(rels[best]["tagName"])
for r in rels:
    if r["tagName"] in keep:
        print(r["tagName"])
