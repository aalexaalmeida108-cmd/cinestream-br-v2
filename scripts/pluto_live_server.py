#!/usr/bin/env python3
"""Serve Pluto live channels as HLS to the local Plex server.

Plex has no way to play a web embed, but it does play HLS playlists. This
server boots Pluto directly (the machine sits in Brazil, so the stitcher
hands back the Brazilian asset with the Portuguese dub), keeps one session
per channel, and rewrites every playlist URI to point back at itself. The
JWT that the stitcher demands expires after a few hours, so every playlist
served carries the session's current token, and a 401/403 upstream triggers
a fresh boot before the request is retried.

Each channel is a separate session on purpose: the stitcher caps how many
streams one session may hold open, and sharing a session made parallel
captures die.

Usage:
    python3 scripts/pluto_live_server.py --port 8098
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parent.parent
CHANNELS = ROOT / "data" / "pluto-channels.json"
LIBRARY = pathlib.Path(os.environ.get("PLEX_LIBRARY", "/home/alex/plex-library"))
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
)
BOOT_QUERY = {
    "appName": "web",
    "appVersion": "5.14.0-0f5ca672f515a62078d2ec0ad2",
    "clientModelNumber": "1.0.0",
    "clientTime": "2026-11-10T00:00:00.000Z",
    "deviceMake": "chrome",
    "deviceModel": "web",
    "deviceType": "web",
    "deviceVersion": "131.0.0.0",
    "serverSideAds": "false",
}
SESSION_TTL = 45 * 60
MAX_SEGMENT_BYTES = 32 * 1024 * 1024

_sessions: dict[str, dict] = {}
_locks: dict[str, threading.Lock] = {}
_registry = threading.Lock()


def channel_lock(channel_id: str) -> threading.Lock:
    with _registry:
        return _locks.setdefault(channel_id, threading.Lock())


def fetch(url: str, timeout: int = 30, extra_headers: dict | None = None) -> tuple[int, dict, bytes]:
    headers = {"User-Agent": USER_AGENT, "Referer": "https://pluto.tv/"}
    headers.update(extra_headers or {})
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, dict(response.headers), response.read(MAX_SEGMENT_BYTES)
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers or {}), error.read(8192)
    except Exception:  # noqa: BLE001 - a dead upstream is a 502, not a crash
        return 0, {}, b""


def boot(channel_id: str) -> dict:
    """Open (or reopen) the stitcher session for one channel."""
    seed = re.sub(r"[^a-f0-9]", "", channel_id.lower())[:12].ljust(12, "0")
    query = dict(BOOT_QUERY)
    query["clientID"] = f"{seed[:8]}-0000-4000-8000-000000000000"
    query["deviceId"] = f"{seed[:8]}-1111-4111-8111-111111111111"
    query["sid"] = f"{seed[:8]}-2222-4222-8222-222222222222"
    url = "https://boot.pluto.tv/v4/start?" + urllib.parse.urlencode(query)
    status, _headers, body = fetch(url, timeout=25)
    if status != 200:
        raise RuntimeError(f"boot HTTP {status}")
    data = json.loads(body.decode("utf-8", "replace"))
    token = data.get("sessionToken")
    stitcher = str((data.get("servers") or {}).get("stitcher") or "").rstrip("/")
    if not token or not stitcher:
        raise RuntimeError("boot sem sessionToken/stitcher")
    params = {}
    for part in str(data.get("stitcherParams") or "").split("&"):
        if "=" in part:
            key, value = part.split("=", 1)
            params[key] = value or "na"
    session = {
        "token": token,
        "stitcher": stitcher,
        "params": params,
        "sid": query["sid"],
        "expires": time.time() + SESSION_TTL,
    }
    _sessions[channel_id] = session
    return session


def session(channel_id: str, force: bool = False) -> dict:
    with channel_lock(channel_id):
        current = _sessions.get(channel_id)
        if not force and current and current["expires"] > time.time() + 120:
            return current
        return boot(channel_id)


def fresh_url(channel_id: str, url: str, current: dict) -> str:
    """Replace the token/session in an upstream URI with the live ones."""
    url = re.sub(r"jwt=[^&]*", "jwt=" + urllib.parse.quote(current["token"], safe=""), url)
    url = re.sub(r"sid=[^&]*", "sid=" + urllib.parse.quote(current["sid"], safe=""), url)
    return url


def master_url(channel_id: str, current: dict) -> str:
    query = urllib.parse.urlencode(
        {"jwt": current["token"], "masterJWTPassthrough": "true", "includeExtendedEvents": "true"}
    )
    extra = urllib.parse.urlencode(current["params"])
    return (
        f"{current['stitcher']}/v2/stitch/hls/channel/{channel_id}/master.m3u8"
        f"?{query}&{extra}"
    )


def rewrite_playlist(channel_id: str, text: str, base: str, current: dict) -> str:
    out = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            out.append(line)
            continue
        if stripped.startswith("#"):
            # subtitles and alternate renditions hide their URI in an attribute
            if 'URI="' in stripped:
                def swap(match: re.Match) -> str:
                    target = urllib.parse.urljoin(base, match.group(1))
                    target = fresh_url(channel_id, target, current)
                    return 'URI="/live/%s/p?u=%s"' % (
                        channel_id,
                        urllib.parse.quote(target, safe=""),
                    )

                out.append(re.sub(r'URI="([^"]+)"', swap, stripped))
            else:
                out.append(line)
            continue
        target = urllib.parse.urljoin(base, stripped)
        target = fresh_url(channel_id, target, current)
        out.append(
            "/live/%s/p?u=%s" % (channel_id, urllib.parse.quote(target, safe=""))
        )
    return "\n".join(out) + "\n"


def content_type(path: str) -> str:
    if path.endswith(".m3u8"):
        return "application/vnd.apple.mpegurl"
    if path.endswith(".ts") or path.endswith(".m4s"):
        return "video/mp2t"
    if path.endswith(".vtt"):
        return "text/vtt"
    if path.endswith(".aac") or path.endswith(".mp4"):
        return "audio/mp4"
    return "application/octet-stream"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "CineStreamLive/1.0"

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 - quieter log
        print("%s %s" % (time.strftime("%H:%M:%S"), fmt % args), flush=True)

    def send_bytes(self, status: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        self.do_GET()

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        parsed = urllib.parse.urlparse(self.path)
        parts = parsed.path.strip("/").split("/")
        if len(parts) < 3 or parts[0] != "live":
            self.send_bytes(404, b"not found", "text/plain")
            return
        channel_id, action = parts[1], parts[2]

        try:
            if action == "master.m3u8":
                current = session(channel_id)
                status, _h, body = fetch(master_url(channel_id, current), timeout=25)
                if status != 200:
                    current = session(channel_id, force=True)
                    status, _h, body = fetch(master_url(channel_id, current), timeout=25)
                if status != 200:
                    self.send_bytes(502, b"upstream refused the master", "text/plain")
                    return
                text = rewrite_playlist(
                    channel_id, body.decode("utf-8", "replace"),
                    master_url(channel_id, current), current,
                )
                self.send_bytes(200, text.encode(), "application/vnd.apple.mpegurl")
                return

            if action == "p":
                query = urllib.parse.parse_qs(parsed.query)
                target = (query.get("u") or [""])[0]
                if not target.startswith("http"):
                    self.send_bytes(400, b"missing upstream", "text/plain")
                    return
                current = session(channel_id)
                target = fresh_url(channel_id, target, current)
                extra = {}
                if self.headers.get("Range"):
                    extra["Range"] = self.headers["Range"]
                status, headers, body = fetch(target, timeout=35, extra_headers=extra)
                if status in (401, 403):
                    current = session(channel_id, force=True)
                    target = fresh_url(channel_id, target, current)
                    status, headers, body = fetch(target, timeout=35, extra_headers=extra)
                if status not in (200, 206):
                    self.send_bytes(502, b"upstream refused the segment", "text/plain")
                    return
                path = urllib.parse.urlparse(target).path
                ctype = headers.get("Content-Type") or content_type(path)
                extra_out = {}
                if headers.get("Content-Range"):
                    extra_out["Content-Range"] = headers["Content-Range"]
                self.send_bytes(status, body, ctype, extra_out)
                return
        except Exception as error:  # noqa: BLE001 - keep serving other channels
            print(f"{channel_id}: {type(error).__name__}: {error}", flush=True)
            self.send_bytes(502, str(error).encode(), "text/plain")
            return

        self.send_bytes(404, b"not found", "text/plain")


def write_strm(channel_id: str, name: str, port: int) -> pathlib.Path:
    folder = LIBRARY / "Canais ao Vivo"
    folder.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^\w\s.-]", "", name).strip() or "canal"
    path = folder / f"{safe[:70]}.strm"
    path.write_text(f"http://127.0.0.1:{port}/live/{channel_id}/master.m3u8\n", encoding="utf-8")
    return path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8098)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--strm", type=int, default=0, help="generate .strm files for N dubbed channels")
    args = parser.parse_args()

    if args.strm:
        payload = json.loads(CHANNELS.read_text(encoding="utf-8"))
        dubbed = [c for c in payload.get("items") or [] if c.get("audio") == "dubbed"]
        made = 0
        for channel in dubbed[: args.strm]:
            write_strm(channel["_id"], channel["name"], args.port)
            made += 1
        print(f"{made} arquivos .strm em {LIBRARY / 'Canais ao Vivo'}", flush=True)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    print(f"servindo HLS do Pluto em http://{args.host}:{args.port}/live/<canal>/master.m3u8", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
