#!/usr/bin/env python3
"""Small, token-protected controller for the HomeCam camera service."""

import hmac
import json
import os
import stat
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CAMERA_ENV = "/etc/homecam/camera.env"
SERVICE = "homecam-camera.service"
TOKEN = os.environ.get("HOMECAM_CONTROL_TOKEN", "")
ALLOWED_HOST = os.environ.get("HOMECAM_ALLOWED_HOST", "").strip()
PORT = int(os.environ.get("HOMECAM_CONTROL_PORT", "9110"))
OPTIONS = {
    "resolution": {"640x480", "1280x720"},
    "fps": {5, 10, 15, 20, 25, 30},
    "bitrate": {"1000k", "1500k", "2000k", "3000k"},
}


def parse_env(lines):
    values = {}
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key] = value
    return values


def update_env(values):
    original = os.stat(CAMERA_ENV)
    with open(CAMERA_ENV, "r", encoding="utf-8") as handle:
        lines = handle.readlines()
    replacements = {
        "VIDEO_SIZE": values["resolution"],
        "VIDEO_FPS": str(values["fps"]),
        "VIDEO_BITRATE": values["bitrate"],
    }
    seen = set()
    output = []
    for line in lines:
        stripped = line.strip()
        key = stripped.split("=", 1)[0] if "=" in stripped and not stripped.startswith("#") else ""
        if key in replacements:
            output.append(f"{key}={replacements[key]}\n")
            seen.add(key)
        else:
            output.append(line)
    output.extend(f"{key}={value}\n" for key, value in replacements.items() if key not in seen)
    descriptor, temporary = tempfile.mkstemp(prefix="camera.env.", dir=os.path.dirname(CAMERA_ENV), text=True)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.writelines(output)
        os.chown(temporary, original.st_uid, original.st_gid)
        os.chmod(temporary, stat.S_IMODE(original.st_mode))
        os.replace(temporary, CAMERA_ENV)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def validate(payload):
    try:
        values = {
            "resolution": str(payload["resolution"]),
            "fps": int(payload["fps"]),
            "bitrate": str(payload["bitrate"]),
        }
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("invalid camera settings") from error
    if values["resolution"] not in OPTIONS["resolution"]:
        raise ValueError("unsupported resolution")
    if values["fps"] not in OPTIONS["fps"]:
        raise ValueError("unsupported fps")
    if values["bitrate"] not in OPTIONS["bitrate"]:
        raise ValueError("unsupported bitrate")
    return values


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def _json(self, status, value):
        body = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        if ALLOWED_HOST and self.client_address[0] != ALLOWED_HOST:
            return False
        supplied = self.headers.get("Authorization", "")
        return bool(TOKEN) and hmac.compare_digest(supplied, f"Bearer {TOKEN}")

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/v1/camera/settings":
            return self._json(404, {"error": "not found"})
        if not self._authorized():
            return self._json(401, {"error": "unauthorized"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size > 4096:
                raise ValueError("request too large")
            payload = json.loads(self.rfile.read(size).decode("utf-8"))
            values = validate(payload)
            with open(CAMERA_ENV, "r", encoding="utf-8") as handle:
                current = parse_env(handle.readlines())
            if all(current.get(key) == value for key, value in {
                "VIDEO_SIZE": values["resolution"],
                "VIDEO_FPS": str(values["fps"]),
                "VIDEO_BITRATE": values["bitrate"],
            }.items()):
                return self._json(200, {"ok": True, "detail": "camera settings already applied"})
            update_env(values)
            subprocess.run(["systemctl", "restart", SERVICE], check=True, timeout=20)
            self._json(200, {"ok": True, "detail": "camera service restarted"})
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            self._json(400, {"error": str(error)})

    def log_message(self, format_string, *args):
        print(f"homecam-control: {format_string % args}", flush=True)


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("HOMECAM_CONTROL_TOKEN is required")
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()
