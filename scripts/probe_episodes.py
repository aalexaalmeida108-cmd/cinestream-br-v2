#!/usr/bin/env python3
"""Verify per-season episode counts against the player itself.

TMDB season listings are close but not always exact: some anime carry an
extra episode on the player that TMDB does not list. Since the player
defines which episodes actually exist, this script probes it and keeps the
answer it gets.

Strategy per title:
  1. Probe episode 1 of every known season. A 404 means the title or that
     season is not hosted, so there is nothing to measure.
  2. For a hosted season, binary search for the last existing episode.
  3. Also probe the season after the last known one, to catch seasons the
     catalog does not list yet.

Results are cached in .cache/watchplay/counts.json, so a rerun only measures
what is still missing.

Usage:
    python3 scripts/probe_episodes.py
    python3 scripts/probe_episodes.py --workers 8 --limit 50
"""

import argparse
import os
import random
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from episode_data import (  # noqa: E402
    PLAYER_COUNTS,
    TMDB_COUNTS,
    build_output,
    load_catalog,
    read_counts,
    read_published_counts,
    write_counts,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLAYER_URL = "https://v2.watchplay.shop/tvshow/{tmdb}/{season}/{episode}"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
MAX_EPISODES = 999

_print_lock = threading.Lock()
_rate_lock = threading.Lock()
_request_times = []
REQUESTS_PER_SECOND = 6


def log(message):
    with _print_lock:
        print(message, flush=True)


def throttle():
    while True:
        with _rate_lock:
            now = time.monotonic()
            while _request_times and now - _request_times[0] >= 1.0:
                _request_times.pop(0)
            if len(_request_times) < REQUESTS_PER_SECOND:
                _request_times.append(now)
                return
            wait = 1.0 - (now - _request_times[0]) + 0.02
        time.sleep(max(0.02, wait))


def exists(tmdb, season, episode):
    """True when the player serves that episode.

    Returns None when the answer could not be established (rate limit,
    network error), so a transient failure never turns into a wrong count.
    """
    url = PLAYER_URL.format(tmdb=tmdb, season=season, episode=episode)
    for attempt in range(4):
        throttle()
        try:
            completed = subprocess.run(
                [
                    "curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}",
                    "-A", USER_AGENT, "--max-time", "30", "-I", url,
                ],
                capture_output=True, text=True, timeout=45,
            )
        except subprocess.TimeoutExpired:
            time.sleep(1.5 * (attempt + 1))
            continue
        code = completed.stdout.strip()
        if code == "200":
            return True
        if code == "404":
            return False
        time.sleep(2.0 * (attempt + 1))
    return None


def last_episode(tmdb, season, hint):
    """Find the highest episode the player serves for a season.

    ``hint`` is the TMDB count. The common case is that the hint is exact,
    which costs two requests: the hint itself and the one after it.
    Returns None when the boundary could not be established.
    """
    if hint and hint >= 1:
        known = exists(tmdb, season, hint)
        if known is None:
            return None
        if known:
            following = exists(tmdb, season, hint + 1)
            if following is None:
                return None
            if not following:
                return hint
            low, high = hint + 1, MAX_EPISODES
            while low < high:
                middle = (low + high + 1) // 2
                probe = exists(tmdb, season, middle)
                if probe is None:
                    return None
                if probe:
                    low = middle
                else:
                    high = middle - 1
            return low
        # The hinted episode is missing, so the season is shorter.
        first = exists(tmdb, season, 1)
        if first is None:
            return None
        if not first:
            return 0
        low, high = 1, hint - 1
        while low < high:
            middle = (low + high + 1) // 2
            probe = exists(tmdb, season, middle)
            if probe is None:
                return None
            if probe:
                low = middle
            else:
                high = middle - 1
        return low

    first = exists(tmdb, season, 1)
    if first is None:
        return None
    if not first:
        return 0

    low, high = 1, MAX_EPISODES
    while low < high:
        middle = (low + high + 1) // 2
        probe = exists(tmdb, season, middle)
        if probe is None:
            return None
        if probe:
            low = middle
        else:
            high = middle - 1
    return low


def measure(tmdb, seasons, hints):
    """Return {season: last_episode} for every season the player serves.

    A season the player does not have is recorded as zero, so a stale
    catalog count cannot offer an episode that does not exist. Seasons past
    the last known one are discovered as long as the player keeps serving
    them. An empty map means the player does not host the title at all.

    When a request cannot be answered the title is left unmeasured, so a
    later run can retry it.
    """
    hosted = exists(tmdb, 1, 1)
    if hosted is None:
        return None
    if not hosted:
        return {}

    counts = {}
    for season in seasons:
        if season < 1 or season > 200:
            continue
        total = last_episode(tmdb, season, hints.get(season, 0))
        if total is None:
            return None
        counts[season] = total

    # Discover seasons the catalog does not know about yet.
    highest = max(seasons) if seasons else 1
    season = highest + 1
    while season <= 200:
        total = last_episode(tmdb, season, 0)
        if total is None:
            return None
        if not total:
            break
        counts[season] = total
        season += 1

    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workers", type=int, default=6,
                        help="concurrent probes (default 6)")
    parser.add_argument("--limit", type=int, default=None,
                        help="debug: measure at most N titles")
    parser.add_argument("--refresh", action="store_true",
                        help="remeasure titles already in the cache")
    parser.add_argument("--merge-only", action="store_true",
                        help="only rebuild data/episodes.json from the caches")
    args = parser.parse_args()

    titles = load_catalog()
    if not titles:
        sys.exit("No series or anime found in data/")

    tmdb_counts = read_counts(TMDB_COUNTS)
    if not tmdb_counts:
        # A fresh checkout has no local cache; seed from the published file.
        tmdb_counts = read_published_counts()
    existing = read_counts(PLAYER_COUNTS)

    todo = {}
    for tmdb, title in titles.items():
        if args.merge_only:
            break
        hint = tmdb_counts.get(tmdb) or {}
        if not args.refresh and tmdb in existing:
            # A title that gained seasons needs a fresh measurement.
            known = len([value for value in existing[tmdb].values() if value])
            if title.get("seasons", 0) <= known:
                continue
        seasons = sorted(int(key) for key, value in hint.items() if value)
        if not seasons:
            seasons = [1]
        # Probe one season past the known list to catch missing seasons.
        todo[tmdb] = (list(range(1, max(seasons) + 2)),
                       {int(key): int(value) for key, value in hint.items()})

    if args.limit:
        items = list(todo.items())
        random.shuffle(items)
        todo = dict(items[:args.limit])

    log("Titles to measure: {} (cache holds {})".format(
        len(todo), len(existing)))

    results = {}
    failures = 0
    if todo:
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
            futures = {executor.submit(measure, tmdb, seasons, hints): tmdb
                       for tmdb, (seasons, hints) in todo.items()}
            done = 0
            for future in as_completed(futures):
                tmdb = futures[future]
                done += 1
                try:
                    counts = future.result()
                except Exception as error:  # noqa: BLE001 - network boundary
                    log("  {} failed: {}".format(tmdb, error))
                    counts = None
                if counts is None:
                    # Transient failure: leave this title for a later run.
                    failures += 1
                else:
                    # An empty map means the player does not host the title.
                    results[tmdb] = counts
                if done % 25 == 0 or done == len(todo):
                    log("  {}/{} titles".format(done, len(todo)))
                    # Save as we go, so a long run is never lost.
                    merged = dict(existing)
                    merged.update(results)
                    write_counts(PLAYER_COUNTS, merged)

    items = dict(existing)
    items.update(results)
    write_counts(PLAYER_COUNTS, items)

    payload = build_output(tmdb_counts, items)
    total_seasons = sum(len(value) for value in payload["items"].values())
    log("Wrote data/episodes.json: {} titles / {} seasons / {:.0f} KB".format(
        len(payload["items"]), total_seasons,
        os.path.getsize(os.path.join(ROOT, "data", "episodes.json")) / 1024))
    if failures:
        log("{} titles could not be measured; rerun to retry them".format(failures))
    return 0


if __name__ == "__main__":
    sys.exit(main())
