#!/usr/bin/env python3
"""Capture Pluto channels into files a Plex Media Server can index.

Plex plays files, not web embeds, so the Brazilian channels reach the TV
through a Plex Media Server running on this machine. Each channel is pulled
from the Pluto stitcher with ffmpeg and written as a growing MPEG-TS file,
which Plex indexes as a video item and plays with the Portuguese audio the
Brazilian asset already carries.

A capture that dies is restarted with a fresh session token, because the token
that opens the master playlist expires after a few hours.

Usage:
    python3 scripts/plex_capture.py --channels 6
    python3 scripts/plex_capture.py --channels 2 --names "Pluto TV Novelas,Bob Esponja"
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
CHANNELS = ROOT / "data" / "pluto-channels.json"
LIBRARY = pathlib.Path(os.environ.get("PLEX_LIBRARY", "/home/alex/plex-library"))
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

_sessions: dict[str, dict] = {}
_session_lock = threading.Lock()


def fetch(url: str, timeout: int = 30) -> str:
    request = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Referer": "https://pluto.tv/"}
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", "replace")


def session(key: str) -> dict:
    """A stitcher session: token, stitcher host and the parameters it wants.

    Every capture gets its own session. The stitcher limits how many streams
    one session may hold open, so sharing it made parallel captures die.
    """
    with _session_lock:
        current = _sessions.get(key)
        if current and current["expires"] > time.time() + 120:
            return current
        query = dict(BOOT_QUERY)
        seed = key.replace("-", "")[:12]
        query["clientID"] = f"{seed[:8]}-0000-4000-8000-000000000000"
        query["deviceId"] = f"{seed[:8]}-1111-4111-8111-111111111111"
        query["sid"] = f"{seed[:8]}-2222-4222-8222-222222222222"
        url = PROXY + "/p/boot.pluto.tv/v4/start?" + urllib.parse.urlencode(query)
        data = json.loads(fetch(url))
        params = {}
        for part in str(data.get("stitcherParams") or "").split("&"):
            if "=" not in part:
                continue
            key, value = part.split("=", 1)
            params[key] = value if value else "na"
        _sessions[key] = {
            "token": data["sessionToken"],
            "stitcher": str(data["servers"]["stitcher"]).rstrip("/"),
            "params": params,
            "expires": time.time() + 60 * 60,
        }
        return _sessions[key]


def master_url(channel_id: str) -> str:
    current = session(channel_id)
    query = urllib.parse.urlencode(
        {
            "jwt": current["token"],
            "masterJWTPassthrough": "true",
            "includeExtendedEvents": "true",
        }
    )
    extra = urllib.parse.urlencode(current["params"])
    host = current["stitcher"].replace("https://", "")
    return f"{PROXY}/p/{host}/v2/stitch/hls/channel/{channel_id}/master.m3u8?{query}&{extra}"


def safe_name(title: str) -> str:
    name = re.sub(r"[^\w\s.-]", "", title).strip().replace(" ", "_")
    return name[:80] or "canal"


def capture(channel: dict, stop: threading.Event) -> None:
    target = LIBRARY / f"{safe_name(channel['name'])}.ts"
    while not stop.is_set():
        try:
            url = master_url(channel["_id"])
        except Exception as error:  # noqa: BLE001 - keep the channel alive
            print(f"{channel['name']}: sessão falhou ({error})", flush=True)
            time.sleep(10)
            continue

        command = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
            "-i", url,
            "-c", "copy", "-f", "mpegts", "-y", str(target),
        ]
        print(f"{channel['name']}: capturando", flush=True)
        try:
            subprocess.run(command, check=False)
        except Exception as error:  # noqa: BLE001
            print(f"{channel['name']}: {error}", flush=True)
        if stop.is_set():
            break
        print(f"{channel['name']}: captura caiu, retomando", flush=True)
        time.sleep(5)


def main() -> int:
    global LIBRARY

    parser = argparse.ArgumentParser()
    parser.add_argument("--channels", type=int, default=6)
    parser.add_argument("--names", default="")
    parser.add_argument("--library", default=str(LIBRARY))
    args = parser.parse_args()

    LIBRARY = pathlib.Path(args.library)
    LIBRARY.mkdir(parents=True, exist_ok=True)

    payload = json.loads(CHANNELS.read_text(encoding="utf-8"))
    items = payload.get("items") or []

    if args.names:
        wanted = [name.strip() for name in args.names.split(",") if name.strip()]
        items = [item for item in items if item["name"] in wanted]
    else:
        # The channels that carry the Portuguese dub come first.
        items = [item for item in items if item.get("audio") == "dubbed"]

    items = items[: args.channels]
    if not items:
        print("nenhum canal selecionado")
        return 1

    stop = threading.Event()

    def handle(*_args):
        stop.set()

    signal.signal(signal.SIGINT, handle)
    signal.signal(signal.SIGTERM, handle)

    workers = []
    for channel in items:
        thread = threading.Thread(target=capture, args=(channel, stop), daemon=True)
        thread.start()
        workers.append(thread)

    while not stop.is_set():
        time.sleep(2)

    for thread in workers:
        thread.join(timeout=5)
    return 0


if __name__ == "__main__":
    sys.exit(main())
