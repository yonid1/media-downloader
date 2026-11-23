#!/bin/bash
# Connects the extension to yt-dlp (needed only for YouTube downloads).
# Run once:  bash install.sh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="com.mediadownloader.ytdlp"
EXT_ID="eepeakkkmgdnnhhbehdhmhneabojamif"

# macOS doesn't let programs started by Chrome read Documents, Desktop or Downloads,
# so the bridge is copied to a folder it can always reach.
APP_DIR="$HOME/Library/Application Support/MediaDownloader"
HOST_PATH="$APP_DIR/host.py"
mkdir -p "$APP_DIR"
cp "$DIR/native-host/host.py" "$HOST_PATH"
chmod +x "$HOST_PATH"
echo "✓ הגשר ל-yt-dlp הועתק אל: $APP_DIR"

MANIFEST=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Media Downloader - yt-dlp bridge",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
)

registered=0
for browser in "Google/Chrome" "Google/Chrome Beta" "Google/Chrome Canary" "Chromium" \
               "BraveSoftware/Brave-Browser" "Microsoft Edge" "Arc/User Data"; do
  base="$HOME/Library/Application Support/$browser"
  if [ -d "$base" ]; then
    mkdir -p "$base/NativeMessagingHosts"
    printf '%s\n' "$MANIFEST" > "$base/NativeMessagingHosts/$HOST_NAME.json"
    echo "✓ חובר לדפדפן: $browser"
    registered=1
  fi
done
if [ "$registered" = 0 ]; then
  echo "✗ לא נמצא כרום במחשב הזה."
  exit 1
fi

missing=()
for tool in yt-dlp ffmpeg deno; do
  if command -v "$tool" >/dev/null 2>&1 || [ -x "/opt/homebrew/bin/$tool" ] || [ -x "/usr/local/bin/$tool" ]; then
    echo "✓ $tool מותקן"
  else
    missing+=("$tool")
  fi
done

if [ ${#missing[@]} -eq 0 ]; then
  echo
  echo "הכל מוכן. טענו מחדש את התוסף בכרום (chrome://extensions ← סמל הרענון)."
  exit 0
fi

BREW=""
for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && BREW="$b"; done
if [ -z "$BREW" ]; then
  echo
  echo "חסרים: ${missing[*]}"
  echo "כדי להתקין אותם צריך קודם את Homebrew. הריצו את הפקודה מהאתר https://brew.sh"
  echo "ואחרי שהיא מסתיימת, הריצו שוב:  bash \"$DIR/install.sh\""
  exit 1
fi

echo
echo "מתקין עם Homebrew: ${missing[*]}"
"$BREW" install "${missing[@]}"
echo
echo "הכל מוכן. טענו מחדש את התוסף בכרום (chrome://extensions ← סמל הרענון)."
