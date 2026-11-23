#!/usr/bin/env python3
"""Bridge between the Chrome extension and yt-dlp (Chrome native messaging).

Chrome starts this script and talks to it over stdin/stdout: each message is a
4-byte length followed by JSON. Commands:
  {"cmd": "check"}                                   -> tool status
  {"cmd": "download", "id", "url", "mode", "sponsorblock"} -> progress / done / error
  {"cmd": "cancel", "id"}
  {"cmd": "reveal", "path"}                          -> shows the file in Finder
"""
import json
import os
import re
import struct
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SEARCH_DIRS = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    os.path.expanduser("~/.local/bin"),
    os.path.expanduser("~/.deno/bin"),
    os.path.join(HERE, "bin"),
]
# Chrome starts us with a minimal PATH; yt-dlp also needs to find ffmpeg and deno.
ENV = dict(os.environ)
ENV["PATH"] = os.pathsep.join([ENV.get("PATH", "/usr/bin:/bin")] + SEARCH_DIRS)
DOWNLOAD_DIR = os.environ.get("MEDIA_DOWNLOADER_DIR") or os.path.expanduser("~/Downloads")
# macOS usually blocks programs started by Chrome from Downloads. Movies and Music are
# not protected, so files go there instead (in a "Media Downloader" subfolder).
FALLBACK_DIRS = {
    "video": os.path.expanduser("~/Movies/Media Downloader"),
    "audio": os.path.expanduser("~/Music/Media Downloader"),
}

out_lock = threading.Lock()
jobs = {}  # id -> Popen


def send(msg):
    data = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    with out_lock:
        sys.stdout.buffer.write(struct.pack("=I", len(data)) + data)
        sys.stdout.buffer.flush()


def receive():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (n,) = struct.unpack("=I", raw)
    return json.loads(sys.stdin.buffer.read(n).decode("utf-8"))


def find(*names):
    for d in ENV["PATH"].split(os.pathsep):
        for name in names:
            p = os.path.join(d, name)
            if os.path.isfile(p) and os.access(p, os.X_OK):
                return p
    return None


def dir_access(path):
    """macOS can block programs started by Chrome from the Downloads folder."""
    try:
        os.listdir(path)
        return "ok"
    except FileNotFoundError:
        return "missing"
    except OSError:
        return "blocked"


def save_dir(mode):
    if os.environ.get("MEDIA_DOWNLOADER_DIR") or dir_access(DOWNLOAD_DIR) == "ok":
        return DOWNLOAD_DIR
    return FALLBACK_DIRS["audio" if mode == "audio" else "video"]


def check():
    ytdlp = find("yt-dlp", "yt-dlp_macos")
    version = None
    if ytdlp:
        try:
            version = subprocess.run([ytdlp, "--version"], capture_output=True, text=True,
                                     timeout=20, env=ENV).stdout.strip()
        except Exception:
            version = None
    return {
        "type": "status",
        "ytdlp": ytdlp,
        "version": version,
        "ffmpeg": find("ffmpeg"),
        "deno": find("deno"),
        "downloadDirAccess": dir_access(DOWNLOAD_DIR),
        "videoDir": save_dir("video"),
        "audioDir": save_dir("audio"),
    }


def build_args(ytdlp, url, mode, sponsorblock):
    args = [
        ytdlp, "--no-playlist", "--newline", "--progress", "--no-simulate", "--no-colors",
        "--progress-template", "download:MDPROG %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
        "--progress-template", "postprocess:MDPOST %(progress.postprocessor)s",
        "--print", "after_move:MDFILE %(filepath)s",
        "-P", save_dir(mode),
        "-o", "%(title).150B [%(id)s].%(ext)s",
    ]
    ffmpeg = find("ffmpeg")
    if ffmpeg:
        args += ["--ffmpeg-location", ffmpeg]
    if mode == "audio":
        args += ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0"]
    else:
        # H.264 + AAC so the file plays everywhere (QuickTime, phones, TVs).
        args += ["-f", "bv*[vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b", "--merge-output-format", "mp4"]
    if sponsorblock:
        args += ["--sponsorblock-remove", "sponsor,selfpromo,interaction"]
    return args + ["--", url]


FRIENDLY_ERRORS = [
    ("confirm your age", "הסרטון מוגבל לגיל ודורש התחברות ליוטיוב, אז אי אפשר להוריד אותו."),
    ("not a bot", "יוטיוב חוסם זמנית הורדות מהמחשב הזה. נסו שוב מאוחר יותר, או עדכנו את yt-dlp."),
    ("private video", "זה סרטון פרטי."),
    ("members-only", "הסרטון זמין רק למנויי הערוץ."),
    ("live event will begin", "השידור החי עוד לא התחיל."),
    ("video unavailable", "הסרטון לא זמין."),
    ("requested format is not available", "הפורמט המבוקש לא זמין לסרטון הזה."),
    ("ffmpeg", "חסר ffmpeg או שהוא לא עובד כמו שצריך."),
    ("operation not permitted", "ל-Chrome אין הרשאה לשמור בתיקיית ההורדות. ראו README, סעיף 'הרשאות'."),
    ("permission denied", "ל-Chrome אין הרשאה לשמור בתיקיית ההורדות. ראו README, סעיף 'הרשאות'."),
]


def friendly_error(msg):
    msg = re.sub(r"^\[[^\]]+\]\s*[\w-]+:\s*", "", msg).strip()
    low = msg.lower()
    for needle, text in FRIENDLY_ERRORS:
        if needle in low:
            return text
    return msg


def clean(s):
    s = (s or "").strip()
    return "" if s in ("NA", "N/A", "Unknown", "Unknown B/s", "Unknown ETA") else s


def run_download(job_id, url, mode, sponsorblock):
    ytdlp = find("yt-dlp", "yt-dlp_macos")
    if not ytdlp:
        send({"type": "error", "id": job_id, "code": "missing", "message": "yt-dlp לא מותקן"})
        return
    try:
        proc = subprocess.Popen(build_args(ytdlp, url, mode, sponsorblock), stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
                                env=ENV, cwd=HERE)
    except Exception as e:
        send({"type": "error", "id": job_id, "message": str(e)})
        return
    jobs[job_id] = proc

    errors = []

    def read_stderr():
        for line in proc.stderr:
            line = line.strip()
            if line.startswith("ERROR:"):
                errors.append(line[6:].strip())

    t = threading.Thread(target=read_stderr, daemon=True)
    t.start()

    filepath = None
    last_sent = 0.0
    for line in proc.stdout:
        line = line.rstrip("\n")
        if line.startswith("MDPROG "):
            pct, speed, eta = (line[7:].split("|") + ["", "", ""])[:3]
            try:
                percent = float(clean(pct).rstrip("%"))
            except ValueError:
                percent = None
            now = time.monotonic()
            if now - last_sent < 0.4 and (percent or 0) < 100:
                continue  # don't flood Chrome with updates
            last_sent = now
            send({"type": "progress", "id": job_id, "stage": "download", "percent": percent,
                  "speed": clean(speed), "eta": clean(eta)})
        elif line.startswith("MDPOST "):
            send({"type": "progress", "id": job_id, "stage": line[7:].strip(), "percent": None})
        elif line.startswith("MDFILE "):
            filepath = line[7:].strip()

    code = proc.wait()
    t.join(timeout=5)
    jobs.pop(job_id, None)
    if code == 0 and filepath:
        send({"type": "done", "id": job_id, "file": filepath})
    elif code < 0 or code == 143:
        send({"type": "error", "id": job_id, "code": "cancelled", "message": "בוטל"})
    else:
        send({"type": "error", "id": job_id,
              "message": friendly_error(errors[-1]) if errors else f"yt-dlp נכשל (קוד {code})"})


def main():
    while True:
        try:
            msg = receive()
        except Exception:
            break
        if msg is None:
            break
        cmd = msg.get("cmd")
        if cmd == "check":
            send(check())
        elif cmd == "download":
            url = str(msg.get("url", ""))
            if not url.startswith(("https://", "http://")):
                send({"type": "error", "id": msg.get("id"), "message": "כתובת לא תקינה"})
                continue
            threading.Thread(target=run_download, daemon=True, args=(
                msg.get("id"), url, msg.get("mode", "video"), bool(msg.get("sponsorblock")))).start()
        elif cmd == "cancel":
            proc = jobs.get(msg.get("id"))
            if proc:
                proc.terminate()
        elif cmd == "reveal":
            path = str(msg.get("path", ""))
            if os.path.isfile(path):
                subprocess.run(["open", "-R", path])
            send({"type": "revealed", "ok": os.path.isfile(path)})

    # Chrome closed the connection: stop anything still running.
    for proc in list(jobs.values()):
        proc.terminate()


if __name__ == "__main__":
    main()
