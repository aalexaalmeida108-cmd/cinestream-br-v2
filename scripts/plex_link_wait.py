#!/usr/bin/env python3
"""Wait for a Plex pin to be authorized, then claim the local server.

The viewer authorizes a code at https://plex.tv/link. As soon as the account
approves it, the pin carries an auth token, which is what the Plex Media
Server needs to be claimed and to open the CineStream library.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

PIN_ID = sys.argv[1] if len(sys.argv) > 1 else ""
SERVER = "http://127.0.0.1:32400"
LIBRARY = "/home/alex/plex-library"
LIBRARY_NAME = "CineStream BR"
CLIENT_ID = "5154213f-d6e3-4ab9-b7fb-c6e890d5d971"
USER_AGENT = "Plex Web/4.140.0 (Chrome)"
SECRETS = pathlib.Path("/home/alex/.config/opencode/secrets")


def get(url: str, headers: dict | None = None) -> tuple[int, str]:
    request = urllib.request.Request(url)
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")


def plex_request(url: str, method: str = "GET", token: str = "", body: str = "") -> tuple[int, str]:
    headers = {
        "User-Agent": USER_AGENT,
        "X-Plex-Client-Identifier": CLIENT_ID,
        "X-Plex-Product": "Plex Web",
        "X-Plex-Token": token,
        "Content-Type": "application/json",
    }
    request = urllib.request.Request(url, method=method, data=body.encode() if body else None)
    for key, value in headers.items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")


def wait_for_token(pin_id: str, minutes: int = 20) -> str:
    deadline = time.time() + minutes * 60
    while time.time() < deadline:
        status, payload = get(
            f"https://plex.tv/api/v2/pins/{pin_id}",
            {"User-Agent": USER_AGENT, "X-Plex-Client-Identifier": CLIENT_ID, "Accept": "application/json"},
        )
        if status == 200:
            try:
                data = json.loads(payload)
            except Exception:
                data = {}
            token = data.get("authToken")
            if token:
                print(f"pin autorizado, token recebido ({token[:6]}...)", flush=True)
                return token
        print("aguardando a autorização no plex.tv/link...", flush=True)
        time.sleep(10)
    return ""


def claim(token: str) -> None:
    status, payload = get(f"{SERVER}/identity", {"Accept": "application/json"})
    identifier = json.loads(payload)["machineIdentifier"]
    status, payload = plex_request(
        f"{SERVER}/media/servers/{identifier}/claim", "PUT", token, "{}"
    )
    print(f"claim: HTTP {status}", flush=True)


def ensure_library(token: str) -> None:
    status, payload = plex_request(f"{SERVER}/library/sections", "GET", token)
    if status == 200:
        for section in json.loads(payload).get("MediaContainer", {}).get("Directory", []):
            if section.get("title") == LIBRARY_NAME:
                print(f"biblioteca presente: {section.get('key')}", flush=True)
                plex_request(f"{SERVER}/library/sections/{section.get('key')}/refresh", "GET", token)
                return
    body = json.dumps(
        {
            "name": LIBRARY_NAME,
            "type": "video",
            "agent": "tv.plex.agents.none",
            "locations": [{"path": LIBRARY}],
            "scanner": "Plex Media Scanner",
            "language": "pt-BR",
        }
    )
    status, payload = plex_request(f"{SERVER}/library/sections", "POST", token, body)
    print(f"biblioteca criada: HTTP {status} {payload[:160]}", flush=True)


def main() -> int:
    if not PIN_ID:
        print("informe o id do pin")
        return 1
    token = wait_for_token(PIN_ID)
    if not token:
        print("o pin expirou sem autorização")
        return 2
    path = SECRETS / "plex_token"
    path.write_text(token)
    path.chmod(0o600)
    claim(token)
    ensure_library(token)
    status, payload = get(f"{SERVER}/identity", {"Accept": "application/json"})
    print("servidor agora:", "claimed=1" if 'claimed="1"' in payload else payload[:200])
    return 0


if __name__ == "__main__":
    sys.exit(main())
