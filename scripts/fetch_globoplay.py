#!/usr/bin/env python3
"""fetch_globoplay.py - lineup oficial de canais ao vivo da Globoplay.

Le a lineup direto do site oficial (globoplay.globo.com): a pagina
server-side renderiza o store Apollo com a query `broadcasts`, entao nao
precisa de login nem de API key. Depois consulta o endpoint publico de
informacoes de cada canal (security.video.globo.com/videos/<id>/info, que
responde CORS: *) para saber se o canal e gratis, se exige assinatura e se
esta disponivel na regiao.

Escreve data/globoplay-channels.json:

    {
      "generated_at": "2026-11-12 00:40",
      "source": "globoplay.globo.com (store Apollo) + security.video.globo.com",
      "channels": [
        {"mediaId": "11134179", "name": "ge tv", "slug": "ge-tv",
         "logo": "...", "category": "Esportes", "free": true,
         "lock": false, "drm": false, "available_in_location": true,
         "url": "https://globoplay.globo.com/ge-tv/ao-vivo/11134179/"}
      ]
    }

Uso: python3 scripts/fetch_globoplay.py
"""

import datetime
import json
import os
import re
import sys
import urllib.parse
import urllib.request

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(BASE_DIR, "data", "globoplay-channels.json")

# Paginas oficiais: qualquer canal ao vivo aparece em /<slug>/ao-vivo/<id>/.
SEEDS = [
    ("tv-globo", "6120663"),
    ("ge-tv", "11134179"),
    ("futura", "7420604"),
    ("sportv", "7339108"),
    ("sportv-2", "7339117"),
    ("premiere", "8223631"),
    ("combate", "8310612"),
    ("globonews", "7339101"),
    ("multishow", "7339131"),
    ("gnt", "7339128"),
    ("globoplay-novelas", "7339091"),
    ("gloob", "7339146"),
    ("gloobinho", "7339323"),
    ("megapix", "7339152"),
    ("universal", "7339279"),
    ("studio-universal", "7339326"),
    ("usa", "7339224"),
    ("canal-brasil", "7339060"),
    ("canal-off", "7339078"),
    ("bis", "7339140"),
    ("modo-viagem", "7339135"),
    ("receitas-fast", "11134191"),
    ("malhacao-fast", "12136724"),
    ("dpa-fast", "12136726"),
    ("telecine-premium", "10221110"),
    ("telecine-action", "10221184"),
    ("telecine-touch", "10221239"),
    ("telecine-fun", "10223522"),
    ("telecine-pipoca", "10221225"),
    ("telecine-cult", "10221109"),
    ("cbn-sp", "9182156"),
    ("cbn-rj", "9182126"),
]

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def log(msg):
    sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), msg))
    sys.stderr.flush()


import time  # noqa: E402  (log usa time)


def fetch(url, data=None, headers=None, timeout=30):
    req = urllib.request.Request(url, data=data, headers={
        "User-Agent": UA,
        "Accept": "*/*",
        "Accept-Language": "pt-BR,pt;q=0.9",
        "Origin": "https://globoplay.globo.com",
        "Referer": "https://globoplay.globo.com/",
    })
    if headers:
        for key, value in headers.items():
            req.add_header(key, value)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def store_from_page(slug, media_id):
    """Extrai os registros Broadcast e Video do store Apollo da pagina."""
    html = fetch("https://globoplay.globo.com/%s/ao-vivo/%s/" % (slug, media_id))
    text = html.decode("utf-8", "replace").replace("\\u002F", "/")
    index = text.find('apolloState:')
    if index < 0:
        return None
    start = text.find("{", index)
    depth = 0
    in_str = False
    esc = False
    end = None
    for pos in range(start, len(text)):
        ch = text[pos]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = pos + 1
                break
    if end is None:
        return None
    try:
        state = json.loads(text[start:end])
    except ValueError:
        return None
    broadcast = None
    video = None
    for key, rec in state.items():
        if key.startswith("Broadcast:"):
            try:
                ident = json.loads(key.split(":", 1)[1])
            except ValueError:
                continue
            if str(ident.get("mediaId")) == str(media_id):
                broadcast = rec
        elif key.startswith("Video:"):
            if str(rec.get("id")) == str(media_id):
                video = rec
    if broadcast is None and video is None:
        return None
    return {"broadcast": broadcast or {}, "video": video or {}}


def channel_info(media_id):
    """Estado do canal no endpoint publico de video."""
    try:
        raw = fetch("https://security.video.globo.com/videos/%s/info" % media_id,
                    data=b"", headers={"Content-Type": "application/x-www-form-urlencoded"})
        return json.loads(raw.decode("utf-8", "replace"))
    except Exception as exc:  # noqa: BLE001
        log("info %s falhou: %s" % (media_id, exc))
        return {}


def main():
    channels = []
    seen = set()
    for slug, media_id in SEEDS:
        if media_id in seen:
            continue
        seen.add(media_id)
        store = store_from_page(slug, media_id) or {}
        record = store.get("broadcast") or {}
        video = store.get("video") or {}
        info = channel_info(media_id)
        name = record.get("name") or info.get("title") or slug
        logo = record.get("logo") or ""
        category = info.get("category") or "Globoplay"
        # O tier vem do store: availableFor=LOGGED_IN e conta Globo
        # gratis; SUBSCRIBER exige assinatura. O lock do /info so
        # reflete o estado da chamada anonima.
        tier = video.get("availableFor") or ""
        free = tier == "LOGGED_IN"
        entry = {
            "mediaId": media_id,
            "name": name,
            "slug": slug,
            "logo": logo,
            "category": category,
            "free": free,
            "tier": tier or ("SUBSCRIBER" if info.get("lock") else "LOGGED_IN"),
            "lock": bool(info.get("lock")),
            "drm": bool(info.get("drm")),
            "available_in_location": info.get("available_in_location", True),
            "signal": info.get("signal") or "",
            "url": "https://globoplay.globo.com/%s/ao-vivo/%s/" % (slug, media_id),
        }
        channels.append(entry)
        log("%-20s %-10s %-12s %s" % (slug, media_id, entry["tier"],
                                      "gratis" if entry["free"] else "assinatura"))
        time.sleep(0.4)

    payload = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M"),
        "source": "globoplay.globo.com (store Apollo) + security.video.globo.com",
        "note": ("O sinal ao vivo so abre com sessao da Conta Globo. "
                 "Canais 'gratis' pedem conta free; os demais pedem "
                 "assinatura (Premiere, sportv, telecine...)."),
        "channels": channels,
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=1)
    log("gravado %s com %d canais" % (OUT_PATH, len(channels)))


if __name__ == "__main__":
    main()
