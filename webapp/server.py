#!/usr/bin/env python3
"""
Static file server for the dira dashboard + POST /refresh endpoint.
POST /refresh runs scrape_dira.py then build_site_data.py and returns JSON.
"""
import http.server
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse, parse_qs

SKILLS_DIR = Path(__file__).parent.parent / "skills" / "scrape-dira"
SCRAPER    = SKILLS_DIR / "scrape_dira.py"
EXPORTER   = SKILLS_DIR / "build_site_data.py"


def load_env():
    env_path = Path(__file__).parent.parent / "secrets.local.env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, val = line.split("=", 1)
                os.environ[key.strip()] = val.strip()

load_env()


class DiraHandler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/refresh":
            query = parse_qs(parsed.query)
            code = query.get("code", [""])[0]
            expected_code = os.environ.get("DIRA_REFRESH_CODE")
            if expected_code and code == expected_code:
                self._handle_refresh()
            else:
                self.send_response(401)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "error": "Unauthorized: invalid passcode"}).encode())
        else:
            self.send_error(404)

    def _handle_refresh(self):
        try:
            r1 = subprocess.run(
                [sys.executable, str(SCRAPER)],
                capture_output=True, text=True, timeout=180
            )
            r2 = subprocess.run(
                [sys.executable, str(EXPORTER)],
                capture_output=True, text=True, timeout=30
            )
            ok = r1.returncode == 0 and r2.returncode == 0
            print(f"[refresh] scraper rc={r1.returncode} exporter rc={r2.returncode}", flush=True)
            if not ok:
                print(f"[refresh] scraper stderr: {r1.stderr[-300:]}", flush=True)
                print(f"[refresh] exporter stderr: {r2.stderr[-300:]}", flush=True)
            body = json.dumps({
                "ok": ok,
                "scraper":  (r1.stdout or r1.stderr)[-600:],
                "exporter": (r2.stdout or r2.stderr)[-200:],
            }, ensure_ascii=False).encode()
        except Exception as e:
            print(f"[refresh] exception: {e}", flush=True)
            ok = False
            body = json.dumps({"ok": False, "error": str(e)}).encode()

        self.send_response(200 if ok else 500)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # suppress per-request logs


if __name__ == "__main__":
    os.chdir(Path(__file__).parent)
    addr = ("0.0.0.0", 8743)
    print(f"Dira dashboard serving on http://{addr[0]}:{addr[1]}", flush=True)
    with http.server.HTTPServer(addr, DiraHandler) as httpd:
        httpd.serve_forever()
