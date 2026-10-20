# KiVi — Tauri 2 desktop app

KiVi renders KiCad 6–10 projects (schematic, PCB, 3D, BOM) from GitHub
repositories or local folders, with a project gallery, a pull request inbox,
a visual diff and review comments pinned to parts/nets that are stored as
ordinary GitHub PR review comments. GitHub stays the backend for source
control, diffs and review comments.

README.md is the user-facing reference (features, build, GitHub App setup,
deep links, layout, test commands). Read it first; this file covers what the
README doesn't: conventions, environment and pitfalls.

## Stack and constraints

- The pages (`index.html` viewer, `diff.html` visual diff, `inbox.html` home)
  are plain ES modules: **no build step, no npm, no Node**. Tauri serves them
  from `dist/web`, which `tools/build_web.py` fills (it copies
  `index.html diff.html inbox.html src vendor assets`; a new top-level page or
  folder must be added there).
- All dependencies are vendored in `vendor/` (three.js 0.169, occt-import-js
  0.0.22); nothing loads from a CDN, and the CSP allows no remote scripts.
- `vendor/occt-import-js/occt-import-js.js` is **patched** (marked `KiVi patch`):
  embind's `new Function` invokers were replaced with closures because the CSP
  forbids `unsafe-eval`. Re-apply when updating it (see `vendor/README.md`).
- Parsers and renderers (`src/sexpr.js`, `src/sch/`, `src/pcb/render.js`,
  `src/pcb/texture.js`, `src/diff/`) have no DOM dependency so they run headless
  under gjs and in workers (`src/desktop/thumb-worker.js`); keep it that way.
- Code style: small modules, JSDoc on exported functions, comments explain *why*,
  British-ish UI wording ("colour"), sentence-case UI text.
- `src/desktop/` holds the Tauri integration; it's a no-op when
  `window.__TAURI__` is missing (`isDesktop`), which is what lets the pages run
  in a plain headless browser for tests.

## Desktop parts

- `inbox.html` + `src/desktop/inbox.js`: the home window, with two views
  switched by GitHub-style icon buttons in the header (`data-home`,
  `aria-pressed`, reachable as `inbox.html#projects` / `#prs`; each loads on
  first show, since both cost API requests). Watched repos (`watchRepos`) and
  recent local folders are in `#side`, a drawer from the right toggled by
  `#side-toggle` (`inert` while closed; closes on Escape or an outside click,
  after open menus/dialogs, which mark Escape handled with `preventDefault`).
  - **Projects** (`src/desktop/projects.js` + `thumb-worker.js`): a card grid of
    every `.kicad_pro` in reachable repositories, with board thumbnails. Caches:
    `kivi.projectIndex` in localStorage (per repository, keyed on `pushed_at`
    and the default branch) and the IndexedDB database `kivi-thumbs` (by blob
    SHA). 48 cards per page; boards over 30 MB get no thumbnail.
  - **Pull requests**: the GitHub search API, with a KiCad-files-changed badge
    per PR (from `/pulls/N/files`) and buttons to the visual diff, the viewer
    at the PR head, and github.com.
- `src/desktop/tauri.js`: `TauriSource` (a project folder read through Rust;
  the only local source), `onDrop` (Tauri takes file drops itself and reports
  paths as `tauri://drag-drop`; the page's HTML drop events get no files), link routing (http(s) links open in the system browser, `target=_blank` app
  links navigate in place), GitHub sign-in dialog, token refresh.
- `src/desktop/account.js`: the header shared by all three pages. `initHeader()`
  adds the home icons (the home page has its own switch) and the account menu
  (`<details class="menu">`, closed on outside click or Escape): sign in,
  profile, repository access, Settings, sign out. It owns the only Settings
  dialog (dark schematic `schDark`, `modelSources`, `loadModels`) and fires
  `kivi:settings` on save (the schematic tab applies dark mode live). Shared
  app code asks for a sign-in with `window.dispatchEvent(new Event("kivi:signin"))`
  (the review panel's "Sign in with GitHub" links), so it needs no Tauri import.
  Signing in or out reloads the viewer/diff page and refreshes the home page.
- `src/desktop/desktop.js`: loaded after `main.js` / `diff.js`. Mounts the
  header, makes "Open" with an empty repository box show the native folder
  picker (also on the home page), adds drag and drop, live reload on
  `folder-changed` (keeps tab, sheet and selection) and
  `index.html#folder=<path>[&project=…]`.
- `src-tauri/src/lib.rs` commands:
  - `open_folder` (lists the folder and starts a 500 ms debounced watcher that
    emits `folder-changed` for KiCad and model files)
  - `list_folder`
  - `read_file` (raw bytes, restricted to the open folder)
  - `startup_folder` (CLI argument, handled once per session by the inbox)
  - `github_client_id` / `github_app_slug` (compile-time env)
  - `github_device_start` / `github_device_poll` / `github_device_refresh` (device
    flow; github.com/login/* has no CORS, hence Rust; reqwest with rustls)

## GitHub sign-in (a GitHub App, not an OAuth App)

- Build-time env: `KIVI_GITHUB_CLIENT_ID=Iv23li…` and
  `KIVI_GITHUB_APP_SLUG=<url-name>`. Otherwise the dialog asks and stores
  `githubAppClientId` / `githubAppSlug` in settings (a new key on purpose: an
  old OAuth App `oauthClientId` is ignored, so the user is asked again).
- **Sign-in is the only way to give GitHub access**: there's no token field. The
  token goes to settings `token` (read by every page) with `githubAuth` (refresh
  token, expiry times, and the token it belongs to). A `token` without a
  matching `githubAuth` (pasted in Settings by earlier versions) is removed when
  a page loads (`tauri.js`). User tokens expire after 8 h and are refreshed by
  `ensureFreshToken()` (timer, page load, window focus).
- Status: the dialog flow was tested headless with a mocked `window.__TAURI__`.
  A real sign-in against GitHub hasn't been confirmed; ask the user whether a
  GitHub App is registered before assuming it works.

## GitHub integration notes

- Don't cache failures as empty results (the "no KiCad files" sessionStorage
  cache, the project index, thumbnails).
- Review comment markers: `<!-- kivi:{json} -->` after a `<sub>📍 KiVi · …</sub>`
  footer; `src/review.js` encodes and decodes both (`tests/review.js`).
- New comments carry no link in their footer (just "📍 KiVi · <what>");
  `encodeBody` still accepts one.

## 3D models

Settings key `modelSources` (list of URL prefixes, GitHub repos and local
folders; replaced the old single `modelBase`, which is still read). The default
is the web mirror; a folder (e.g. `/usr/share/kicad/3dmodels`, KiCad 10.0.6 is
installed here: 7,251 STEP files, no VRML) is only used when the user adds it
(Settings → **Add folder…**; no auto-detection, on purpose).
Folder sources are read through `list_model_dir` / `read_model_file` in
`lib.rs` (model extensions only, inside that folder; tested by `cargo test`),
via `ModelDirSource` (`tauri.js`), which `desktop.js` hands to the resolver as
`app.openModelDir`; in a plain browser they're skipped with a toast. Resolution order is in
`makeModelResolver` (`src/sources.js`) and covered by `tests/models.js`
(the user chose it): always the project first (its exact relative path, then a
search by file name), then folder sources, then web sources (URL prefixes,
GitHub repos), each group in list order, whatever the order in Settings. This
holds for `${KICADn_3DMODEL_DIR}` paths too, and handles `/Users/…`, `C:\…`,
`${KICAD_3RD_PARTY}` paths. The 3D view uses three.js
`TrackballControls` (free rotation; preset views reset `camera.up`).

## Build and run

Rust is installed via rustup in `~/.cargo` **without** a PATH change in the
shell profile, so prefix commands:

```sh
export PATH=$HOME/.cargo/bin:$PATH
cargo tauri dev                 # runs tools/build_web.py → dist/web, then the app
cargo tauri build               # release + AppImage: src-tauri/target/release/bundle/appimage/
```

- Linux system deps are installed (libwebkit2gtk-4.1-dev, libxdo-dev,
  libayatana-appindicator3-dev, librsvg2-dev). They need sudo, which you don't
  have: ask the user to run apt.
- A first build takes about 5 min. Rebuilds take about 2 min, mostly LTO
  (`profile.release`: lto, opt-level "s", strip).
- Windows: `src-tauri/tauri.windows.conf.json` (merged by Tauri on Windows)
  switches to an NSIS installer and `python` (Windows has no `python3`). It's
  built only in CI, on tags and manual runs, and has never been run by hand:
  nothing Windows-specific was tested locally. `src-tauri/icons/icon.ico` (from
  `tools/make_icons.py`) is required for the Windows build.
- The user runs the **AppImage**: rebuild after every change and tell them to
  restart it. A stale AppImage looks like "the fix didn't work".
- `tauri.conf.json` CSP:
  - `script-src 'self' 'wasm-unsafe-eval'`
  - `connect-src https:` (model sources can be any host)
  - `style-src 'unsafe-inline'` (the pages use style attributes)
  - `img-src` / `worker-src` allow `blob:` (thumbnails, the thumbnail worker)
- Plugin permissions are in `capabilities/default.json`: `dialog:allow-open`,
  `opener:default`.
- Logo: `assets/kivi-logo.svg` is the only logo file, drawn in the brand orange
  `#f0a63b` (`--accent` in `style.css`) with `#fff` details. The page headers load it as `<img class="brand-mark">`, which
  `src/app/logo.js` swaps for the inlined SVG with `#f0a63b` → currentColor
  (the brand orange) and `#fff` → `var(--surface)` (the header); keep those two
  colours in the file or extend the mapping. `python3 tools/make_icons.py`
  renders `src-tauri/icons/*.png` from it; rerun that after editing the logo.

## Licence

GPL-3.0-or-later (`LICENSE`; `license` in `Cargo.toml` and `tauri.conf.json`).
`THIRD-PARTY-NOTICES.md` is generated by `tools/notices.py` from `vendor/` and
`cargo metadata` and bundled as a Tauri resource; rerun it after changing
`Cargo.lock` or a vendored package (CI runs `--check`). New dependencies must be
GPL-3.0-compatible and keep their licence file. The AppImage's system libraries
are listed per release by `notices.py --appdir` in CI.

## Tests

```sh
python3 tools/fetch_demos.py                 # KiCad demo files → tests/kicad-demos (skips intact ones)
gjs -m tests/run.js                          # parse+render all KiCad demos
gjs -m tests/diff.js
gjs -m tests/nets.js
gjs -m tests/review.js                       # GitHub API layer, mocked
gjs -m tests/models.js                       # 3D model path resolution order
cargo test --manifest-path src-tauri/Cargo.toml --lib   # Rust: model folder access (not in CI)
tests/smoke.sh                               # pages load cleanly, viewer opens pic_programmer (~15 s)
```

- The tests never read a KiCad installation. `tests/kicad-demos.txt` (committed,
  generated by `fetch_demos.py --refresh <tag>` from one GitHub API call) pins
  the KiCad tag (10.0.6) and lists the 170 design files the tests read (no
  models/PDFs/Gerbers, nothing over 20 MB) with git blob hashes; the script
  downloads them from `raw.githubusercontent.com/KiCad/kicad-source-mirror`
  and verifies each. `tests/gjs-fs.js` `kicadDemos()` finds them and exits
  with a hint if they're missing. This machine's connection is slow
  (~0.2 MB/s): a full fetch takes ~6 min here.
- CI is `.github/workflows/ci.yml` (see README): tests (also on PRs) → Linux build (artifact; pushes to main, tags, manual runs)
  → GitHub Release on `v*` tags. Keep its commands in sync with this list;
  it was written without a way to run it locally (no act/actionlint here), so
  the first run on GitHub is its real test.
- `kicad-cli` (KiCad's own SVG export, for `tools/compare.py`) is the one
  optional, manual check that needs KiCad installed.

UI logic is checked in WebKitGTK with `tools/browser-check.js`, against the
pages served over HTTP with the Tauri API mocked by `tests/tauri-mock.js`
(`--prelude` runs before the page's scripts; set `window.__tauriReplies` in the
prelude to answer commands, and `__tauriEmit(event, payload)` to fire events
such as `tauri://drag-drop`):

```sh
python3 -m http.server 8765 & SRV=$!
LIBGL_ALWAYS_SOFTWARE=1 xvfb-run -a gjs -m tools/browser-check.js \
  "http://127.0.0.1:8765/inbox.html#projects" out.png \
  --prelude "$(cat tests/tauri-mock.js)" --wait "<js>" --run "<js>" --result "<js>"
kill $SRV
```

The built app itself can run under xvfb (X11), with app data in the scratchpad
so the user's `~/.local/share/app.kivi.desktop` stays clean:

```sh
unset WAYLAND_DISPLAY; export GDK_BACKEND=x11
export XDG_DATA_HOME=$TMP XDG_CONFIG_HOME=$TMP XDG_CACHE_HOME=$TMP LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
xvfb-run -a -s "-screen 0 1440x900x24" bash -c 'src-tauri/target/release/kivi-desktop /path/to/project & PID=$!; sleep 20; <screenshot>; kill $PID'
```

- No screenshot tool is installed. Grab the root window with a small PyGObject
  script: `Gdk.get_default_root_window()` plus `Gdk.pixbuf_get_from_window(...)`
  plus `savev(png)`. You can't click inside the real app; use browser-check.
- For live reload, rewrite a `.kicad_sch` (copy to `.tmp`, then `mv` it back)
  and screenshot several times within 4 s. The "Reloaded: … changed" toast only
  lasts 2.5 s.

## Environment pitfalls (learned the hard way)

- The desktop session is Wayland (`WAYLAND_DISPLAY`, `GDK_BACKEND=wayland`). For
  anything GTK under xvfb, run `unset WAYLAND_DISPLAY; export GDK_BACKEND=x11`
  or windows appear on the user's real screen.
- Stop test servers **by PID** (`python3 -m http.server 8765 & SRV=$!; …; kill $SRV`).
  `pkill -f "http.server 8765"` matches your own shell command, kills it, and
  skips the cleanup after it. Start the server as its own command
  (`cd` first, on a separate line): in `cd dir && python3 -m http.server & SRV=$!`
  the `&` backgrounds the whole `cd && …` list, `$!` is the subshell, and
  `kill $SRV` leaves the server running. That once left scratchpad symlinks
  (`testboard-tmp`, `testrepo-tmp`) in the repository; their deletion is not
  committed yet.
- WebKit's HTTP cache (`~/.cache/gjs/WebKitCache`) serves stale modules after
  edits: `rm -rf` it before each headless run.
- browser-check's WebKit profile keeps localStorage and IndexedDB between runs:
  never store real or fake tokens there (override `Storage.prototype.getItem`
  in the prelude to fake settings), and clear `kivi.projectIndex` /
  `kivi-thumbs` after gallery tests.
- browser-check screenshots only the visible area; a blank screenshot with the
  DOM looking fine usually means an element is covering the page (see the CSS
  pitfall below), not a rendering limit.
- CSS: `src/app/style.css` has global classes such as `.loading` (a fixed
  full-screen overlay) and `.tab`. Don't reuse those names in desktop markup.
  Keep DOM ids unique across `src/desktop/` and the pages (two `id="signin"`
  once made a button silently do nothing), and surface promise rejections with
  `toast`.
- Unauthenticated GitHub API = 60 requests/hour per IP, shared by the user and
  your tests, and easily exhausted. `codeload.github.com` tarballs and
  `raw.githubusercontent.com` aren't limited.
- No `gh` CLI and no GitHub token on the machine. Writing review comments and
  the signed-in gallery listing have only been tested against mocks.

## README screenshots

`docs/screenshots/*.png` were taken with `tools/browser-check.js` at 1440×900,
signed out (the user asked for no signed-in account in them), on public data:
`XyleMora/cm5_minima_test_repo` and `KiCad/kicad-source-mirror` as watched
repositories; PR #1 has a real KiVi comment on R404 in `CM5.kicad_sch`. The
prelude was `tests/tauri-mock.js` plus settings faked in memory and KiCad demo
boards served from `tests/kicad-demos` (slow connection). A full set costs
~25 unauthenticated API requests of the 60/hour; wait for 3D with a "status
unchanged for 10 s" condition, not the first "loaded" text.

## Test data

- The user's test repo is https://github.com/XyleMora/cm5_minima_test_repo. PR
  #1 has CM5_MINIMA_3: board plus 8 sheets, 75 3D models (16 genuinely
  unavailable), and the HDMI connector J501 uses
  `${KIPRJMOD}/CM5IO.3dshapes/471511051.stp`.
- `KiCad/kicad-source-mirror` stress-tests the gallery: 388 projects, mostly QA
  data, including an 85 MB Jetson board.

## Working with this user

- Requests are short and often come with a screenshot; reproduce the exact
  scenario before changing code.
- Verify headless and show what was checked; say plainly what could not be
  verified (live GitHub writes, a real GitHub App sign-in, the real app window).

## Not done yet

- Tokens are in localStorage, not the OS keychain.
- No diff of the local working copy against the PR head (`TauriSource` would be
  the head source for `diff.html`).
- No auto-update, code signing or file associations.
