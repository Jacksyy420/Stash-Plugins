#!/usr/bin/env python3
"""Scene Snapshots - backend task (raw interface).

Extracts a frame with ffmpeg, stores it in the library path and starts a
scan for that single file only.

Linking the image to the scene (gallery, tag, metadata) deliberately does
NOT happen here: the scan is a separate job, and a task that waits for a job
queued behind it can block itself. Instead the frontend waits until the
image shows up in the database and then links it via GraphQL.
"""
import json
import os
import re
import subprocess
import sys
from urllib import request

PLUGIN_ID = "SceneSnapshot"
FORBIDDEN_NAME_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def valid_filename(name):
    """Plain file name ending in .jpg: no path parts, reserved characters or leading dot."""
    return (
        name.lower().endswith(".jpg")
        and not name.startswith(".")
        and len(name.encode("utf-8")) <= 255
        and not FORBIDDEN_NAME_CHARS.search(name)
        and os.path.basename(name) == name
    )


def log(level, msg):
    # Raw plugin log protocol: \x01<level>\x02<text> on stderr (t, d, i, w, e)
    print(f"\x01{level}\x02{msg}", file=sys.stderr, flush=True)


def finish(output=None, error=None):
    print(json.dumps({"output": output, "error": error}))
    sys.exit(0)


class Stash:
    def __init__(self, conn):
        host = conn.get("Host") or "localhost"
        if host in ("0.0.0.0", "::"):
            host = "localhost"
        self.url = f'{conn.get("Scheme", "http")}://{host}:{conn["Port"]}/graphql'
        cookie = conn.get("SessionCookie") or {}
        self.cookie = f'{cookie["Name"]}={cookie["Value"]}' if cookie.get("Name") else None

    def gql(self, query, variables=None):
        headers = {"Content-Type": "application/json"}
        if self.cookie:
            headers["Cookie"] = self.cookie
        body = json.dumps({"query": query, "variables": variables or {}}).encode()
        with request.urlopen(request.Request(self.url, body, headers), timeout=30) as r:
            res = json.load(r)
        if res.get("errors"):
            raise RuntimeError("; ".join(e["message"] for e in res["errors"]))
        return res["data"]


def pick_library_root(stashes, file_path):
    """Pick the library root containing the scene file (longest match)."""
    best = None
    norm_file = os.path.normpath(file_path)
    for s in stashes:
        root = os.path.normpath(s["path"])
        if norm_file.startswith(root + os.sep) and (best is None or len(root) > len(best)):
            best = root
    return best or (os.path.normpath(stashes[0]["path"]) if stashes else None)


def main():
    inp = json.load(sys.stdin)
    args = inp.get("args") or {}
    stash = Stash(inp["server_connection"])

    scene_id = str(args.get("scene_id", ""))
    if not scene_id.isdigit():
        finish(error="Invalid scene_id")
    try:
        t = float(args["time"])
    except (KeyError, ValueError):
        finish(error="Invalid timestamp")
    filename = str(args.get("filename", ""))
    if not valid_filename(filename):
        finish(error="Invalid file name")

    scene = stash.gql(
        "query($id: ID!){ findScene(id:$id){ title files{ path } } }", {"id": scene_id}
    )["findScene"]
    if not scene or not scene["files"]:
        finish(error="Scene or video file not found")
    src = scene["files"][0]["path"]

    cfg = stash.gql(
        "{ configuration { general { stashes { path } ffmpegPath } plugins } }"
    )["configuration"]
    settings = (cfg.get("plugins") or {}).get(PLUGIN_ID) or {}

    root = pick_library_root(cfg["general"]["stashes"], src)
    if not root:
        finish(error="No library path configured")

    folder = (settings.get("outputFolder") or "Screenshots").strip().strip("/\\")
    safe_title = re.sub(r'[\\/:*?"<>|]', "_", scene["title"] or f"Scene {scene_id}").strip(" .")
    out_dir = os.path.join(root, folder, f"{safe_title[:80]} [{scene_id}]")

    # Rule out path traversal: the target folder must be inside the library root
    real_root = os.path.realpath(root)
    real_out = os.path.realpath(out_dir)
    if not (real_out + os.sep).startswith(real_root + os.sep):
        finish(error="Target folder is outside the library")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, filename)

    try:
        quality = min(31, max(2, int(settings.get("jpegQuality") or 2)))
    except (TypeError, ValueError):
        quality = 2
    ffmpeg = cfg["general"].get("ffmpegPath") or "ffmpeg"

    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-ss", f"{t:.3f}", "-i", src,
        "-frames:v", "1", "-q:v", str(quality), out,
    ]
    log("d", " ".join(cmd))
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except FileNotFoundError:
        finish(error=f"ffmpeg not found ({ffmpeg}). Set the ffmpeg path in the Stash settings.")
    except subprocess.TimeoutExpired:
        finish(error="ffmpeg-Timeout")
    if proc.returncode != 0 or not os.path.exists(out):
        finish(error=f"ffmpeg failed: {proc.stderr.strip()[-300:]}")

    # Scan this file only. We do not wait for the scan (see module docstring).
    job_id = stash.gql(
        "mutation($p:[String!]){ metadataScan(input:{paths:$p}) }", {"p": [out]}
    )["metadataScan"]
    log("i", f"Saved: {out} (scan job {job_id})")
    finish(output=out)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        finish(error=f"{type(e).__name__}: {e}")
