#!/usr/bin/env python3
"""Claim the local Plex Media Server and open the CineStream library.

The server runs on this machine, so the TV's Plex app sees it as a normal
server on the network. Claiming needs an account token: either sign in with the
Plex credentials, or pass an existing token.

Usage:
    python3 scripts/plex_claim.py --login EMAIL
    python3 scripts/plex_claim.py --token X-Plex-Token
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
import urllib.error
import urllib.request

SERVER = "http://127.0.0.1:32400"
LIBRARY = "/home/alex/plex-library"
LIBRARY_NAME = "CineStream BR"
CLIENT_ID = "5154213f-d6e3-4ab9-b7fb-c6e890d5d971"
USER_AGENT = "Plex Web/4.140.0 (Chrome)"

SIGNIN = "https://plex.tv/api/v2/users/signin"


def request(url: str, method: str = "GET", headers: dict | None = None, body: str = "") -> tuple[int, str]:
    req = urllib.request.Request(url, method=method, data=body.encode() if body else None)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")


def signin(login: str, password: str) -> str:
    headers = {
        "User-Agent": USER_AGENT,
        "X-Plex-Client-Identifier": CLIENT_ID,
        "X-Plex-Product": "Plex Web",
        "X-Plex-Version": "4.140.0",
        "X-Plex-Platform": "Chrome",
        "X-Plex-Device": "Desktop",
        "X-Plex-Device-Name": "CineStream",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    body = f"login={login}&password={password}&rememberMe=1"
    status, payload = request(SIGNIN, "POST", headers, body)
    if status >= 400:
        raise SystemExit(f"signin falhou: HTTP {status} {payload[:200]}")
    import re

    match = re.search(r'authToken="([^"]+)"', payload) or re.search(r'"authToken":"([^"]+)"', payload)
    if not match:
        raise SystemExit("signin não devolveu token")
    return match.group(1)


def machine_identifier() -> str:
    status, payload = request(f"{SERVER}/identity", headers={"Accept": "application/json"})
    if status != 200:
        raise SystemExit(f"identity falhou: HTTP {status}")
    try:
        return json.loads(payload)["machineIdentifier"]
    except Exception:
        import re

        match = re.search(r'machineIdentifier[=\":\s]+"?([0-9a-fA-F-]{20,})', payload)
        if not match:
            raise SystemExit("machineIdentifier não encontrado")
        return match.group(1)


def claim(token: str) -> None:
    """Claim the server the way the current Plex Web app does it.

    The old PUT /media/servers/<id>/claim is gone in Plex 1.43. The app asks
    the server for a one time claim token and then hands it to plex.tv.
    """
    headers = {
        "User-Agent": USER_AGENT,
        "X-Plex-Client-Identifier": CLIENT_ID,
        "X-Plex-Product": "Plex Web",
        "X-Plex-Token": token,
    }
    status, payload = request(f"{SERVER}/api/claim/token", "GET", headers)
    if status != 200:
        raise SystemExit(f"claim token falhou: HTTP {status} {payload[:200]}")
    import re

    match = re.search(r"<token>([^<]+)</token>", payload) or re.search(r'"token":"([^"]+)"', payload)
    if not match:
        raise SystemExit("claim token nao veio na resposta")
    claim_token = match.group(1)

    status, payload = request(f"{SERVER}/myplex/claim?token={claim_token}", "POST", headers)
    print(f"claim: HTTP {status} {payload[:160]}")
    if status >= 400:
        raise SystemExit("o servidor recusou o claim")


def ensure_library(token: str) -> None:
    headers = {
        "User-Agent": USER_AGENT,
        "X-Plex-Client-Identifier": CLIENT_ID,
        "X-Plex-Token": token,
        "Content-Type": "application/json",
    }
    status, payload = request(f"{SERVER}/library/sections", "GET", headers)
    if status == 200:
        for section in json.loads(payload).get("MediaContainer", {}).get("Directory", []):
            if section.get("title") == LIBRARY_NAME:
                print(f"biblioteca já existe: {section.get('key')}")
                refresh(token, section.get("key"))
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
    status, payload = request(f"{SERVER}/library/sections", "POST", headers, body)
    print(f"criação da biblioteca: HTTP {status} {payload[:200]}")
    if status >= 400:
        raise SystemExit("não foi possível criar a biblioteca")


def refresh(token: str, key: str | None = None) -> None:
    headers = {
        "User-Agent": USER_AGENT,
        "X-Plex-Client-Identifier": CLIENT_ID,
        "X-Plex-Token": token,
    }
    if key:
        request(f"{SERVER}/library/sections/{key}/refresh", "GET", headers)
        print(f"varredura disparada na seção {key}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--login", default="")
    parser.add_argument("--password", default="")
    parser.add_argument("--token", default="")
    args = parser.parse_args()

    token = args.token
    if not token:
        if not args.login or not args.password:
            raise SystemExit("informe --login e --password, ou --token")
        token = signin(args.login, args.password)
        print("token obtido")

    claim(token)
    ensure_library(token)
    return 0


if __name__ == "__main__":
    sys.exit(main())
