#!/usr/bin/env python3
"""Fill missing genre bits from IMDb's public title.basics dataset.

Bingebang's capped genre feeds leave part of the catalog untagged. IMDb ids
are already present on most catalog items, so this pass joins them to IMDb's
genres and only fills entries that have no bits yet. It never overwrites a
Bingebang match.

Usage:
    python3 scripts/enrich_imdb_genres.py
"""

import csv
import gzip
import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timezone

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
CACHE_DIR = os.path.join(ROOT, ".cache", "imdb")
DATASET = os.path.join(CACHE_DIR, "title.basics.tsv.gz")
DATASET_URL = "https://datasets.imdbws.com/title.basics.tsv.gz"
GENRES_FILE = os.path.join(DATA_DIR, "genres.json")

GENRE_BITS = {
    "action": 1,
    "adventure": 2,
    "horror": 4,
    "comedy": 8,
    "drama": 16,
}


def log(message):
    print(message, flush=True)


def download_dataset():
    if os.path.exists(DATASET) and os.path.getsize(DATASET) > 200_000_000:
        log("Using cached IMDb dataset ({:.0f} MB)".format(
            os.path.getsize(DATASET) / 1_000_000))
        return

    os.makedirs(CACHE_DIR, exist_ok=True)
    temporary = DATASET + ".tmp"
    log("Downloading IMDb title.basics...")
    with requests.get(DATASET_URL, stream=True, timeout=120) as response:
        response.raise_for_status()
        total = int(response.headers.get("content-length") or 0)
        written = 0
        with open(temporary, "wb") as handle:
            for chunk in response.iter_content(chunk_size=1 << 20):
                if not chunk:
                    continue
                handle.write(chunk)
                written += len(chunk)
                if total and written % (32 << 20) < (1 << 20):
                    log("  {:.0f}/{:.0f} MB".format(
                        written / 1_000_000, total / 1_000_000))
    os.replace(temporary, DATASET)
    log("Downloaded {:.0f} MB".format(os.path.getsize(DATASET) / 1_000_000))


def load_catalog():
    catalog = []
    by_imdb = {}
    for filename in ("movies.json", "series.json", "animes.json"):
        path = os.path.join(DATA_DIR, filename)
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        for item in payload.get("items") or []:
            catalog.append(item)
            imdb = item.get("im")
            if imdb:
                by_imdb.setdefault(imdb, []).append(item)
    return catalog, by_imdb


def normalize_title(value):
    text = unicodedata.normalize("NFD", str(value or ""))
    text = "".join(char for char in text if unicodedata.category(char) != "Mn")
    text = text.lower().replace("&", " and ")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return " ".join(text.split())


def imdb_bits(genres):
    bits = 0
    for genre in genres:
        bits |= GENRE_BITS.get(genre.strip().lower(), 0)
    return bits


def wanted_titles(catalog, tagged):
    wanted = {}
    for item in catalog:
        if str(item["i"]) in tagged:
            continue
        year = int(item.get("y") or 0)
        if not year:
            continue
        titles = {normalize_title(item.get("t")), normalize_title(item.get("tp"))}
        titles.discard("")
        for title in titles:
            for candidate_year in (year - 1, year, year + 1):
                wanted.setdefault((title, candidate_year), []).append(item)
    return wanted


def title_type_allowed(item, title_type):
    if item.get("ty") == "movie":
        return title_type in {"movie", "tvMovie"}
    return title_type in {"tvSeries", "tvMiniSeries"}


def runtime_matches(item, runtime):
    if item.get("ty") != "movie" or not runtime:
        return True
    expected = int(item.get("rt") or 0)
    return not expected or abs(expected - runtime) <= 8


def scan_dataset(wanted_ids, wanted_title_keys):
    found_ids = {}
    found_titles = {}
    seen_ids = set()
    wanted_years = {year for _, year in wanted_title_keys}
    rows = 0
    with gzip.open(DATASET, "rt", encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle, delimiter="\t", quoting=csv.QUOTE_NONE)
        next(reader, None)
        for row in reader:
            rows += 1
            if len(row) < 9:
                continue
            imdb = row[0]
            if imdb in wanted_ids:
                seen_ids.add(imdb)
                bits = imdb_bits(row[8].split(","))
                if bits:
                    found_ids[imdb] = bits

            title_type = row[1]
            if title_type not in {"movie", "tvMovie", "tvSeries", "tvMiniSeries"}:
                continue
            if not row[5].isdigit() or int(row[5]) not in wanted_years:
                continue
            bits = imdb_bits(row[8].split(","))
            if not bits:
                continue
            runtime = int(row[7]) if row[7].isdigit() else 0
            year = int(row[5])
            for raw_title in {row[2], row[3]}:
                entries = wanted_title_keys.get((normalize_title(raw_title), year))
                if not entries:
                    continue
                for item in entries:
                    if not title_type_allowed(item, title_type):
                        continue
                    if not runtime_matches(item, runtime):
                        continue
                    key = str(item["i"])
                    found_titles[key] = found_titles.get(key, 0) | bits
    log("Scanned {} rows; {} of {} catalog IMDb ids; {} title matches".format(
        rows, len(seen_ids), len(wanted_ids), len(found_titles)))
    return found_ids, found_titles


def main():
    if not os.path.exists(GENRES_FILE):
        sys.exit("Run scripts/enrich_genres.py first")
    download_dataset()

    catalog, by_imdb = load_catalog()
    with open(GENRES_FILE, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    items = payload.setdefault("items", {})

    wanted = {item["im"] for item in catalog
              if item.get("im") and str(item["i"]) not in items}
    title_keys = wanted_titles(catalog, items)
    found_ids, found_titles = scan_dataset(wanted, title_keys)

    id_filled = 0
    for imdb, bits in found_ids.items():
        for item in by_imdb[imdb]:
            key = str(item["i"])
            if key not in items:
                items[key] = bits
                id_filled += 1

    title_filled = 0
    for key, bits in found_titles.items():
        if key not in items:
            items[key] = bits
            title_filled += 1

    filled = id_filled + title_filled
    if not filled:
        log("No new IMDb tags; leaving genres.json unchanged")
        return

    payload["count"] = len(items)
    payload["source"] = "bingebang.st + imdb"
    payload["imdb_filled"] = filled
    payload["imdb_id_filled"] = id_filled
    payload["imdb_title_filled"] = title_filled
    payload["imdb_generated_at"] = datetime.now(timezone.utc).isoformat(
        timespec="seconds")

    temporary = GENRES_FILE + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    os.replace(temporary, GENRES_FILE)
    log("Added {} IMDb tags ({} by id, {} by title); {} total".format(
        filled, id_filled, title_filled, len(items)))


if __name__ == "__main__":
    main()
