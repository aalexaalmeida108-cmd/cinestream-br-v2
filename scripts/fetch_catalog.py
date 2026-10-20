#!/usr/bin/env python3
"""Fetch the EmbedMovies catalog into static JSON files.

The public site exposes a JSON endpoint at /inc/Ajax.php. Catalog pages use a
POST request with a CSRF token from the page's meta tag, plus a browser-like
User-Agent, so keep the headers and token flow below.

Output:
    data/movies.json
    data/series.json
    data/animes.json
    data/index.json

Raw responses are cached under .cache/embedmovies/ so a rerun only downloads
pages that changed or are missing. Delete the cache to force a full refresh.
"""

import argparse
import json
import os
import random
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
CACHE_DIR = os.path.join(ROOT, ".cache", "embedmovies")

API_URL = "https://embedmovies.org/inc/Ajax.php"
REFERERS = {
    "movie": "https://embedmovies.org/filmes",
    "tv": "https://embedmovies.org/series",
    "anime": "https://embedmovies.org/animes",
}
OUTPUTS = {
    "movie": ("movies.json", "movie"),
    "tv": ("series.json", "series"),
    "anime": ("animes.json", "anime"),
}
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
)
CSRF_PATTERN = re.compile(
    r'<meta[^>]+(?:name=["\']csrf-token["\'][^>]+content=["\']([^"\']+)'
    r'|content=["\']([^"\']+)["\'][^>]+name=["\']csrf-token["\'])',
    re.IGNORECASE,
)

_thread_local = threading.local()
_print_lock = threading.Lock()
_rate_lock = threading.Lock()
_request_times = []
REQUESTS_PER_SECOND = 12


def log(message):
    with _print_lock:
        print(message, flush=True)


def get_session():
    session = getattr(_thread_local, "session", None)
    if session is None:
        session = requests.Session()
        session.headers.update(
            {
                "User-Agent": USER_AGENT,
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "X-Requested-With": "XMLHttpRequest",
                "Origin": "https://embedmovies.org",
            }
        )
        _thread_local.session = session
    return session


def throttle():
    """Keep requests below the endpoint's 20-per-second per-IP limit."""
    while True:
        with _rate_lock:
            now = time.monotonic()
            while _request_times and now - _request_times[0] >= 1.0:
                _request_times.pop(0)
            if len(_request_times) < REQUESTS_PER_SECOND:
                _request_times.append(now)
                return
            wait = 1.0 - (now - _request_times[0]) + 0.05
        time.sleep(max(0.05, wait))


def cache_path(kind, page):
    return os.path.join(CACHE_DIR, kind, "{:04d}.json".format(page))


def read_cache(kind, page):
    path = cache_path(kind, page)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if payload.get("success") and payload.get("results"):
            return payload
    except (OSError, ValueError):
        pass
    return None


def write_cache(kind, page, payload):
    directory = os.path.join(CACHE_DIR, kind)
    os.makedirs(directory, exist_ok=True)
    path = cache_path(kind, page)
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    os.replace(temporary, path)


def refresh_csrf(session, kind):
    """Load a catalog page and keep its CSRF token for API POSTs."""
    response = session.get(REFERERS[kind], timeout=35)
    response.raise_for_status()
    match = CSRF_PATTERN.search(response.text)
    token = (match.group(1) or match.group(2)) if match else ""
    session.csrf_token = token
    return token


def fetch_page(kind, page, retries=5, refresh=False):
    if not refresh:
        cached = read_cache(kind, page)
        if cached is not None:
            return page, cached

    last_error = None
    for attempt in range(1, retries + 1):
        session = get_session()
        try:
            token = getattr(session, "csrf_token", "") or refresh_csrf(
                session, kind)
            throttle()
            response = session.post(
                API_URL,
                data={"type": kind, "page": page, "csrf_token": token},
                headers={
                    "Referer": REFERERS[kind],
                    "X-CSRF-Token": token,
                },
                timeout=35,
            )
            if response.status_code == 429:
                raise RuntimeError("HTTP 429 rate limited")
            response.raise_for_status()
            payload = response.json()
            if not payload.get("success"):
                error = payload.get("error") or {}
                if error.get("code") == "RATE_LIMIT_EXCEEDED":
                    retry_after = (error.get("details") or {}).get(
                        "retry_after", 1)
                    time.sleep(float(retry_after) + random.uniform(0.1, 0.5))
                    raise RuntimeError("rate limited")
                raise RuntimeError("API returned success=false: {}".format(error))
            results = payload.get("results") or []
            if not results and page <= int(payload.get("total_pages") or 1):
                raise RuntimeError("API returned an empty page")
            write_cache(kind, page, payload)
            return page, payload
        except Exception as error:  # noqa: BLE001 - network boundary
            session.csrf_token = ""
            last_error = error
            if attempt == retries:
                break
            delay = min(30, (2 ** attempt) + random.uniform(0, 1.5))
            log("  retry {}/{} {} page {} in {:.1f}s: {}".format(
                attempt, retries - 1, kind, page, delay, error))
            time.sleep(delay)

    log("  SKIP {} page {} after {} attempts: {}".format(
        kind, page, retries, last_error))
    return page, None


def trim_overview(text, limit=220):
    if not text:
        return ""
    text = " ".join(str(text).split())
    if len(text) <= limit:
        return text
    cut = text[: limit + 1]
    if " " in cut:
        cut = cut.rsplit(" ", 1)[0]
    return cut.rstrip(" ,.;:-") + "..."


def normalize(item, label):
    title = item.get("title") or {}
    if isinstance(title, str):
        title = {"en": title}
    elif not isinstance(title, dict):
        title = {}

    excerpt = item.get("excerpt") or {}
    if not isinstance(excerpt, dict):
        excerpt = {}

    images = item.get("images") or {}
    if not isinstance(images, dict):
        images = {}

    release = item.get("release_date") or ""
    if not isinstance(release, str):
        release = ""

    english = title.get("en") or ""
    portuguese = title.get("pt") or ""
    display = english or portuguese

    overview = trim_overview(excerpt.get("en") or excerpt.get("pt") or "")

    normalized = {
        "i": item.get("id"),
        "t": display,
        "y": int(release[:4]) if release[:4].isdigit() else None,
        "r": item.get("vote_average") or None,
        "v": item.get("vote_count") or None,
        "p": images.get("poster") or None,
        "b": images.get("backdrop") or None,
        "tm": item.get("tmdb_id") or None,
        "im": item.get("imdb_id") or None,
        "ty": label,
        "s": item.get("season_count") or None,
        "rt": item.get("runtime") or None,
        "o": overview or None,
    }

    if portuguese and portuguese != display:
        normalized["tp"] = portuguese

    if item.get("is_anime"):
        normalized["a"] = True

    if not normalized["i"] or not normalized["t"]:
        return None

    return {key: value for key, value in normalized.items()
            if value not in (None, "", 0, False)}


def fetch_kind(kind, workers, refresh, max_pages=None):
    log("Fetching {} pages...".format(kind))
    _, first = fetch_page(kind, 1, refresh=refresh)
    total_pages = int(first.get("total_pages") or 1)
    total_results = int(first.get("total_results") or 0)
    if max_pages:
        total_pages = min(total_pages, max_pages)

    log("  {}: {} pages / {} titles".format(kind, total_pages, total_results))

    payloads = {1: first}
    pages = list(range(2, total_pages + 1))
    if pages:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(fetch_page, kind, page, 5, refresh): page
                for page in pages
            }
            done = 1
            for future in as_completed(futures):
                page, payload = future.result()
                payloads[page] = payload
                done += 1
                if done % 25 == 0 or done == total_pages:
                    log("  {}: {}/{} pages".format(kind, done, total_pages))

    items = []
    seen = set()
    skipped = [page for page, payload in payloads.items() if payload is None]
    for page in sorted(payloads):
        payload = payloads[page]
        if payload is None:
            continue
        for item in payload.get("results") or []:
            if not isinstance(item, dict) or item.get("is_adult"):
                continue
            normalized = normalize(item, OUTPUTS[kind][1])
            if normalized is None or normalized["i"] in seen:
                continue
            seen.add(normalized["i"])
            items.append(normalized)

    if skipped:
        log("  {}: skipped pages {}".format(kind, sorted(skipped)))
    return items, total_pages


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workers", type=int, default=6,
                        help="concurrent requests (default 6)")
    parser.add_argument("--refresh", action="store_true",
                        help="ignore the raw page cache")
    parser.add_argument("--max-pages", type=int, default=None,
                        help="debug: stop after N pages per category")
    parser.add_argument("--only", choices=sorted(OUTPUTS), default=None,
                        help="debug: fetch a single category")
    args = parser.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)
    kinds = [args.only] if args.only else ["movie", "tv", "anime"]
    catalog = {}

    for kind in kinds:
        items, pages = fetch_kind(kind, max(1, args.workers), args.refresh,
                                  args.max_pages)
        catalog[kind] = items
        log("  {}: {} unique titles from {} pages".format(
            kind, len(items), pages))

    if "anime" in catalog and "tv" in catalog:
        anime_ids = {item["i"] for item in catalog["anime"]}
        before = len(catalog["tv"])
        catalog["tv"] = [item for item in catalog["tv"]
                         if not item.get("a") and item["i"] not in anime_ids]
        removed = before - len(catalog["tv"])
        if removed:
            log("  tv: removed {} anime duplicates".format(removed))

    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    manifest = {"generated_at": generated_at, "categories": {}}

    for kind in kinds:
        items = catalog[kind]
        items.sort(key=lambda item: (-(item.get("v") or 0),
                                     -(item.get("r") or 0),
                                     -(item.get("y") or 0),
                                     item.get("t", "").lower()))
        filename, label = OUTPUTS[kind]
        path = os.path.join(DATA_DIR, filename)
        temporary = path + ".tmp"
        payload = {
            "generated_at": generated_at,
            "category": label,
            "count": len(items),
            "items": items,
        }
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        os.replace(temporary, path)
        size_mb = os.path.getsize(path) / (1024 * 1024)
        manifest["categories"][label] = {
            "file": filename,
            "count": len(items),
            "bytes": os.path.getsize(path),
        }
        log("Wrote {} ({} items, {:.1f} MB)".format(filename, len(items), size_mb))

    if not args.only:
        index_path = os.path.join(DATA_DIR, "index.json")
        with open(index_path + ".tmp", "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, ensure_ascii=False, indent=2)
        os.replace(index_path + ".tmp", index_path)
        log("Wrote index.json")

    return 0


if __name__ == "__main__":
    sys.exit(main())
