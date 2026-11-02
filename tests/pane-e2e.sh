#!/bin/sh
# Live pane e2e: a real lavish-axi session driven through the mod, on a
# herdr space this script creates and closes itself. Nothing else is touched.
#
#   tests/pane-e2e.sh
#
# Needs: herdr-app running, lavish-axi, jq, curl. Prints
# "all pane e2e cases passed" on success.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/lavish-pane-e2e.XXXXXX")
trap 'cleanup' EXIT
space=""

cleanup() {
  if [ -n "$space" ]; then
    herdr-app do space.close --id "$space" --confirmed true >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
}

command -v herdr-app >/dev/null 2>&1 || { echo "skip: herdr-app not found"; exit 0; }
command -v lavish-axi >/dev/null 2>&1 || { echo "skip: lavish-axi not found"; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }
herdr-app status >/dev/null 2>&1 || { echo "skip: no herdr window"; exit 0; }

art=$work/artifact.html
dump=$work/dump.json
cat >"$art" <<'HTML'
<!doctype html><html><head><meta charset="utf-8"><title>e2e</title></head>
<body><h1>Lavish pane e2e</h1><p>An artifact is arbitrary HTML.</p></body></html>
HTML

# 1. Start the session without a browser.
out=$(LAVISH_AXI_NO_OPEN=1 lavish-axi "$art" --no-open)
url=$(printf '%s\n' "$out" | jq -r '.session.url // empty' 2>/dev/null || true)
if [ -z "$url" ]; then
  url=$(printf '%s\n' "$out" | sed -n 's/.*"*url"*[[:space:]]*:[[:space:]]*"\([^"]*\/session\/[^"]*\)".*/\1/p' | head -n 1)
fi
[ -n "$url" ] || { echo "fail: no session url in lavish-axi output"; exit 1; }
key=${url##*/}

# 2. Open the pane on our own space, driving the mod through steps replay.
space_json=$(herdr-app do space.new --name "lavish-e2e-$$")
space=$(printf '%s' "$space_json" | jq -r '.space // .id // empty')
[ -n "$space" ] || { echo "fail: no space id from space.new: $space_json"; exit 1; }
props=$(jq -cn --arg url "$url" --arg dump "$dump" \
  '{url: $url, dump: $dump, steps: [["queue", "pane feedback works"], ["sendEnd"]]}')
herdr-app do tab.new --space "$space" --name Lavish --mod lavish --props "$props" >/dev/null

# 3. Wire parity: the same POST the browser chrome makes (with Origin) is
#    accepted, and the pane shows the message through its live update path.
origin=$(printf '%s' "$url" | sed -E 's#(https?://[^/]+).*#\1#')
code=$(curl -s -o "$work/curl.json" -w '%{http_code}' -X POST "$origin/api/$key/prompts" \
  -H "Content-Type: application/json" -H "Origin: $origin" \
  -d '{"prompts":[{"uid":"","prompt":"browser says hi","selector":"","tag":"message","text":"Freeform message"}],"domSnapshot":""}')
[ "$code" = "200" ] || { echo "fail: parity POST returned $code: $(cat "$work/curl.json")"; exit 1; }

wait_dump() { # wait_dump <timeout_s> <jq condition>
  i=0
  while [ $i -lt "$1" ]; do
    if [ -s "$dump" ] && jq -e "$2" "$dump" >/dev/null 2>&1; then return 0; fi
    i=$((i + 1)); sleep 1
  done
  echo "fail: timed out waiting for: $2"; [ -s "$dump" ] && cat "$dump"; exit 1
}

# The pane sees the browser's message (WS or polling fallback).
wait_dump 20 'any(.chat[]?; .role == "user" and .text == "browser says hi")'

# 4. The steps replay queues feedback and sends it with endSession.
wait_dump 30 '.state.name == "sent"'
jq -e 'any(.chat[]?; .role == "user" and .text == "pane feedback works")' "$dump" >/dev/null ||
  { echo "fail: pane feedback missing from chat"; cat "$dump"; exit 1; }

# 5. The server agrees the session ended (parsed with the mod's own parser).
curl -s "$origin/session/$key" >"$work/page.html"
ended=$(node "$here/tests/helpers/session-ended.mjs" "$work/page.html") ||
  { echo "fail: session page no longer parses"; exit 1; }
[ "$ended" = "true" ] || { echo "fail: session not ended after Send & End"; exit 1; }

echo "all pane e2e cases passed"
