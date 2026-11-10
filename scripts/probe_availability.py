#!/usr/bin/env python3
"""Probe which seasons of every series actually have a working source.

The embed players do not ship a per-title availability API, so the only honest
signal is the rendered page itself: when a season has at least one server, the
response carries one or more `"ref"` entries. Zero refs means the player will
open on a dead screen.

Output: data/availability.json
    {"generated_at": ..., "source": "vidsrc.buzz",
     "items": {"<tmdb id>": [2, 3, 4, ...]}}

Only seasons with a server are listed. A series absent from `items` was never
probed successfully (network failure), which the player treats as "unknown"
and ignores.

Usage:
    python3 scripts/probe_availability.py                # full catalog
    python3 scripts/probe_availability.py --limit 50     # smoke test
    python3 scripts/probe_availability.py --workers 3
"""

from __future__ import annotations

import argparse
import concurrent.futures as futures
import datetime as dt
import json
import pathlib
import sys
import time
import urllib.error
import threading
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
SERIES = ROOT / "data" / "series.json"
OUTPUT = ROOT / "data" / "availability.json"

SOURCE = "vidsrc.buzz"
EMBED = "https://vidsrc.buzz/embed/tv/{tmdb}/{season}/1"
REFERER = "https://cinestream-br-v2.github.io/"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
)


# The embed host punishes bursts, so every request passes a shared gate that
# keeps the whole process near a fixed rate regardless of worker count.
RATE_PER_SECOND = 2.0
_gate_lock = threading.Lock()
_next_slot = [0.0]


def _wait_for_slot() -> None:
    with _gate_lock:
        now = time.monotonic()
        slot = max(now, _next_slot[0])
        _next_slot[0] = slot + (1.0 / RATE_PER_SECOND)
        delay = slot - now
    if delay > 0:
        time.sleep(delay)


def fetch(url: str, timeout: int = 25) -> tuple[int, str]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Referer": REFERER})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, response.read(400_000).decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            if error.code == 429:
                time.sleep(5 * (attempt + 1))
                continue
            return error.code, ""
        except Exception:
            time.sleep(1.5 * (attempt + 1))
    return 0, ""


def season_has_server(tmdb: str, season: int) -> bool | None:
    _wait_for_slot()
    status, body = fetch(EMBED.format(tmdb=tmdb, season=season))
    if status != 200:
        return None
    return body.count('"ref"') > 0


def probe_series(item: dict) -> tuple[str, list[int] | None]:
    tmdb = str(item.get("tm") or "")
    if not tmdb:
        return tmdb, None
    total = int(item.get("s") or 0) or 1
    available: list[int] = []
    misses_after_hit = 0
    failures = 0

    for season in range(1, total + 1):
        result = season_has_server(tmdb, season)
        if result is None:
            failures += 1
            if failures >= 3:
                return tmdb, available or None
            continue
        failures = 0
        if result:
            available.append(season)
            misses_after_hit = 0
        elif available:
            # A gap after a hit still counts; only stop early when the tail is
            # clearly past the end of what the source carries.
            misses_after_hit += 1
            if misses_after_hit >= 6:
                break

    return tmdb, available or None


def main() -> int:
    global RATE_PER_SECOND

    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="probe only N series")
    parser.add_argument("--offset", type=int, default=0, help="start at this index in the catalog")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--merge", action="store_true", help="merge into the existing output instead of replacing it")
    parser.add_argument("--rate", type=float, default=RATE_PER_SECOND, help="requests per second across all workers")
    parser.add_argument("--output", default=str(OUTPUT))
    args = parser.parse_args()

    catalog = json.loads(SERIES.read_text(encoding="utf-8"))["items"]
    total_catalog = len(catalog)
    start = args.offset % total_catalog if total_catalog else 0
    RATE_PER_SECOND = max(0.2, args.rate)
    series = catalog[start:]
    if args.limit:
        series = series[: args.limit]

    total = len(series)
    items: dict[str, list[int]] = {}
    started = time.time()
    done = 0

    with futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        pending = {pool.submit(probe_series, item): item for item in series}
        for future in futures.as_completed(pending):
            tmdb, seasons = future.result()
            done += 1
            if tmdb and seasons:
                items[tmdb] = seasons
            if done % 50 == 0 or done == total:
                elapsed = time.time() - started
                rate = done / elapsed if elapsed else 0
                remaining = (total - done) / rate / 60 if rate else 0
                print(
                    f"{done}/{total} series  {len(items)} with sources  "
                    f"{rate:.1f}/s  ~{remaining:.0f} min left",
                    flush=True,
                )

    path = pathlib.Path(args.output)
    merged: dict[str, list[int]] = {}
    cursor = total_catalog
    if args.merge and path.exists():
        previous = json.loads(path.read_text(encoding="utf-8"))
        merged = {str(k): v for k, v in (previous.get("items") or {}).items()}
        merged.update(items)
        cursor = (start + total + 1) % total_catalog
    else:
        merged = items

    payload = {
        "generated_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "source": SOURCE,
        "probed": total,
        "count": len(merged),
        "cursor": cursor,
        "items": dict(sorted(merged.items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else 0)),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    size = path.stat().st_size
    print(f"wrote {path} ({size / 1024:.0f} KB, {len(merged)} titles, cursor {cursor})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
