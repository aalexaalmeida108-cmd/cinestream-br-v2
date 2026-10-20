#!/usr/bin/env python3
"""Build per-season episode counts for every series and anime in the catalog.

The player links to WatchPlay with TMDB identifiers
(`/tvshow/{tmdb}/{season}/{episode}`), so the TMDB season layout is the
reference for "how many episodes does this season have". The public season
listing page exposes that count per season, which is what this script reads.

Output:
    data/episodes.json

Raw pages are cached under .cache/tmdb/seasons/ so a rerun only downloads
pages that are missing. Titles already present in data/episodes.json are
skipped unless --refresh is passed, which keeps the weekly workflow small.

Usage:
    python3 scripts/fetch_episodes.py
    python3 scripts/fetch_episodes.py --refresh --workers 6
"""

import argparse
import os
import re
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
CACHE_DIR = os.path.join(ROOT, ".cache", "tmdb", "seasons")
SEASONS_URL = "https://www.themoviedb.org/tv/{tmdb}/seasons?language=en-US"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
SEASON_BLOCK = re.compile(r'<div class="season_wrapper">(.*?)(?=<div class="season_wrapper">|$)',
                           re.S)
SEASON_NUMBER = re.compile(r'/season/(\d+)')
EPISODE_COUNT = re.compile(r'([0-9]+)\s+Episodes?\b', re.I)

_print_lock = threading.Lock()
_rate_lock = threading.Lock()
_request_times = []
REQUESTS_PER_SECOND = 5
MAX_EPISODES = 999


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


def cache_path(tmdb):
    return os.path.join(CACHE_DIR, "{}.html".format(tmdb))


def read_cache(tmdb):
    path = cache_path(tmdb)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return None


def write_cache(tmdb, html):
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = cache_path(tmdb)
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        handle.write(html)
    os.replace(temporary, path)


def fetch_page(tmdb, retries=6):
    url = SEASONS_URL.format(tmdb=tmdb)
    last_error = None
    for attempt in range(1, retries + 1):
        throttle()
        try:
            completed = subprocess.run(
                [
                    "curl", "-sS", "-L", "--compressed", "--max-time", "40",
                    "-A", USER_AGENT,
                    "-H", "Accept-Language: en-US,en;q=0.9",
                    "-H", "Accept: text/html,application/xhtml+xml",
                    "-w", "\n%{http_code}",
                    url,
                ],
                capture_output=True, text=True, timeout=60,
            )
        except subprocess.TimeoutExpired:
            last_error = "timeout"
            time.sleep(1.5 * attempt)
            continue

        body, _, code = completed.stdout.rpartition("\n")
        code = code.strip()
        if code == "200" and body:
            return body
        last_error = "HTTP {}".format(code or "unknown")
        if code == "404":
            break
        if code == "429":
            # The season pages are rate limited; back off and try again.
            time.sleep(min(120, 20.0 * attempt))
            continue
        time.sleep(1.5 * attempt)
    raise RuntimeError(last_error or "request failed")


def parse_counts(html):
    """Return {season: episode_count} for regular seasons (season 0 ignored)."""
    counts = {}
    for block in SEASON_BLOCK.findall(html):
        number = SEASON_NUMBER.search(block)
        episodes = EPISODE_COUNT.search(block)
        if not number or not episodes:
            continue
        season = int(number.group(1))
        total = int(episodes.group(1))
        if season < 1 or total < 1 or total > MAX_EPISODES:
            continue
        counts[season] = total
    return counts


def fetch_counts(tmdb, cache_only=False):
    html = read_cache(tmdb)
    if html is None:
        if cache_only:
            raise RuntimeError("not cached")
        html = fetch_page(tmdb)
        write_cache(tmdb, html)
    return parse_counts(html)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workers", type=int, default=4,
                        help="concurrent downloads (default 4)")
    parser.add_argument("--refresh", action="store_true",
                        help="refetch titles already present in the output")
    parser.add_argument("--limit", type=int, default=None,
                        help="debug: process at most N titles")
    parser.add_argument("--cache-only", action="store_true",
                        help="only use cached pages, never download")
    args = parser.parse_args()

    titles = load_catalog()
    if not titles:
        sys.exit("No series or anime found in data/")

    existing = read_counts(TMDB_COUNTS)
    if not existing:
        # A fresh checkout has no local cache; seed from the published file
        # so a routine run only fetches titles that are actually new.
        existing = read_published_counts()

    todo = {}
    for tmdb, title in titles.items():
        if tmdb not in existing:
            todo[tmdb] = title
            continue
        # A title that gained seasons needs fresh counts.
        known = len(existing[tmdb]) if isinstance(existing[tmdb], dict) else 0
        if title.get("seasons", 0) > known:
            todo[tmdb] = title
    if args.limit:
        todo = dict(list(todo.items())[:args.limit])

    log("Catalog titles: {}; already known: {}; to fetch: {}".format(
        len(titles), len(titles) - len(todo), len(todo)))

    results = {}
    failures = {}
    if todo:
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
            futures = {executor.submit(fetch_counts, tmdb, args.cache_only): tmdb
                       for tmdb in todo}
            done = 0
            for future in as_completed(futures):
                tmdb = futures[future]
                done += 1
                try:
                    counts = future.result()
                except Exception as error:  # noqa: BLE001 - network boundary
                    failures[tmdb] = str(error)
                    counts = None
                if counts:
                    results[tmdb] = counts
                if done % 100 == 0 or done == len(todo):
                    log("  {}/{} titles".format(done, len(todo)))

    items = dict(existing)
    items.update(results)
    write_counts(TMDB_COUNTS, items)

    payload = build_output(items, read_counts(PLAYER_COUNTS))
    total_seasons = sum(len(value) for value in payload["items"].values())
    log("Wrote data/episodes.json: {} titles / {} seasons / {:.0f} KB".format(
        len(payload["items"]), total_seasons,
        os.path.getsize(os.path.join(ROOT, "data", "episodes.json")) / 1024))
    if failures:
        log("{} titles failed: {}".format(len(failures), sorted(failures)[:10]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
