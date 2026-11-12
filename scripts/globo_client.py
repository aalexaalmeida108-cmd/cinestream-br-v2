#!/usr/bin/env python3
"""globo_client.py - cliente da Globoplay para canais ao vivo.

Reproduz o mesmo caminho que o app oficial usa, com as chamadas publicas
documentadas:

  1. registro de device (Firebase/GCM) -> instance_id do "GloboID"
  2. login  -> POST login.globo.com/api/authentication/sdk
              (Authorization: IIDToken com.globo.hydra|<instance_id>)
              -> cookie GLBID
  3. lineup -> GraphQL multicloud-jarvis-r.globo.com/graphql (query
              broadcasts) com o token da sessao
  4. manifesto -> JSONP api.globovideos.com/videos/<mediaId>/playlist/
              without_resources/callback/<cb> com o cookie da sessao

O sinal so abre para quem tem conta: canais "LOGGED_IN" pedem conta
Gratis, os "SUBSCRIBER" pedem assinatura (Premiere, sportv, telecine...).

Uso:
    from globo_client import GloboClient
    gl = GloboClient()
    gl.login("email", "senha")
    print(gl.manifest("8223631"))
"""

import gzip
import http.cookiejar
import json
import re
import urllib.error
import urllib.parse
import urllib.request

UA_APP = "Globoplay/1 CFNetwork/1220.1 Darwin/20.3.0"
UA_WEB = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

CHECKIN_URL = "https://device-provisioning.googleapis.com/checkin"
INSTALLATIONS_URL = ("https://firebaseinstallations.googleapis.com/v1/"
                      "projects/globo-play/installations/")
FCM_URL = "https://fcmtoken.googleapis.com/register"
LOGIN_URL = "https://login.globo.com/api/authentication/sdk"
GQL_URL = "https://multicloud-jarvis-r.globo.com/graphql"
PLAYLIST_HOST = "https://api.globovideos.com"
SECURITY_HOST = "https://security.video.globo.com"

FIREBASE_APP_ID = "1:846115935537:ios:c91952b14380e445"
FIREBASE_KEY = "AIzaSyDbGxO8Bw7cfT5BYiAQTnReVItGEXlpnhY"
FIREBASE_CLIENT = (
    "apple-platform/ios apple-sdk/18B79 appstore/true deploy/cocoapods "
    "device/iPhone10,6 fire-abt/7.1.0 fire-analytics/7.3.0 fire-fcm/7.1.0 "
    "fire-iid/7.1.0 fire-install/7.1.0 fire-ios/7.1.0 fire-perf/7.0.1 "
    "fire-rc/7.1.0 firebase-crashlytics/7.1.0 os-version/14.4 swift/true "
    "xcode/12B45b")


class GloboError(RuntimeError):
    pass


def _post_json(url, payload, headers=None, timeout=30):
    body = json.dumps(payload).encode("utf-8")
    head = {"Content-Type": "application/json; charset=UTF-8",
            "User-Agent": UA_APP,
            "Accept": "application/json, text/javascript"}
    head.update(headers or {})
    req = urllib.request.Request(url, data=body, headers=head)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def _post_form(url, payload, headers=None, timeout=30):
    body = urllib.parse.urlencode(payload).encode("utf-8")
    head = {"Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": UA_APP}
    head.update(headers or {})
    req = urllib.request.Request(url, data=body, headers=head)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


class GloboClient:
    def __init__(self, instance_id=None):
        self.instance_id = instance_id
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookies))

    # -- device ------------------------------------------------------------

    def register_device(self):
        """Registra o device e devolve o instance_id do GloboID."""
        checkin = {
            "checkin": {
                "iosbuild": {"model": "iPhone10,6", "os_version": "IOS_14.4"},
                "last_checkin_msec": 0,
                "type": 2,
                "user_number": 0,
            },
            "digest": "",
            "fragment": 0,
            "id": 0,
            "locale": "pt",
            "security_token": 0,
            "time_zone": "America/Sao_Paulo",
            "user_serial_number": 0,
            "version": 2,
        }
        info = _post_json(CHECKIN_URL, checkin)
        android_id = info.get("android_id")
        security_token = info.get("security_token")
        version_info = info.get("version_info")

        install = _post_json(
            INSTALLATIONS_URL,
            {"appId": FIREBASE_APP_ID, "authVersion": "FIS_v2",
             "sdkVersion": "i:7.1.0"},
            headers={
                "x-goog-api-key": FIREBASE_KEY,
                "x-firebase-client": FIREBASE_CLIENT,
                "x-firebase-client-log-type": "3",
                "x-ios-bundle-identifier": "com.globo.hydra",
            })
        fid = install.get("fid")
        auth_token = (install.get("authToken") or {}).get("token")

        payload = {
            "X-osv": "14.4",
            "device": android_id,
            "X-scope": "*",
            "plat": "2",
            "app": "com.globo.hydra",
            "app_ver": "3.91.0",
            "X-cliv": "fiid-7.1.0",
            "sender": "846115935537",
            "X-subtype": "846115935537",
            "appid": fid,
            "gmp_app_id": FIREBASE_APP_ID,
        }
        headers = {
            "x-firebase-client": FIREBASE_CLIENT,
            "authorization": "AidLogin %s:%s" % (android_id, security_token),
            "x-firebase-client-log-type": "1",
            "app": "com.globo.hydra",
            "user-agent": UA_APP,
            "info": version_info,
            "x-goog-firebase-installations-auth": auth_token,
        }
        raw = _post_form(FCM_URL, payload, headers=headers)
        if not raw.startswith("token="):
            raise GloboError("registro de device falhou: %s" % raw[:200])
        self.instance_id = raw.replace("token=", "").strip()
        return self.instance_id

    # -- login -------------------------------------------------------------

    def login(self, email, password, service_id="globoplay"):
        """Autentica e guarda o cookie GLBID."""
        if not self.instance_id:
            self.register_device()
        payload = {"payload": {"email": email, "password": password,
                                "serviceId": service_id}}
        head = {
            "content-type": "application/json; charset=UTF-8",
            "accept": "application/json, text/javascript",
            "Accept-Encoding": "gzip",
            "Authorization": "IIDToken com.globo.hydra|%s" % self.instance_id,
            "User-Agent": UA_APP,
        }
        req = urllib.request.Request(LOGIN_URL,
                                     data=json.dumps(payload).encode(),
                                     headers=head)
        try:
            resp = self.opener.open(req, timeout=30)
            raw = resp.read()
            status = resp.status
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            status = exc.code
        if raw[:2] == b"\x1f\x8b":
            try:
                raw = gzip.decompress(raw)
            except OSError:
                pass
        body = raw.decode("utf-8", "replace")
        if status >= 400:
            raise GloboError("login falhou (HTTP %s): %s"
                             % (status, body[:300]))
        if not self.glbid():
            raise GloboError("login sem cookie GLBID: %s" % body[:300])
        return True

    def glbid(self):
        for cookie in self.cookies:
            if cookie.name == "GLBID":
                return cookie.value
        return ""

    # -- catalogo e manifesto ---------------------------------------------

    def info(self, media_id):
        """Estado do canal (publico)."""
        req = urllib.request.Request(
            "%s/videos/%s/info" % (SECURITY_HOST, media_id), data=b"",
            headers={"User-Agent": UA_APP,
                     "Origin": "https://globoplay.globo.com",
                     "Referer": "https://globoplay.globo.com/"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))

    def broadcasts(self, access_token=None):
        """Lineup ao vivo pelo GraphQL (precisa de token de sessao)."""
        query = ("query { broadcasts(filtersInput: {affiliateCode: null}) "
                 "{ __typename ... on Broadcast { mediaId name slug logo "
                 "geofencing geoblocked ignoreAdvertisements } } }")
        body = json.dumps({"query": query}).encode()
        head = {"Content-Type": "application/json",
                "User-Agent": UA_WEB,
                "Origin": "https://globoplay.globo.com",
                "Referer": "https://globoplay.globo.com/"}
        if access_token:
            head["Authorization"] = "Bearer %s" % access_token
        req = urllib.request.Request(GQL_URL, data=body, headers=head)
        with self.opener.open(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8", "replace"))
        if payload.get("errors"):
            raise GloboError("graphql: %s" % json.dumps(payload["errors"])[:300])
        return payload.get("data", {}).get("broadcasts") or []

    def playlist(self, media_id, callback="CineStreamGloboplayCallback"):
        """Manifesto do canal (JSONP). Precisa de sessao."""
        url = ("%s/videos/%s/playlist/without_resources/callback/%s"
               % (PLAYLIST_HOST, media_id, callback))
        req = urllib.request.Request(
            url, headers={"User-Agent": UA_WEB,
                          "Referer": "https://globoplay.globo.com/",
                          "Origin": "https://globoplay.globo.com"})
        try:
            with self.opener.open(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            raise GloboError("manifesto HTTP %s: %s"
                             % (exc.code, exc.read()[:200].decode("utf-8", "replace")))
        match = re.search(r"^[^(]*\((.*)\)\s*;?\s*$", raw, re.S)
        if not match:
            raise GloboError("manifesto em formato desconhecido: %s" % raw[:200])
        return json.loads(match.group(1))

    def manifest_url(self, media_id):
        """Extrai a URL de media do manifesto."""
        data = self.playlist(media_id)
        videos = data.get("videos") or []
        if not videos:
            raise GloboError("manifesto sem videos")
        video = videos[0]
        resources = video.get("resources") or []
        for res in resources:
            url = res.get("url") or ""
            if url.endswith(".m3u8"):
                return url
        raise GloboError("manifesto sem m3u8: %s" % json.dumps(video)[:300])


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        raise SystemExit("uso: globo_client.py <email> <senha> [mediaId]")
    client = GloboClient()
    client.register_device()
    print("instance_id:", client.instance_id[:40], "...")
    client.login(sys.argv[1], sys.argv[2])
    print("GLBID:", client.glbid()[:40], "...")
    if len(sys.argv) > 3:
        print(json.dumps(client.info(sys.argv[3]), ensure_ascii=False)[:400])
        print(client.manifest_url(sys.argv[3]))
