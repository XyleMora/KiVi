#!/usr/bin/env bash
# Smoke test of the pages in headless WebKitGTK, with the Tauri API mocked
# (tests/tauri-mock.js) and no network: each page must load without script
# errors and show its header; the viewer must open KiCad's pic_programmer demo
# as a local folder (needs `python3 tools/fetch_demos.py` first).
#
#   tests/smoke.sh          (needs gjs, WebKit2GTK 4.1 typelibs, xvfb-run)
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-8799}
DEMO=tests/kicad-demos/pic_programmer
[ -f "$DEMO/pic_programmer.kicad_pro" ] || { echo "run  python3 tools/fetch_demos.py  first" >&2; exit 2; }

OUT=$(mktemp -d)
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$OUT"' EXIT
for _ in $(seq 50); do curl -sf "http://127.0.0.1:$PORT/" >/dev/null && break; sleep 0.1; done

rm -rf ~/.cache/gjs/WebKitCache # stale modules otherwise
unset WAYLAND_DISPLAY
export GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1

# The "folder" is the demo, served by the same HTTP server.
FILES=$(cd "$DEMO" && find . -type f | sed 's|^\./||' | python3 -c 'import json, sys; print(json.dumps(sys.stdin.read().split()))')
PRELUDE="$(cat tests/tauri-mock.js)
window.__errors = [];
addEventListener('error', (e) => __errors.push(e.message));
addEventListener('unhandledrejection', (e) => __errors.push(String(e.reason?.message ?? e.reason)));
window.__tauriReplies = {
  open_folder: () => $FILES,
  list_folder: () => $FILES,
  read_file: async ({ path }) => (await fetch('/$DEMO/' + path)).arrayBuffer(),
};"

failed=0
check() { # name, page, condition that must become true
  local name=$1 page=$2 ready=$3 out
  out=$(xvfb-run -a gjs -m tools/browser-check.js "http://127.0.0.1:$PORT/$page" "$OUT/$name.png" \
    --size 1280x800 --timeout 60000 --delay 500 --prelude "$PRELUDE" --wait "$ready" \
    --result "(${ready}) && !__errors.length ? 'ok' : 'FAIL ' + JSON.stringify({ ready: !!(${ready}), errors: __errors })" 2>&1) || true
  if grep -q "^result: ok$" <<<"$out" && ! grep -q "CONSOLE JS ERROR" <<<"$out"; then
    echo "ok    $name"
  else
    echo "FAIL  $name"
    sed 's/^/      /' <<<"$out"
    failed=1
  fi
}

check home "inbox.html#projects" "document.querySelector('.account-menu') && document.querySelector('svg.brand-mark') && document.querySelector('#projects-status').textContent"
check pull-requests "inbox.html#prs" "document.querySelector('.account-menu') && !document.querySelector('#home-prs').hidden"
check viewer "index.html#folder=/demo/pic_programmer" "window.kivi?.project?.name === 'pic_programmer' && kivi.project.pages.length === 2 && kivi.project.pcb?.footprints.length > 0 && document.querySelector('#sch-canvas svg') && document.querySelector('.account-menu')"
check diff "diff.html" "document.querySelector('.account-menu') && document.querySelector('svg.brand-mark')"

exit $failed
