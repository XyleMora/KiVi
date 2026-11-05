#!/bin/bash
# Regenerate the README screenshots (docs/screenshots/*.png) after UI changes.
#
#   tools/screenshots.sh [name …]     # all, or e.g. viewer-3d-net visual-diff
#
# Needs xvfb, gjs with WebKitGTK, the KiCad demo files (tools/fetch_demos.py)
# and KiCad's 3D library (KICAD3D, default /usr/share/kicad/3dmodels). No
# network and no sign-in: tools/screenshots-prelude.js answers GitHub and the
# desktop app from the demo files. Shots are 1440 px wide, dark UI, signed out.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
OUT=$ROOT/docs/screenshots
KICAD3D=${KICAD3D:-/usr/share/kicad/3dmodels}
PORT=${PORT:-8765}
[ -d tests/kicad-demos/cm5_minima ] || { echo "KiCad demo files missing: python3 tools/fetch_demos.py" >&2; exit 1; }
[ -d "$KICAD3D" ] || { echo "KiCad 3D library not found at $KICAD3D (set KICAD3D)" >&2; exit 1; }

# A web root with the pages, the demo files, KiCad's 3D library and the file lists.
WEB=$(mktemp -d)
SRV=
cleanup() {
  [ -n "$SRV" ] && kill "$SRV" 2>/dev/null
  rm -rf "${WEB:?}"
}
trap cleanup EXIT
for f in index.html diff.html inbox.html src vendor assets tests; do ln -s "$ROOT/$f" "$WEB/$f"; done
ln -s "$KICAD3D" "$WEB/kicad3d"
mkdir "$WEB/shots"
python3 - "$ROOT" "$WEB" "$KICAD3D" <<'EOF'
import json, os, sys
root, web, lib = sys.argv[1:]
cm5 = os.path.join(root, "tests/kicad-demos/cm5_minima")
files = sorted(os.path.relpath(os.path.join(d, f), cm5) for d, _, fs in os.walk(cm5) for f in fs)
demos = []
for line in open(os.path.join(root, "tests/kicad-demos.txt")):
    if line.startswith("#") or not line.strip():
        continue
    sha, size, path = line.rstrip("\n").split("\t")
    demos.append({"path": path, "sha": sha, "size": int(size)})
json.dump({"cm5": files, "demos": demos}, open(os.path.join(web, "shots/files.json"), "w"))
models = sorted(os.path.relpath(os.path.join(d, f), lib) for d, _, fs in os.walk(lib) for f in fs if f.lower().endswith((".wrl", ".step", ".stp")))
json.dump(models, open(os.path.join(web, "shots/kicad3d.json"), "w"))
EOF
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$WEB" >/dev/null 2>&1 &
SRV=$!
sleep 1

unset WAYLAND_DISPLAY
export GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1
rm -rf ~/.cache/gjs/WebKitCache # stale modules otherwise
PRELUDE=$(cat tests/tauri-mock.js tools/screenshots-prelude.js)
URL=http://127.0.0.1:$PORT

# browser <url> <out.png> [browser-check options…]
browser() {
  local url=$1 out=$2
  shift 2
  xvfb-run -a -s "-screen 0 1440x900x24" gjs -m tools/browser-check.js "$URL/$url" "$out" --prelude "$PRELUDE" --timeout 300000 "$@" 2>&1 | grep -E "^(saved|state|error|JS)" || true
}

# The WebKit profile keeps storage between runs: start and end without KiVi's caches.
CLEAR="localStorage.removeItem('kivi.projectIndex'); localStorage.removeItem('kivi.kicadRepos'); for (const d of ['kivi-thumbs', 'kivi-models']) indexedDB.deleteDatabase(d);"
clear_storage() { browser "assets/kivi-logo.svg" "$WEB/clear.png" --run "$CLEAR" --delay 500 >/dev/null; }

# Click the change whose label starts with $1, then zoom the after view to $2 with at least $3 mm.
pick() { echo "const b = [...document.querySelectorAll('#change-list button.chg')].find((x) => x.querySelector('.clabel').textContent.startsWith('$1')); b.click(); setTimeout(() => { const k = window.kiviDiff, c = k.res.diff.changes[k.selected]; k.after.zoomTo($2, $3); }, 900);"; }
CHANGES="document.querySelectorAll('#change-list button.chg').length > 0"
# True once the 3D status line has stopped changing for 10 s.
# (Nearly all of CM5_MINIMA_3's 74 models accounted for: a big STEP model can stall the count for 10 s.)
SETTLED="(() => { const t = document.querySelector('#status3d')?.textContent ?? ''; const n = (t.match(/\\d+/g) ?? []).reduce((a, b) => a + Number(b), 0); if (!/3D models/.test(t) || n < 70) return false; if (window.__t !== t) { window.__t = t; window.__since = Date.now(); return false; } return Date.now() - window.__since > 10000; })()"
TEST="gh=XyleMora/cm5_minima_test_repo"
# The gallery's first 15 cards have their thumbnails (or say why not); then scroll back to the top.
THUMBS="document.querySelectorAll('.project-card').length >= 15 && [...document.querySelectorAll('.project-card')].slice(0, 15).every((c) => c.querySelector('img') || /only|large/i.test(c.textContent))"
TOP="for (const e of [document.scrollingElement, ...document.querySelectorAll('*')]) if (e.scrollTop) e.scrollTop = 0;"

shoot() {
  case $1 in
    home-projects) browser "inbox.html#projects" "$OUT/$1.png" --wait "$THUMBS" --run "$TOP" --delay 1500 ;;
    pull-requests) browser "inbox.html#prs" "$OUT/$1.png" --size 1440x400 \
      --wait "document.querySelector('.kicad-badge.has-kicad')" --delay 1500 ;;
    viewer-schematic) browser "index.html#$TEST&tab=sch&net=/USB_C.D_P" "$OUT/$1.png" \
      --wait "document.body.innerText.includes('USB_C.D_P') && document.body.innerText.includes('Highlight on PCB')" --delay 2500 ;;
    viewer-pcb) browser "index.html#$TEST&tab=pcb&net=/USB_C.D_P" "$OUT/$1.png" \
      --wait "document.body.innerText.includes('USB_C.D_P') && document.querySelector('[data-tab=pcb][aria-selected=true]')" --delay 4000 ;;
    viewer-3d-net) browser "index.html#$TEST&tab=3d&net=/USB_C.D_P" "$OUT/$1.png" \
      --wait "$SETTLED && document.body.innerText.includes('USB_C.D_P')" --delay 3000 ;;
    pr-closes-issue) browser "diff.html#$TEST&pr=1&file=CM5_MINIMA_3.kicad_pcb&thread=i9" "$OUT/$1.png" \
      --wait "$CHANGES && document.querySelector('.cm-pin.issue') && document.body.innerText.includes('closes with this PR')" --run "$(pick M701 c.after 14)" --delay 3000 ;;
    viewer-issues) browser "index.html#$TEST&tab=pcb&thread=12" "$OUT/$1.png" \
      --wait "document.querySelector('.cm-pin.issue') && document.body.innerText.includes('shield tabs')" --delay 3000 ;;
    issues) browser "inbox.html#issues" "$OUT/$1.png" --size 1440x480 \
      --wait "document.querySelectorAll('.issue-row').length >= 3" --delay 1500 ;;
    visual-diff) browser "diff.html#$TEST&pr=1&file=CM5_MINIMA_3.kicad_pcb&thread=101" "$OUT/$1.png" \
      --wait "$CHANGES && document.querySelector('.cm-pin')" --run "$(pick U405 c.after 8)" --delay 3000 ;;
    diff-footprint) browser "diff.html#local=/home/designer/cm5_minima&file=CM5_MINIMA_3.kicad_pcb" "$OUT/$1.png" \
      --wait "$CHANGES" --run "$(pick U405 c.after 3)" --delay 2500 ;;
    diff-library-symbol) browser "diff.html#local=/home/designer/cm5_minima&file=IO.kicad_sch" "$OUT/$1.png" \
      --wait "$CHANGES" --run "$(pick CM5IO:LED 'c.boxesAfter[0]' 12)" --delay 2500 ;;
    review-comment) browser "index.html#$TEST&pr=XyleMora/cm5_minima_test_repo%231&tab=pcb&thread=101" "$OUT/$1.png" \
      --wait "document.querySelector('.cm-pin') && document.body.innerText.includes('paste stencil')" --delay 3000 ;;
    git-branch-menu) browser "index.html#folder=/home/designer/cm5_minima&project=CM5_MINIMA_3.kicad_pro&tab=pcb" "$OUT/$1.png" \
      --wait "document.querySelector('#branch-menu[data-kind=local]') && document.querySelector('#projbar')" \
      --run "document.querySelector('#branch-menu').open = true;" --delay 3000 ;;
    settings-kicad) browser "inbox.html#projects" "$OUT/$1.png" \
      --wait "$THUMBS && document.querySelector('[data-act=settings]')" \
      --run "$TOP document.querySelector('[data-act=settings]').click();" --delay 2500 ;;
    *) echo "unknown screenshot: $1" >&2; return 1 ;;
  esac
}

ALL="home-projects pull-requests issues viewer-schematic viewer-pcb viewer-3d-net viewer-issues visual-diff pr-closes-issue diff-footprint diff-library-symbol review-comment git-branch-menu settings-kicad"
clear_storage
for name in ${@:-$ALL}; do
  echo "== $name"
  shoot "$name"
done
clear_storage
