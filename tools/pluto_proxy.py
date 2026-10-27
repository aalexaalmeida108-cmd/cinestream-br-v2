#!/usr/bin/env python3
"""Local stand-in for worker/pluto-proxy.js — same routing, same headers.

    python3 tools/pluto_proxy.py 8901
    open http://127.0.0.1:8899/live.html?proxy=http://127.0.0.1:8901

Only needed to exercise the Pluto source before the Worker is deployed.
"""
import re
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOSTS = re.compile(r"^([a-z0-9-]+\.)*(pluto\.tv|plutotv\.net)$", re.I)
CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    "Cache-Control": "no-store",
}
PASS = ("content-type", "content-range", "accept-ranges", "etag", "last-modified")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _cors(self):
        for key, value in CORS.items():
            self.send_header(key, value)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self._serve(head=True)

    def do_GET(self):
        self._serve(head=False)

    def _serve(self, head):
        if not self.path.startswith("/p/"):
            body = b"cinestream pluto proxy\nuse /p/<host>/<path>\n"
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head:
                self.wfile.write(body)
            return

        rest = self.path[3:]
        cut = rest.find("/")
        host = rest[:cut] if cut > 0 else ""
        if not host or not HOSTS.match(host):
            body = b"host not allowed"
            self.send_response(403)
            self._cors()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head:
                self.wfile.write(body)
            return

        target = "https://" + host + rest[cut:]
        request = urllib.request.Request(
            target,
            method="HEAD" if head else "GET",
            headers={
                "Referer": "https://pluto.tv/",
                "User-Agent": self.headers.get("User-Agent", "Mozilla/5.0"),
                "Accept": self.headers.get("Accept", "*/*"),
                "Origin": "https://pluto.tv",
            },
        )
        rng = self.headers.get("Range")
        if rng:
            request.add_header("Range", rng)

        try:
            upstream = urllib.request.urlopen(request, timeout=25)
            status = upstream.status
            meta = upstream.headers
        except urllib.error.HTTPError as error:
            upstream = error
            status = error.code
            meta = error.headers
        except Exception as error:  # noqa: BLE001
            body = f"upstream error: {error}".encode()
            self.send_response(502)
            self._cors()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head:
                self.wfile.write(body)
            return

        data = b"" if head else upstream.read()
        self.send_response(status)
        self._cors()
        for name in PASS:
            value = meta.get(name)
            if value:
                self.send_header(name, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if not head:
            self.wfile.write(data)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8901
    print(f"pluto proxy on http://127.0.0.1:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
