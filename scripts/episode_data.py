#!/usr/bin/env python3
"""Shared helpers for the per-season episode count data.

Two sources feed data/episodes.json:

* TMDB season listings (scripts/fetch_episodes.py) - fast, one page per title.
* The player itself (scripts/probe_episodes.py) - authoritative, but costs
  several requests per season.

The player wins wherever it answered, because the player defines which
episodes actually exist. TMDB fills the gaps for titles the player does not
host.

Files:
    .cache/tmdb/counts.json       TMDB counts per title (local cache)
    data/episode_counts.json      counts measured on the player (committed)
    data/episodes.json            merged output used by the watch page
"""

import json
import os
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
CACHE_DIR = os.path.join(ROOT, ".cache")
TMDB_COUNTS = os.path.join(CACHE_DIR, "tmdb", "counts.json")
PLAYER_COUNTS = os.path.join(DATA_DIR, "episode_counts.json")
OUTPUT = os.path.join(DATA_DIR, "episodes.json")
MAX_EPISODES = 999


def load_catalog():
    """Return {tmdb_id: {title, type, seasons}} for series and anime."""
    titles = {}
    for filename, kind in (("series.json", "series"), ("animes.json", "anime")):
        path = os.path.join(DATA_DIR, filename)
        if not os.path.exists(path):
            continue
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        for item in payload.get("items") or []:
            tmdb = str(item.get("tm") or "").strip()
            if not tmdb.isdigit():
                continue
            titles.setdefault(tmdb, {
                "title": item.get("t") or "",
                "type": kind,
                "seasons": int(item.get("s") or 0),
            })
    return titles


def read_counts(path):
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError):
        return {}
    return payload.get("items") or {}


def write_counts(path, items):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    payload = {
        "generated_at": datetime.now(timezone.utc).replace(
            microsecond=0).isoformat(),
        "count": len(items),
        "items": items,
    }
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    os.replace(temporary, path)


def read_published_counts():
    """Read the counts already published in data/episodes.json.

    The published file stores dense lists, so it is expanded back into
    {season: count} maps here.
    """
    payload = read_counts(OUTPUT)
    expanded = {}
    for tmdb, counts in payload.items():
        if not isinstance(counts, list):
            continue
        seasons = {}
        for index, total in enumerate(counts):
            if total:
                seasons[str(index + 1)] = int(total)
        if seasons:
            expanded[tmdb] = seasons
    return expanded


def compact(counts):
    """Store counts as a dense list indexed by season - 1.

    Season keys may arrive as strings (JSON object keys) or integers.
    """
    if not counts:
        return []
    normalized = {}
    for key, value in counts.items():
        try:
            season = int(key)
            total = int(value)
        except (TypeError, ValueError):
            continue
        if season < 1 or total < 1:
            continue
        normalized[season] = total
    if not normalized:
        return []
    highest = max(normalized)
    return [normalized.get(season, 0) for season in range(1, highest + 1)]


def build_output(tmdb_counts, player_counts):
    """Merge both sources into the player-facing data/episodes.json.

    Seasons are unioned, so a source that only knows part of a title does
    not erase what the other one found. Where both know a season, the player
    wins: it defines which episodes actually exist. A player count of zero
    means the player does not serve that season at all.
    """
    merged = {}
    for tmdb, counts in tmdb_counts.items():
        merged[tmdb] = {int(key): int(value)
                         for key, value in counts.items()
                         if str(value).isdigit() and int(value) > 0}

    for tmdb, counts in player_counts.items():
        if not counts:
            # The player does not host this title; keep the TMDB counts.
            continue
        seasons = merged.setdefault(tmdb, {})
        for key, value in counts.items():
            seasons[int(key)] = max(0, int(value))

    payload = {
        "generated_at": datetime.now(timezone.utc).replace(
            microsecond=0).isoformat(),
        "source": "themoviedb.org season listings + watchplay probes",
        "count": len(merged),
        "items": {tmdb: compact(counts) for tmdb, counts in merged.items()},
    }
    os.makedirs(DATA_DIR, exist_ok=True)
    temporary = OUTPUT + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    os.replace(temporary, OUTPUT)
    return payload
