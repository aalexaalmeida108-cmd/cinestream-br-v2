#!/usr/bin/env python3
"""Mark which Pluto channels carry the Portuguese dub.

The Brazilian lineup mixes two kinds of channel:

  * the movie and anime channels ship the Brazilian asset set, so the audio
    track itself is the Portuguese dub;
  * the channels with more than one audio rendition only expose the original
    audio plus a Portuguese subtitle track.

The stitcher tells the two apart in the master playlist: a channel with an
`EXT-X-MEDIA` audio group has separate renditions, a channel without one has
the Portuguese audio muxed into the variant.

This script walks the baked Brazilian channel list, asks the stitcher for each
master playlist and writes the verdict back into the same file, so the site
can label the channel before anyone presses play.

Usage:
    python3 scripts/probe_pluto_audio.py
    python3 scripts/probe_pluto_audio.py --limit 20
"""

from __future__ import annotations

import argparse
import concurrent.futures as futures
import datetime as dt
import json
import pathlib
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
CHANNELS = ROOT / "data" / "pluto-channels.json"
PROXY = "https://cinestream-pluto-proxy.claudia-ingles.workers.dev"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
)
BOOT_QUERY = {
    "appName": "web",
    "appVersion": "5.14.0-0f5ca672f515a62078d2ec0ad2",
    "clientID": "33333333-3333-4333-8333-333333333333",
    "clientModelNumber": "1.0.0",
    "clientTime": "2026-11-10T00:00:00.000Z",
    "deviceMake": "chrome",
    "deviceModel": "web",
    "deviceType": "web",
    "deviceVersion": "131.0.0.0",
    "serverSideAds": "false",
}
MEDIA_LINE = re.compile(r"^#EXT-X-MEDIA:(.*)$", re.M)


def fetch(url: str, timeout: int = 30) -> str:
    request = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Referer": "https://pluto.tv/"}
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", "replace")


def boot_session() -> tuple[str, str, dict]:
    """Ask the boot service for a session token, the stitcher and its params."""
    url = f"{PROXY}/p/boot.pluto.tv/v4/start?" + urllib.parse.urlencode(BOOT_QUERY)
    data = json.loads(fetch(url))
    stitcher = str(data["servers"]["stitcher"]).rstrip("/")
    params = {}
    for part in str(data.get("stitcherParams") or "").split("&"):
        if "=" in part:
            key, value = part.split("=", 1)
            params[key] = value if value else "na"
    return str(data["sessionToken"]), stitcher, params


def master_url(channel_id: str, token: str, stitcher: str, params: dict) -> str:
    query = urllib.parse.urlencode(
        {"jwt": token, "masterJWTPassthrough": "true", "includeExtendedEvents": "true"}
    )
    host = stitcher.replace("https://", "")
    return (
        f"{PROXY}/p/{host}/v2/stitch/hls/channel/{channel_id}/master.m3u8"
        f"?{query}&{urllib.parse.urlencode(params)}"
    )


def classify(body: str) -> str:
    audio_lines = [line for line in MEDIA_LINE.findall(body) if "TYPE=AUDIO" in line]
    if not audio_lines:
        # No separate rendition: the Brazilian asset is muxed, audio included.
        return "dubbed"
    names = " ".join(re.findall(r'NAME="([^"]*)"', " ".join(audio_lines))).lower()
    if "portug" in names or "portugu" in names:
        return "dubbed"
    return "subtitled"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--channels", default=str(CHANNELS))
    args = parser.parse_args()

    path = pathlib.Path(args.channels)
    payload = json.loads(path.read_text(encoding="utf-8"))
    items = payload.get("items") or []
    if args.limit:
        items = items[: args.limit]

    token, stitcher, params = boot_session()

    def probe(channel: dict) -> tuple[str, str]:
        url = master_url(str(channel["_id"]), token, stitcher, params)
        try:
            return str(channel["_id"]), classify(fetch(url))
        except urllib.error.HTTPError as error:
            return str(channel["_id"]), f"error:{error.code}"
        except Exception:  # noqa: BLE001 - a channel we cannot read stays unknown
            return str(channel["_id"]), "unknown"

    results: dict[str, str] = {}
    with futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for channel_id, verdict in pool.map(probe, items):
            results[channel_id] = verdict

    counts: dict[str, int] = {}
    for channel in payload.get("items") or []:
        verdict = results.get(str(channel.get("_id")))
        if verdict:
            channel["audio"] = verdict
        counts[verdict or "unknown"] = counts.get(verdict or "unknown", 0) + 1

    payload["audio_checked_at"] = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"checked {len(results)} channels: {counts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
