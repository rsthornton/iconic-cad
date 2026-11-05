#!/usr/bin/env python3
"""No-cache dev server for the web UI, with an optional live layout file.

`python -m http.server` lets the browser cache ES modules aggressively, so
edits to web/js/*.js don't show up even after Ctrl+Shift+R. This server sends
Cache-Control: no-store on every response, so a plain reload always fetches the
latest code and assets.

Usage (from repo root):
    python scripts/serve.py            # serves web/ at http://127.0.0.1:8080/
    python scripts/serve.py 9000       # custom port

Then open http://127.0.0.1:8080/ and just reload after each edit.

Live layout (opt-in):
    python scripts/serve.py --watch house.json

Then open http://127.0.0.1:8080/?live. The page loads house.json, reloads it
whenever the file changes on disk (an editor, a script, a coding agent), and
writes edits made in the browser back to it. Without --watch and ?live,
nothing changes. With --watch the server binds to 127.0.0.1 only, because it
accepts writes.
"""
import argparse
import http.server
import json
import os
import socketserver
import sys
import threading
import time

WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")
LIVE_PREFIX = "/__live/"
POLL_S = 0.25
KEEPALIVE_S = 15.0


class LiveFile:
    """The watched layout file, plus what the browser last wrote to it.

    The last write is kept so a browser save is not echoed back to the
    browser as an external change.
    """

    def __init__(self, path):
        self.path = os.path.abspath(path)
        self.lock = threading.Lock()
        self.own_write = None  # bytes the browser last POSTed

    def stamp(self):
        try:
            st = os.stat(self.path)
            return (st.st_mtime_ns, st.st_size)
        except FileNotFoundError:
            return None

    def read(self):
        try:
            with open(self.path, "rb") as f:
                return f.read()
        except FileNotFoundError:
            return None

    def write(self, body):
        tmp = self.path + ".tmp"
        with self.lock:
            with open(tmp, "wb") as f:
                f.write(body)
            os.replace(tmp, self.path)
            self.own_write = body

    def is_own_write(self, body):
        with self.lock:
            return body is not None and body == self.own_write


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    live = None  # LiveFile when --watch is given

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    # --- live layout endpoints (only with --watch) --------------------------

    def _live_route(self):
        if self.live is None or not self.path.startswith(LIVE_PREFIX):
            return None
        return self.path[len(LIVE_PREFIX):].split("?", 1)[0]

    def _send(self, code, body=b"", ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        route = self._live_route()
        if route is None:
            return super().do_GET()
        if route == "layout":
            body = self.live.read()
            if body is None:
                return self._send(404, b'{"error": "no layout file yet"}')
            return self._send(200, body)
        if route == "info":
            info = {"path": self.live.path, "exists": self.live.stamp() is not None}
            return self._send(200, json.dumps(info).encode())
        if route == "events":
            return self._events()
        return self._send(404, b'{"error": "unknown live route"}')

    def do_POST(self):
        route = self._live_route()
        if route != "layout":
            return self._send(404, b'{"error": "not found"}')
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        try:
            data = json.loads(body)
        except ValueError as e:
            return self._send(400, json.dumps({"error": f"invalid JSON: {e}"}).encode())
        if not isinstance(data, dict) or not isinstance(data.get("entities"), list):
            return self._send(400, b'{"error": "not a layout: needs an entities list"}')
        self.live.write(body)
        return self._send(204)

    def _events(self):
        """Server-sent events: one 'change' event per external file change."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        last = self.live.stamp()
        last_ping = time.monotonic()
        try:
            self.wfile.write(b": live\n\n")
            self.wfile.flush()
            while True:
                time.sleep(POLL_S)
                now = self.live.stamp()
                if now != last:
                    last = now
                    if not self.live.is_own_write(self.live.read()):
                        self.wfile.write(b"event: change\ndata: {}\n\n")
                        self.wfile.flush()
                if time.monotonic() - last_ping > KEEPALIVE_S:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_ping = time.monotonic()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, fmt, *args):
        # The event stream and autosave are chatty; keep the log to page loads.
        if self.path.startswith(LIVE_PREFIX):
            return
        super().log_message(fmt, *args)


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def make_server(port, watch=None):
    """Build the server. With watch, bind to 127.0.0.1 and enable /__live/."""
    handler = type("Handler", (NoCacheHandler,), {"live": LiveFile(watch) if watch else None})
    host = "127.0.0.1" if watch else ""
    return Server((host, port), handler)


def main(argv=None):
    ap = argparse.ArgumentParser(description="No-cache dev server for web/.")
    ap.add_argument("port", nargs="?", type=int, default=8080)
    ap.add_argument("--watch", metavar="LAYOUT.json",
                    help="live-sync this layout file with the page opened at /?live")
    args = ap.parse_args(argv)
    with make_server(args.port, args.watch) as httpd:
        print("Serving %s at http://127.0.0.1:%d/  (no-cache)" % (WEB_DIR, args.port))
        if args.watch:
            print("Live layout: %s  ->  open http://127.0.0.1:%d/?live"
                  % (os.path.abspath(args.watch), args.port))
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
