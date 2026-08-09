"""
TVSearch desktop wrapper.

Runs local-server.py's scraping server in a background thread and opens the
TVSearch UI in a native pywebview (WebView2) window. Lets you try the app on
a PC without a TV or Android SDK.

Usage:
  python desktop-app.py            # normal: opens the desktop window
  python desktop-app.py --smoke    # headless self-check: start server, hit APIs, exit
  python desktop-app.py --port 8080  # pin the port (default: auto-pick a free one)
"""

import argparse
import functools
import importlib.util
import json
import socket
import sys
import threading
import urllib.parse
import urllib.request
from http.server import HTTPServer
from pathlib import Path


def resource_path(rel: str) -> Path:
    """Resolve a path relative to the bundle root (works in dev AND PyInstaller)."""
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    return base / rel


def load_local_server():
    """Load local-server.py as a module (its filename has a hyphen, so it
    cannot be imported with a normal `import` statement)."""
    server_py = resource_path("local-server.py")
    if not server_py.exists():
        raise FileNotFoundError(f"local-server.py not found at {server_py}")
    spec = importlib.util.spec_from_file_location("local_server", server_py)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def find_assets_dir() -> Path:
    """Locate the frontend assets directory in dev and packaged layouts."""
    for candidate in ("app/src/main/assets", "assets"):
        p = resource_path(candidate)
        if p.is_dir():
            return p
    raise FileNotFoundError("Could not locate assets/ directory")


def pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_server(server_mod, assets_dir: Path, port: int):
    """Serve static assets + /api/search + /api/play on 127.0.0.1:port."""
    handler = functools.partial(server_mod.CombinedHandler, directory=str(assets_dir))
    server = HTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def smoke_test(server_mod, assets_dir: Path, port: int) -> int:
    """Start the server, exercise /api/search + /api/play, report results."""
    server, thread = start_server(server_mod, assets_dir, port)
    try:
        base = f"http://127.0.0.1:{port}"

        # 1) static asset served?
        with urllib.request.urlopen(f"{base}/index.html", timeout=15) as resp:
            html = resp.read().decode("utf-8")
        assert "TVSearch" in html or "TV Search" in html, "index.html missing app markup"
        print(f"[smoke] OK: index.html served ({len(html)} bytes)")

        # 2) search API?
        q = urllib.parse.quote("四渡赤水")
        with urllib.request.urlopen(f"{base}/api/search?q={q}", timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        results = data.get("results", [])
        print(f"[smoke] OK: search returned {len(results)} results")
        if not results:
            print("[smoke] WARN: no search results — site may be unreachable from this network")
            return 1

        # 3) play API on first result?
        play_url = urllib.parse.quote(results[0]["url"])
        with urllib.request.urlopen(f"{base}/api/play?url={play_url}", timeout=30) as resp:
            play = json.loads(resp.read().decode("utf-8"))
        lines = play.get("lines", [])
        total = sum(len(l.get("items", [])) for l in lines)
        print(f"[smoke] OK: play info — {len(lines)} lines, {total} playable items")
        return 0
    finally:
        server.shutdown()
        thread.join(timeout=5)


class FullscreenApi:
    """Exposed to the page as window.pywebview.api for NATIVE window fullscreen.

    HTML5 requestFullscreen() is unreliable inside WebView2 (it never truly
    covers the OS taskbar), so the desktop wrapper exposes the real pywebview
    window toggle instead. JS decides which path to use.
    """

    def __init__(self):
        self._window = None

    def set_window(self, window):
        self._window = window

    def toggle_fullscreen(self):
        if self._window is not None:
            self._window.toggle_fullscreen()

    def enter_fullscreen(self):
        if self._window is not None and not self.is_fullscreen():
            self._window.toggle_fullscreen()

    def exit_fullscreen(self):
        if self._window is not None and self.is_fullscreen():
            self._window.toggle_fullscreen()

    def is_fullscreen(self):
        if self._window is None:
            return False
        return getattr(self._window, "state", "normal") == "fullscreen"


def main():
    ap = argparse.ArgumentParser(description="TVSearch desktop wrapper")
    ap.add_argument("--smoke", action="store_true", help="headless self-check, no window")
    ap.add_argument("--port", type=int, default=0, help="server port (default: auto-pick free)")
    args = ap.parse_args()

    server_mod = load_local_server()
    assets_dir = find_assets_dir()
    port = args.port or pick_free_port()

    if args.smoke:
        sys.exit(smoke_test(server_mod, assets_dir, port))

    import webview  # imported lazily so --smoke needs no GUI deps

    server, _ = start_server(server_mod, assets_dir, port)
    url = f"http://127.0.0.1:{port}/index.html"
    print(f"[desktop] serving {assets_dir} at {url}")
    api = FullscreenApi()
    window = webview.create_window(
        "TVSearch",
        url,
        width=1280,
        height=720,
        resizable=True,
        min_size=(960, 540),
        js_api=api,
    )
    api.set_window(window)
    try:
        webview.start()
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
