#!/usr/bin/env python3
"""Add the five catalog genres to the EmbedMovies titles.

EmbedMovies does not expose genres. Bingebang's public JSON API does, but its
numeric ids are not TMDB ids, so the only reliable join is title + year. This
script crawls the genre feeds that matter (action, adventure, horror, comedy,
drama), indexes their titles, matches the local catalog, and writes a compact
bitmask map to data/genres.json.

Usage:
    python3 scripts/enrich_genres.py                # crawl + match
    python3 scripts/enrich_genres.py --skip-crawl   # reuse cached feeds
    python3 scripts/enrich_genres.py --search       # opt-in, heavily rate limited

The bitmask in data/genres.json is keyed by the EmbedMovies item id:
    1 = action, 2 = adventure, 4 = horror, 8 = comedy, 16 = drama
"""

import argparse
import hashlib
import json
import os
import re
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.parse import quote

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
CACHE_DIR = os.path.join(ROOT, ".cache", "bingebang")
API_URL = "https://bingebang.st/api"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
)

BITS = {
    "acao": 1,
    "aventura": 2,
    "terror": 4,
    "comedia": 8,
    "drama": 16,
}
MOVIE_FEEDS = [28, 12, 27, 35, 18]
TV_FEEDS = [10759, 35, 18]  # Bingebang has no TV titles for genre 27.
MAX_PAGE = 500  # The API serves page 500 for every page above this.
WORKERS = 4
REQUESTS_PER_SECOND = 8.0

_thread_local = threading.local()
rate_lock = threading.Lock()
request_times = []


def log(message):
    print(message, flush=True)


def throttle():
    while True:
        with rate_lock:
            now = time.monotonic()
            while request_times and now - request_times[0] > 1.0:
                request_times.pop(0)
            if len(request_times) < REQUESTS_PER_SECOND:
                request_times.append(now)
                return
            wait = 1.0 - (now - request_times[0])
        time.sleep(max(0.01, wait))


def get_session():
    session = getattr(_thread_local, "session", None)
    if session is None:
        session = requests.Session()
        session.headers.update(
            {
                "User-Agent": USER_AGENT,
                "Accept": "application/json, text/javascript, */*; q=0.01",
            }
        )
        _thread_local.session = session
    return session


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def write_json(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    os.replace(temporary, path)


def feed_cache(media_type, genre_id, page):
    return os.path.join(
        CACHE_DIR, media_type, "genre-{}".format(genre_id),
        "page-{:04d}.json".format(page),
    )


def search_cache(query):
    digest = hashlib.sha1(query.encode("utf-8")).hexdigest()
    return os.path.join(CACHE_DIR, "search", digest + ".json")


def fetch_json(url, cache_path, retries=5):
    cached = read_json(cache_path)
    if cached is not None:
        return cached

    last_error = None
    for attempt in range(1, retries + 1):
        try:
            throttle()
            response = get_session().get(url, timeout=30)
            if response.status_code == 429:
                retry_after = response.headers.get("Retry-After")
                wait = float(retry_after) if retry_after else 10.0
                if wait > 120:
                    raise RuntimeError(
                        "rate limited for {}s".format(int(wait)))
                time.sleep(wait + 1)
                raise RuntimeError("HTTP 429 rate limited")
            response.raise_for_status()
            payload = response.json()
            write_json(cache_path, payload)
            return payload
        except Exception as error:  # noqa: BLE001 - network boundary
            last_error = error
            if attempt == retries:
                break
            time.sleep(min(20, (2 ** attempt) + 0.5))

    raise RuntimeError("failed to fetch {}: {}".format(url, last_error))


def crawl_feed(media_type, genre_id):
    first = fetch_json(
        "{}/discover/{}?genres={}&page=1".format(API_URL, media_type, genre_id),
        feed_cache(media_type, genre_id, 1),
    )
    total_pages = min(int(first.get("total_pages") or 0), MAX_PAGE)
    if total_pages <= 1:
        return total_pages

    def fetch(page):
        fetch_json(
            "{}/discover/{}?genres={}&page={}".format(
                API_URL, media_type, genre_id, page),
            feed_cache(media_type, genre_id, page),
        )
        return page

    with ThreadPoolExecutor(max_workers=WORKERS) as executor:
        for page in executor.map(fetch, range(2, total_pages + 1)):
            if page % 100 == 0:
                log("  {} genre {} page {}/{}".format(
                    media_type, genre_id, page, total_pages))
    return total_pages


def crawl_all():
    total = 0
    for media_type, feeds in (("movie", MOVIE_FEEDS), ("tv", TV_FEEDS)):
        for genre_id in feeds:
            log("Crawling {} genre {}...".format(media_type, genre_id))
            pages = crawl_feed(media_type, genre_id)
            total += pages
            log("  {} pages".format(pages))
    log("Crawled {} feed pages".format(total))


def normalize(text):
    text = unicodedata.normalize("NFKD", str(text or ""))
    text = text.encode("ascii", "ignore").decode("ascii").lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def item_year(item):
    year = item.get("year")
    if year:
        try:
            return int(year)
        except (TypeError, ValueError):
            pass
    for field in ("release_date", "first_air_date"):
        value = item.get(field)
        if isinstance(value, str) and len(value) >= 4:
            try:
                return int(value[:4])
            except ValueError:
                pass
    return 0


def item_title(item, media_type):
    if media_type == "movie":
        return item.get("title"), item.get("original_title")
    return item.get("name"), item.get("original_name")


def load_index():
    """Collect unique feed items and index them by (title, year)."""
    seen = {}
    for media_type, feeds in (("movie", MOVIE_FEEDS), ("tv", TV_FEEDS)):
        for genre_id in feeds:
            page = 1
            while page <= MAX_PAGE:
                payload = read_json(feed_cache(media_type, genre_id, page))
                if not payload:
                    break
                results = payload.get("results") or []
                for item in results:
                    item_id = item.get("id")
                    if item_id is None:
                        continue
                    key = (media_type, item_id)
                    genres = set(item.get("genre_ids") or [])
                    current = seen.get(key)
                    if current is None:
                        title, original = item_title(item, media_type)
                        seen[key] = {
                            "media_type": media_type,
                            "title": title,
                            "original": original,
                            "year": item_year(item),
                            "runtime": item.get("runtime"),
                            "vote": item.get("vote_count") or 0,
                            "genres": genres,
                        }
                    else:
                        current["genres"].update(genres)
                if not results or page >= int(payload.get("total_pages") or 0):
                    break
                page += 1

    index = {}
    for item in seen.values():
        for title in (item["title"], item["original"]):
            normalized = normalize(title)
            if not normalized or not item["year"]:
                continue
            index.setdefault(
                (item["media_type"], normalized, item["year"]), []
            ).append(item)
    log("Indexed {} unique titles".format(len(seen)))
    return index


def genre_bits(genre_ids):
    bits = 0
    if 28 in genre_ids:
        bits |= BITS["acao"]
    if 12 in genre_ids:
        bits |= BITS["aventura"]
    if 27 in genre_ids:
        bits |= BITS["terror"]
    if 35 in genre_ids:
        bits |= BITS["comedia"]
    if 18 in genre_ids:
        bits |= BITS["drama"]
    if 10759 in genre_ids:  # TMDB's combined TV action & adventure genre.
        bits |= BITS["acao"] | BITS["aventura"]
    return bits


def choose(candidates, item):
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0]

    runtime = item.get("rt")

    def score(candidate):
        distance = 1000
        if runtime and candidate.get("runtime"):
            distance = abs(int(runtime) - int(candidate["runtime"]))
        return (distance, -int(candidate.get("vote") or 0))

    return min(candidates, key=score)


def match_catalog(index):
    output = {}
    stats = {
        "movies": {"total": 0, "matched": 0, "tagged": 0},
        "series": {"total": 0, "matched": 0, "tagged": 0},
        "animes": {"total": 0, "matched": 0, "tagged": 0},
    }
    unmatched = []

    for path, key, media_type in (
        ("movies.json", "movies", "movie"),
        ("series.json", "series", "tv"),
        ("animes.json", "animes", "tv"),
    ):
        payload = read_json(os.path.join(DATA_DIR, path)) or {}
        for item in payload.get("items") or []:
            stats[key]["total"] += 1
            candidates = []
            for title in (item.get("t"), item.get("tp")):
                normalized = normalize(title)
                if not normalized:
                    continue
                for year in (item.get("y"), (item.get("y") or 0) - 1,
                             (item.get("y") or 0) + 1):
                    candidates.extend(index.get((media_type, normalized, year), []))
            candidate = choose(candidates, item)
            if not candidate:
                unmatched.append((key, item))
                continue
            stats[key]["matched"] += 1
            bits = genre_bits(candidate["genres"])
            if bits:
                output[str(item["i"])] = bits
                stats[key]["tagged"] += 1

    return output, stats, unmatched


def search_missing(unmatched):
    """Fill titles that the capped genre feeds did not contain."""

    def search(entry):
        key, item = entry
        media_type = "movie" if key == "movies" else "tv"
        for title in (item.get("t"), item.get("tp")):
            normalized = normalize(title)
            if len(normalized) < 2:
                continue
            payload = fetch_json(
                "{}/search/multi?query={}".format(API_URL, quote(title)),
                search_cache(normalized),
            )
            candidates = []
            for result in payload.get("results") or []:
                if result.get("media_type") != media_type:
                    continue
                result_title, result_original = item_title(result, media_type)
                if normalize(result_title) != normalized and \
                        normalize(result_original) != normalized:
                    continue
                year = item_year(result)
                if year and item.get("y") and abs(year - int(item["y"])) > 1:
                    continue
                candidates.append(result)
            candidate = choose(candidates, item)
            if candidate and genre_bits(set(candidate.get("genre_ids") or [])):
                return item["i"], genre_bits(set(candidate.get("genre_ids") or []))
        return None

    found = {}
    with ThreadPoolExecutor(max_workers=WORKERS) as executor:
        for result in executor.map(search, unmatched):
            if result:
                found[str(result[0])] = result[1]
    return found


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-crawl", action="store_true",
                        help="reuse cached feed pages")
    parser.add_argument("--search", action="store_true",
                        help="query search/multi for missing titles (rate limited)")
    args = parser.parse_args()

    if not args.skip_crawl:
        crawl_all()

    index = load_index()
    output, stats, unmatched = match_catalog(index)

    if args.search and unmatched:
        log("Searching {} unmatched titles...".format(len(unmatched)))
        extra = search_missing(unmatched)
        output.update(extra)
        log("  search added {} tags".format(len(extra)))

    for key, values in stats.items():
        log("{:<7} total {:>6}  matched {:>6}  tagged {:>6}".format(
            key, values["total"], values["matched"], values["tagged"]))

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "bingebang.st/api",
        "bits": BITS,
        "count": len(output),
        "items": output,
    }
    path = os.path.join(DATA_DIR, "genres.json")
    write_json(path, payload)
    log("Wrote {} tags to {}".format(len(output), path))


if __name__ == "__main__":
    main()
