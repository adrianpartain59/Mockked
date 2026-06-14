#!/usr/bin/env python3
"""Static file server + video-export helper for Mockup Studio.

Serves the app like `python3 -m http.server`, plus an /export API the app uses
to produce a transparent .mov: the browser renders the mockup frame by frame
and POSTs raw frames here, and we pipe them into a hardware VideoToolbox encoder
with an alpha channel. The result is a QuickTime .mov that keeps the transparent
background and plays natively on macOS/iOS and in Final Cut / Premiere / AE.

Two output codecs (chosen per export):
  hevc   — HEVC + alpha (compact; the 4:2:0 encoder is the wall at ~37fps).
  prores — ProRes 4444 (Apple's native transparent-video master; bigger files,
           but a dedicated silicon encoder that's roughly twice as fast).

And two upload layouts, so the browser can spend less on transport:
  rgba    — straight-alpha RGBA (4 B/px); the server does the colour conversion.
  yuva420 — the browser already packed planar bt709-limited YUV+alpha (2.5 B/px,
            flip + colour baked in on the GPU); the server feeds it through
            untouched. ~1.6x less data to move per frame than rgba.

API (all same-origin from the served app):
  GET  /export/ping    -> {"ok": true, "ffmpeg": bool}   capability check
  POST /export/start   -> {"width", "height", "fps", "layout", "codec", "vflip"}
  POST /export/frame   -> raw frame bytes for the next frame, in order
  POST /export/finish  -> closes the stream, responds with the finished .mov
  POST /export/abort   -> kills the encode and discards the output

One export runs at a time (it's a single-user local tool).
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

FFMPEG = shutil.which("ffmpeg")

# The single in-flight export (or None):
#   proc, path, frame_bytes  — ffmpeg process, output file, expected frame size
#   queue: {index: bytes}    — reorder buffer (clients upload on parallel lanes)
#   next: int                — next frame index the writer will feed to ffmpeg
#   auto_index: int          — assigned to frames sent without an index header
#   closing/error            — writer shutdown / failure signals
#   writer: Thread           — drains the queue into ffmpeg stdin, in order
_export = None
_lock = threading.Lock()
_cv = threading.Condition(_lock)

# How many frames may wait in memory before uploads block. Two on purpose:
# enough that the ffmpeg write overlaps the next frame's upload, but shallow
# enough that the client stays paced to encoder speed — a deep buffer lets the
# browser burst-create big Blob bodies faster than they're consumed, which
# strains Chromium's blob transport into failing fetches. Must exceed the
# client's upload-lane count to avoid a retry deadlock.
QUEUE_DEPTH = 2

# Server-side timing for the most recent export, exposed at GET /export/stats
# so the client can fold it into its telemetry file. read_s ≈ how fast frames
# arrived from the browser; write_s ≈ ffmpeg stdin backpressure (encoder speed);
# gaps ≈ time the browser spent between frames (render/readback stalls).
_stats = None


def _new_stats(w, h, fps):
    return {
        "width": w, "height": h, "fps": fps,
        "started": time.time(),
        "frames": 0, "bytes": 0,
        "read_s": 0.0, "read_max_ms": 0.0,
        "write_s": 0.0, "write_max_ms": 0.0,
        "gap_s": 0.0, "gap_max_ms": 0.0, "last_frame_t": None,
        "qmax": 0,
        "drain_s": None, "file_bytes": None, "wall_s": None,
        "ffmpeg_stderr": "", "state": "running",
    }


def _writer_loop(exp):
    """Feed queued frames to ffmpeg stdin strictly in index order.

    Decouples uploads from encoding: HTTP handlers enqueue and return, so the
    next frame's upload overlaps this frame's encode. Runs until the export is
    closing (and drained), superseded, or the encoder dies. Called with _cv's
    lock NOT held.
    """
    proc = exp["proc"]
    while True:
        with _cv:
            while True:
                if exp is not _export and not exp["closing"]:
                    return  # superseded by a newer export
                if exp["error"]:
                    return
                if exp["next"] in exp["queue"]:
                    data = exp["queue"].pop(exp["next"])
                    break
                if exp["closing"] and not exp["queue"]:
                    return  # drained
                _cv.wait(timeout=1)
        t0 = time.time()
        try:
            proc.stdin.write(data)  # blocks while ffmpeg is behind: backpressure
        except (BrokenPipeError, OSError):
            try:
                err = (proc.stderr.read() or b"").decode(errors="replace")[-500:]
            except Exception:
                err = ""
            with _cv:
                exp["error"] = f"encoder died: {err}"
                if _stats is not None:
                    _stats["state"] = "encoder died"
                    _stats["ffmpeg_stderr"] = err
                _cv.notify_all()
            return
        with _cv:
            exp["next"] += 1
            if _stats is not None:
                w_ms = (time.time() - t0) * 1000
                _stats["write_s"] += w_ms / 1000
                _stats["write_max_ms"] = max(_stats["write_max_ms"], round(w_ms, 1))
            _cv.notify_all()


def _cleanup_export():
    """Kill any in-flight encode and remove its temp file. Caller holds _lock."""
    global _export
    if not _export:
        return
    exp = _export
    exp["error"] = exp["error"] or "aborted"
    proc = exp["proc"]
    try:
        if proc.stdin and not proc.stdin.closed:
            proc.stdin.close()
        proc.kill()
        proc.wait(timeout=5)
    except Exception:
        pass
    try:
        os.unlink(exp["path"])
    except OSError:
        pass
    _export = None
    _cv.notify_all()  # wake the writer and any blocked uploads so they bail


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # Keep frame POSTs from flooding the terminal.
        if "/export/frame" not in (args[0] if args else ""):
            super().log_message(fmt, *args)

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length else b""

    def do_GET(self):
        if self.path == "/export/ping":
            return self._json(200, {"ok": True, "ffmpeg": bool(FFMPEG)})
        if self.path == "/export/stats":
            with _lock:
                return self._json(200, _stats or {})
        return super().do_GET()

    def do_POST(self):
        global _export, _stats
        if self.path == "/export/start":
            body = self._read_body()
            with _lock:
                _cleanup_export()  # discard any orphaned previous export
                if not FFMPEG:
                    return self._json(500, {"ok": False, "error": "ffmpeg not found — brew install ffmpeg"})
                try:
                    cfg = json.loads(body)
                    w, h, fps = int(cfg["width"]), int(cfg["height"]), int(cfg.get("fps", 30))
                except (ValueError, KeyError, json.JSONDecodeError) as e:
                    return self._json(400, {"ok": False, "error": f"bad config: {e}"})
                layout = cfg.get("layout", "rgba")
                codec = cfg.get("codec", "hevc")
                # Frame size on the wire depends on the layout. yuva420p is planar
                # bt709-limited Y + quarter-res U/V + full-res A = 2.5 bytes/px;
                # rgba is 4.
                if layout == "yuva420":
                    in_pix = "yuva420p"
                    frame_bytes = w * h * 5 // 2
                else:
                    layout = "rgba"
                    in_pix = "rgba"
                    frame_bytes = w * h * 4
                _stats = _new_stats(w, h, fps)
                _stats["layout"] = layout
                _stats["codec"] = codec
                fd, path = tempfile.mkstemp(suffix=".mov")
                os.close(fd)
                # Source filters only apply to the rgba layout — the browser sends
                # straight-alpha RGB the server must convert. The client may send
                # those frames bottom-up (vflip) straight off GPU readback. For
                # HEVC the explicit bt709/tv conversion + colr tagging matters:
                # feeding RGB directly to VideoToolbox produces a gbr-tagged stream
                # most decoders misread (washed-out colors). For ProRes 4444 — a
                # natively RGB+alpha format — we hand VideoToolbox bgra directly,
                # so no chroma subsampling and the alpha stays full-res.
                #
                # The yuva420 layout arrives already planar, bt709-limited, and
                # top-down (the GPU pack shader baked in the flip + colour), so it
                # needs no filtering — only the colr tags below to describe it.
                vf = []
                if layout == "rgba":
                    if cfg.get("vflip"):
                        vf.append("vflip")
                    if codec == "prores":
                        vf.append("format=bgra")
                    else:
                        vf += ["scale=out_color_matrix=bt709:out_range=tv", "format=ayuv"]
                cmd = [
                    FFMPEG, "-hide_banner", "-loglevel", "error",
                    "-f", "rawvideo", "-pix_fmt", in_pix,
                    "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
                ]
                if vf:
                    cmd += ["-vf", ",".join(vf)]
                if codec == "prores":
                    # Dedicated ProRes silicon; 4444 carries the alpha plane.
                    cmd += ["-c:v", "prores_videotoolbox", "-allow_sw", "1", "-profile:v", "4444"]
                else:
                    cmd += [
                        "-c:v", "hevc_videotoolbox", "-allow_sw", "1",
                        "-q:v", "70", "-alpha_quality", "0.75",
                        "-tag:v", "hvc1",
                    ]
                cmd += [
                    "-colorspace", "bt709", "-color_primaries", "bt709",
                    "-color_trc", "bt709", "-color_range", "tv",
                    "-movflags", "+faststart+write_colr",
                    "-y", path,
                ]
                try:
                    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
                except OSError as e:
                    os.unlink(path)
                    return self._json(500, {"ok": False, "error": f"couldn't start ffmpeg: {e}"})
                _export = {
                    "proc": proc, "path": path, "frame_bytes": frame_bytes,
                    "queue": {}, "next": 0, "auto_index": 0,
                    "closing": False, "error": None, "writer": None,
                }
                _export["writer"] = threading.Thread(target=_writer_loop, args=(_export,), daemon=True)
                _export["writer"].start()
            return self._json(200, {"ok": True})

        if self.path == "/export/frame":
            t_arrive = time.time()
            data = self._read_body()
            t_read = time.time()
            with _cv:
                exp = _export
                if not exp:
                    return self._json(409, {"ok": False, "error": "no export in progress"})
                # A connection that died mid-upload leaves a truncated body —
                # writing it would shift every later frame. Drop it; the client
                # retries the full frame.
                if len(data) != exp["frame_bytes"]:
                    return self._json(400, {"ok": False, "error": f"short frame ({len(data)} of {exp['frame_bytes']} bytes)"})
                idx = self.headers.get("X-Frame-Index")
                if idx is None:
                    idx = exp["auto_index"]
                    exp["auto_index"] += 1
                else:
                    try:
                        idx = int(idx)
                    except ValueError:
                        return self._json(400, {"ok": False, "error": f"bad frame index {idx!r}"})
                # A retry of a frame the writer already consumed (its first
                # attempt succeeded but the response was lost): just ack it.
                if idx < exp["next"]:
                    return self._json(200, {"ok": True, "duplicate": True})
                # Backpressure: hold the upload while the reorder buffer is full.
                while exp is _export and not exp["error"] and len(exp["queue"]) >= QUEUE_DEPTH and idx not in exp["queue"]:
                    _cv.wait(timeout=10)
                if exp is not _export:
                    return self._json(409, {"ok": False, "error": "export superseded"})
                if exp["error"]:
                    return self._json(500, {"ok": False, "error": exp["error"]})
                if idx < exp["next"]:
                    return self._json(200, {"ok": True, "duplicate": True})
                fresh = idx not in exp["queue"]
                exp["queue"][idx] = data
                _cv.notify_all()
                if _stats is not None and fresh:
                    s = _stats
                    s["frames"] += 1
                    s["bytes"] += len(data)
                    read_ms = (t_read - t_arrive) * 1000
                    s["read_s"] += read_ms / 1000
                    s["read_max_ms"] = max(s["read_max_ms"], round(read_ms, 1))
                    s["qmax"] = max(s["qmax"], len(exp["queue"]))
                    if s["last_frame_t"] is not None:
                        gap_ms = (t_arrive - s["last_frame_t"]) * 1000
                        s["gap_s"] += gap_ms / 1000
                        s["gap_max_ms"] = max(s["gap_max_ms"], round(gap_ms, 1))
                    s["last_frame_t"] = t_read
            return self._json(200, {"ok": True})

        if self.path == "/export/finish":
            self._read_body()
            with _cv:
                if not _export:
                    return self._json(409, {"ok": False, "error": "no export in progress"})
                exp = _export
                exp["closing"] = True
                _cv.notify_all()
            t_drain = time.time()
            exp["writer"].join(timeout=300)
            with _lock:
                if _export is not exp:
                    return self._json(409, {"ok": False, "error": "export superseded"})
                if exp["error"]:
                    err = exp["error"]
                    _cleanup_export()
                    return self._json(500, {"ok": False, "error": err})
                if exp["queue"] or exp["writer"].is_alive():
                    missing = exp["next"]
                    _cleanup_export()
                    return self._json(500, {"ok": False, "error": f"frame {missing} never arrived"})
                proc, path = exp["proc"], exp["path"]
                proc.stdin.close()
                rc = proc.wait()
                if _stats is not None:
                    _stats["drain_s"] = round(time.time() - t_drain, 3)
                    _stats["wall_s"] = round(time.time() - _stats["started"], 3)
                    _stats["ffmpeg_stderr"] = (proc.stderr.read() or b"").decode(errors="replace")[-500:]
                    for k in ("read_s", "write_s", "gap_s"):
                        _stats[k] = round(_stats[k], 3)
                    _stats.pop("last_frame_t", None)
                if rc != 0:
                    err = (_stats or {}).get("ffmpeg_stderr", "")
                    if _stats is not None:
                        _stats["state"] = f"ffmpeg failed ({rc})"
                    _cleanup_export()
                    return self._json(500, {"ok": False, "error": f"ffmpeg failed ({rc}): {err}"})
                size = os.path.getsize(path)
                if _stats is not None:
                    _stats["file_bytes"] = size
                    _stats["state"] = "ok"
                self.send_response(200)
                self.send_header("Content-Type", "video/quicktime")
                self.send_header("Content-Length", str(size))
                self.end_headers()
                with open(path, "rb") as f:
                    shutil.copyfileobj(f, self.wfile)
                os.unlink(path)
                _export = None
            return

        if self.path == "/export/abort":
            self._read_body()
            with _lock:
                if _stats is not None and _stats.get("state") == "running":
                    _stats["state"] = "aborted"
                    _stats.pop("last_frame_t", None)
                _cleanup_export()
            return self._json(200, {"ok": True})

        self._json(404, {"ok": False, "error": "unknown endpoint"})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8001
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server = ThreadingHTTPServer(("", port), Handler)
    print(f"Mockup Studio → http://localhost:{port}"
          + ("" if FFMPEG else "   (ffmpeg not found — video export will fall back to WebM)"))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        _cleanup_export()


if __name__ == "__main__":
    main()
