#!/usr/bin/env python3
"""Fetch the Brazilian Pluto TV channel list.

The channel service answers with the lineup of the requester's country, so a
runner outside Brazil gets the English catalogue. This script keeps the
Brazilian one in `data/pluto-channels.json`, which the site serves from its
own origin: the channel ids are what the stitcher needs, and the Brazilian
asset set is what carries the Portuguese dub.

The script refuses to write a catalogue that does not look Brazilian, so a
runner with a foreign IP cannot overwrite the good file.

Usage:
    python3 scripts/fetch_pluto_br.py
    python3 scripts/fetch_pluto_br.py --output data/pluto-channels.json
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = ROOT / "data" / "pluto-channels.json"

CHANNEL_SERVICE = "https://service-channels.clusters.pluto.tv"
FALLBACK_API = "https://api.pluto.tv"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
)
# Channels that only exist in the Brazilian lineup. Their absence means the
# response came from a foreign edge.
BR_MARKERS = {
    "Pluto TV Novelas",
    "TV Cultura",
    "Jovem Pan NEWS",
    "Euronews Português",
    "MasterChef Brasil",
    "Pluto TV Record News",
    "TikTok Radio Brasil",
}


def fetch(url: str) -> list:
    request = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Referer": "https://pluto.tv/"}
    )
    with urllib.request.urlopen(request, timeout=40) as response:
        return json.loads(response.read().decode("utf-8", "replace"))


def looks_brazilian(channels: list) -> bool:
    names = {str(channel.get("name") or "") for channel in channels}
    return len(names & BR_MARKERS) >= 3


def slim(channel: dict) -> dict:
    """Keep only what the site renders: id, name, art and the stream entry."""
    stitched = channel.get("stitched") or {}
    urls = stitched.get("urls") or []
    hls = next((entry for entry in urls if entry.get("type") == "hls" and entry.get("url")), None)
    return {
        "_id": channel.get("_id"),
        "slug": channel.get("slug") or channel.get("_id"),
        "name": channel.get("name") or channel.get("slug") or "Canal",
        "number": channel.get("number") or 0,
        "category": channel.get("category") or "",
        "summary": channel.get("summary") or "",
        "colorLogoPNG": channel.get("colorLogoPNG") or {},
        "featuredImage": channel.get("featuredImage") or {},
        "tile": channel.get("tile") or {},
        "stitched": {"urls": [hls] if hls else []},
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    args = parser.parse_args()

    sources = [
        f"{CHANNEL_SERVICE}/v2/channels?country=BR",
        f"{FALLBACK_API}/v2/channels",
    ]

    channels: list = []
    for url in sources:
        try:
            channels = fetch(url)
        except Exception as error:  # noqa: BLE001 - report and try the next one
            print(f"{url} failed: {error}", file=sys.stderr)
            continue
        if channels and looks_brazilian(channels):
            break
        print(f"{url} returned a foreign catalogue ({len(channels)} channels), trying the next one")
        channels = []

    if not channels:
        print("no channel list could be fetched", file=sys.stderr)
        return 1
    if not looks_brazilian(channels):
        print(
            "refusing to write: this looks like a foreign catalogue. Run the script "
            "from a Brazilian IP, or keep the existing file.",
            file=sys.stderr,
        )
        return 2

    items = [slim(channel) for channel in channels if channel.get("_id")]
    items.sort(key=lambda item: item["name"].lower())

    payload = {
        "generated_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "region": "BR",
        "language": "pt-BR",
        "count": len(items),
        "items": items,
    }
    path = pathlib.Path(args.output)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {path} ({len(items)} Brazilian channels)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
