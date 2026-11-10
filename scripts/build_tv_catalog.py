#!/usr/bin/env python3
"""Build a slim catalog for the TV edition.

The TV browser is from 2015 and the full catalog is 7.5 MB of JSON. This
keeps only the fields the TV page needs, merges movies, series and anime, and
caps the list so the payload stays small enough for an old engine.

Usage:
    python3 scripts/build_tv_catalog.py
    python3 scripts/build_tv_catalog.py --limit 6000
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUTPUT = DATA / "tv-catalog.json"


def load(name: str) -> list:
    path = DATA / name
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        return payload.get("items") or []
    return payload or []


def slim(item: dict) -> dict | None:
    tmdb = item.get("tm")
    imdb = item.get("im")
    if not tmdb and not imdb:
        return None
    entry = {
        "tm": tmdb,
        "im": imdb,
        "t": item.get("t") or "",
        "y": item.get("y") or 0,
        "r": item.get("r") or 0,
        "p": item.get("p") or "",
        "ty": item.get("ty") or "movie",
    }
    seasons = item.get("s")
    if seasons:
        entry["s"] = seasons
    votes = item.get("v")
    if votes:
        entry["v"] = votes
    # Same weighted score the main catalog uses: a 10 with six votes should not
    # outrank a well known title.
    rating = float(entry.get("r") or 0)
    count = float(entry.get("v") or 0)
    entry["sc"] = round((rating * count + 6.5 * 50) / (count + 50), 3)
    return entry


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=6000)
    args = parser.parse_args()

    merged: dict[str, dict] = {}
    for name in ("movies.json", "series.json", "animes.json"):
        for item in load(name):
            entry = slim(item)
            if not entry:
                continue
            key = f"{entry['ty']}:{entry['tm'] or entry['im']}"
            merged[key] = entry

    items = sorted(
        merged.values(),
        key=lambda entry: (
            -float(entry.get("sc") or 0),
            -float(entry.get("v") or 0),
            entry.get("t") or "",
        ),
    )[: args.limit]

    payload = {
        "generated_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "count": len(items),
        "items": items,
    }
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    size = OUTPUT.stat().st_size
    print(f"wrote {OUTPUT} ({len(items)} titles, {size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
