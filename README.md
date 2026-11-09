<img src="assets/kivi-logo.svg" width="120" alt="KiVi logo: a kiwi with a circuit board inside">

# KiVi: view, compare and review KiCad projects

[![Built with Claude Code](https://img.shields.io/badge/Built_with-Claude_Code-D97757?logo=claude&logoColor=white)](https://claude.com/claude-code)

**KiVi turns the KiCad projects in your GitHub and GitLab repositories, or on
your disk, into something you can actually look at.** Any source control forge shows a changed
`.kicad_pcb` as thousands of lines of S-expressions; reviewing it usually
means checking out both versions and flipping between KiCad windows. In KiVi,
schematics, boards and 3D views open in seconds, a visual diff tells you what
changed in KiCad terms, and comments pinned to parts and nets make a board
change as easy to review as a code change.

- **Nothing to set up on a server.** GitHub or GitLab stays your
  source control, diff and review system; KiVi is a desktop app that parses
  and renders everything locally.
- **Nothing to install.** One `.AppImage` on Linux, one `.exe` on Windows,
  one `.dmg` on macOS.
- **No account needed to play around.** Public repositories work signed out;
  sign in to GitHub or GitLab (one at a time) for private repositories and the
  full review features.
- **You are in control of access.** GitHub sign-in uses a GitHub App with
  fine-grained permissions, and you choose which repositories it can read;
  GitLab sign-in uses an OAuth application.
- **KiCad 6 to 10.** Tested against the demo projects that ship with KiCad 10.

## What you get

*Screenshots show [CM5 MINIMA REV3](https://github.com/piecol/CM5_MINIMA_REV3)
by Pierluigi Colangeli (CERN-OHL-S-2.0), from KiCad's demo projects. The
changes, review comments and issues in them were made up for these examples.*

**🗂 Every project at a glance.** KiVi finds every KiCad project in the
repositories you can reach and in folders you add, and shows each as a card
with a rendered board thumbnail. One click opens its schematic, PCB, 3D view
or BOM.

![Home screen: a gallery of KiCad projects with rendered board thumbnails](docs/screenshots/home-projects.png)

**🔍 Viewing, cross-probing and more.** Click a symbol to see its fields and
every pin with its net, or a wire to select the whole net. **Highlight on PCB** shows
that net on the board, with its length, layers and vias; **Show in 3D** lights
it up and turns the camera to the side it's routed on. Switch PCB layers one
by one, flip to the bottom, and measure between pads, vias and model corners
(key **M**).

![Schematic: the net USB_C.D_P selected next to the USB-C connector, with its pins listed](docs/screenshots/viewer-schematic.png)

![PCB: the same net /USB_C.D_P highlighted, 21 mm of track on both copper layers with 2 vias and 4 pads](docs/screenshots/viewer-pcb.png)

![3D: the same net highlighted in yellow on the board, seen from the top](docs/screenshots/viewer-3d-net.png)

**🧮 A diff that speaks KiCad.** Compare a pull request, a commit, two
branches, or your uncommitted local work. KiVi lists changes the way a designer
thinks about them and marks each one on both versions side by side:

- *Schematic:* which pins joined or left each net; parts added, removed or
  edited; library symbols whose pinout, pin types or body changed, with every
  part that uses them.
- *Board:* parts moved, rotated, flipped or re-wired; what changed inside a
  footprint (pads, drills, mask and paste overrides, 3D models, silkscreen);
  routing, vias, zones, outline and stackup.
- *Design rules:* a table of what changed in the `.kicad_pro` and `.kicad_dru`.
- *Not a change:* redrawn wires that connect the same pins, re-annotation,
  refilled zones, or the pads of a part that merely moved.

Here a footprint was updated from a corrected library: four pads got longer,
pad 1 got a solder mask override, the 3D model went from VRML to STEP and a
pin-1 mark was added to the silkscreen.

![Visual diff of a board: U405's pads, mask margin, 3D model and silkscreen changes listed and marked](docs/screenshots/diff-footprint.png)

And here the LED symbol's anode and cathode were swapped in the library: KiVi
reports it once, with both LEDs that use it and the nets that changed.

![Visual diff of a schematic: the LED library symbol's swapped pins and the nets that changed](docs/screenshots/diff-library-symbol.png)

**💬 Review where the problem is.** Press **C** and click a footprint, pad,
net or symbol to comment on it. Comments are ordinary pull request review
comments on GitHub (discussions on a merge request's file on GitLab), so your
team sees them there too, and they stay pinned to the part across later
pushes. Outside a pull request the same pin opens an issue: a hardware change
request that a later pull request can close
([see how](#reviewing-hardware-pull-requests-and-issues)).

![PCB at a pull request's head: review comment 1 open on U405, change request #12 pinned in green](docs/screenshots/review-comment.png)

**🌿 Git without the git.** Download a project, make a branch, edit in KiCad
(KiVi reloads as you save), then commit, push and open a pull or merge request
from one menu, with git built in. KiCad files don't merge reliably as text, so KiVi
never merges a file both sides changed; it keeps your work safe on a branch
instead.

![Branch menu of a local copy: New branch, Commit, Push 1 commit and Pull, above the branch list](docs/screenshots/git-branch-menu.png)

**🔗 Works with your KiCad.** Link your KiCad installation and KiVi loads 3D
models from your library exactly as KiCad does, and **Open in KiCad** opens the
project in one click.

![Settings: KiCad 10.0.6 linked, with its 3D model and add-on folders](docs/screenshots/settings-kicad.png)

## Reviewing hardware: pull requests and issues

KiVi gives a team two ways to talk about a design, both pinned to the part,
pad or net they're about and both stored on GitHub (or GitLab: there a pull
request is a merge request, a review comment a file discussion), so nothing
lives only in KiVi:

| | Review comment | Change request |
|---|---|---|
| **For** | Discussing a proposed change before it's merged | Asking for a change to the design as it is |
| **Made in** | A pull request: its visual diff, or the viewer at its head (**Hardware**) | A branch of a GitHub or GitLab project, or a local copy linked to one |
| **How** | Press **C** (**Comment**) and click | Press **C** (**Request change**), click, give it a title |
| **On GitHub it's** | A review comment on the `.kicad_sch` / `.kicad_pcb` file, in the pull request's conversation and *Files changed* | An issue labelled `kivi`, in the repository's Issues |
| **On GitLab it's** | A discussion on that file of the merge request, in its *Overview* and *Changes* | An issue labelled `kivi`, in the project's Issues |
| **Done when** | Resolved, in KiVi or on the forge | Closed; a pull request whose description says "Fixes #N" ("Closes #N" on GitLab) closes it when merged |
| **Listed in** | The pull request's side panel | The schematic and PCB side panels, KiVi's home **Issues** view, the forge |
| **Pins** | Numbered 1, 2, 3… in orange | Issue numbers (#12) in green |

### Reviewing a pull request

1. **Find it.** The home screen's pull request view lists the open pull
   requests in your projects, each saying how many KiCad files it changes.
   **Visual diff** opens it; **Hardware** opens the viewer at its head.

   ![Pull requests: a remote project's open pull request, which changes 3 KiCad files](docs/screenshots/pull-requests.png)

2. **Review it.** Go through the change list; each item zooms to the change
   on both versions. Press **C**, click what you have a question about and
   write it: here a question about U405's longer pads, pinned to U405. The
   author answers and resolves it in KiVi or on github.com, where it's an
   ordinary review comment. The repository's open change requests show up
   too, in green, since the pull request may be what fixes them.

   ![Visual diff of a pull request with a review comment open on U405 and two change requests listed](docs/screenshots/visual-diff.png)

### Requesting a change with an issue

1. **Pin a request to the hardware.** In the viewer on any branch, press
   **C**, click the part, pad or net, and give the request a title: here #12
   asks to move the HDMI connector J501, and has a reply underneath. Anyone
   with access to the repository sees it in KiVi or in the repository's
   Issues on GitHub or GitLab.

   ![PCB with change request #12 open on the HDMI connector J501](docs/screenshots/viewer-issues.png)

2. **Keep track of them.** The home screen's **Issues** view gathers the open
   change requests of all your projects, each saying what it's pinned to;
   **Hardware** opens it right there.

   ![Issues: four open change requests, pinned to J501, the +5V net, M701 and D605](docs/screenshots/issues.png)

3. **Fix it in a pull request.** The pull request that drills M701 bigger says
   "Fixes #9" in its description, so in its visual diff issue #9 is marked
   *closes with this PR*: the reviewer sees the request next to the change
   that answers it, and GitHub closes the issue when the pull request is
   merged. For the other issues, **Close with this PR** adds the "Fixes #N"
   line for you (signed in). GitLab works the same, with merge requests and
   "Closes #N".

   ![Visual diff of the pull request with issue #9 open on M701: closes when this pull request is merged](docs/screenshots/pr-closes-issue.png)

## Try it in five minutes

1. **Get KiVi.** Download it from the
   [Releases page](https://github.com/XyleMora/KiVi/releases): on Linux the
   AppImage (`chmod +x KiVi_*.AppImage`, then run it); on Windows
   `KiVi_<version>_x64.exe` (run it; it isn't code-signed yet, so SmartScreen
   asks once: *More info* → *Run anyway*); on macOS `KiVi_<version>_universal.dmg`
   (drag KiVi to Applications; it isn't notarised yet, so the first time it's
   blocked: *System Settings* → *Privacy & Security* → *Open Anyway*). Or
   [build it](#building) yourself.
2. **Add a public project.** In **Projects**, click **+** → **Remote
   project…** and enter `greatscottgadgets/hackrf` (the HackRF One software
   defined radio, on GitHub), `https://gitlab.com/riglol/lapod` (LVDS
   breakout boards, on GitLab), or any public repository with KiCad projects.
   No sign-in needed.
3. **Look around.** Open its card: click parts in the schematic, cross-probe
   to the PCB, measure something, spin it in 3D.
4. **See what changed.** Open **History** in the project bar, pick a commit
   that touched the hardware and press **Visual diff**. In your own
   repositories, the pull request icon in the header lists the open pull (or
   merge) requests the same way.
5. **Bring your own.** **+** → **Local project…** adds a folder from your
   computer. Edit it in KiCad, save, and press **Visual diff** to see your
   uncommitted changes the way a reviewer would.
6. **Sign in** (account menu, top right, then GitHub or GitLab) to see your
   private repositories and the pull requests waiting for your review, and to
   comment. KiVi is signed in to one of them at a time.

### Help us test it

KiVi is young and we'd love to hear how it does on your projects: boards it
draws wrong, diffs that miss a change or report noise, anything confusing.
[Open an issue](https://github.com/XyleMora/KiVi/issues) with the KiCad
version and, if you can, the file. Good to know before you start:

- Linux is where it's used day to day. The Windows build is made by CI and
  hasn't been tried much by hand. The macOS build has been tried by hand on
  Apple Silicon (macOS 27, KiCad 10.0.1: viewer, 3D with the linked KiCad's
  models, Open in KiCad, GitHub sign-in); not yet on Intel.
- See [Known limitations](#known-limitations) for what KiVi doesn't do yet.

## Using KiVi

The [user guide](docs/README.md) covers every feature in detail:
[Projects](docs/README.md#projects) · [Schematic, PCB and 3D](docs/README.md#schematic-pcb-and-3d) · [Visual diff](docs/README.md#visual-diff) · [Pull requests](docs/README.md#pull-requests) · [Review comments on pull requests](docs/README.md#review-comments-on-pull-requests) · [Change requests as issues](docs/README.md#change-requests-as-issues) · [Local copies, branches and pushing](docs/README.md#local-copies-branches-and-pushing) · [Linking KiCad](docs/README.md#linking-kicad) · [Signing in to GitHub and GitLab](docs/README.md#signing-in-to-github-and-gitlab) · [Links into the viewer](docs/README.md#links-into-the-viewer) · [How the gallery stays fast](docs/README.md#how-the-gallery-stays-fast).

## Known limitations

- **3D models embedded in KiCad 9+ files** (`kicad-embed://…`) aren't read
  yet; such parts show without a model unless a file with the same name is in
  the repository.
- **KiCad 9 padstacks** (different pad shapes on inner layers) are drawn with
  the outer layers' shape.
- Text uses a regular sans font scaled to KiCad's metrics instead of KiCad's
  stroke font (the newstroke font data is GPL-2.0, so it is not bundled).
  Layout and anchoring match, but glyph shapes differ.
- Schematic nets are traced per sheet (wires, junctions, labels, pins) and
  mapped to board nets through component pins; the name shown is the board's
  when there is one. Buses aren't traced, and the diff doesn't follow a net
  through a global label on another sheet.
- The default 3D model source is the KiCad 6-era GitHub mirror of
  `kicad-packages3D`; models added in later KiCad versions need KiCad linked in
  Settings or another model source. A GitHub repository model source is
  listed once through the API, so it counts against the rate limit. The first
  view of a board with many STEP models is slow (KiCad 10's library is STEP
  only); later views use the cache.
- Git LFS files aren't fetched from GitHub (GitLab returns their content).
- GitLab: gitlab.com only (no self-hosted servers yet). Signed out, GitLab
  shows no merge request comments and no issue comments, and limits requests
  from your network tightly; a big repository is listed 100 files per request.
- A file changed on both sides is never merged (on purpose: KiCad files don't
  merge reliably as text); Pull offers to move your commits to a new branch
  instead.

## Not done yet

- The tokens and refresh tokens are kept in the app's local storage; a release
  should keep them in the OS keychain, at least the long-lived refresh token.
- Auto-update, code signing, notarisation, file associations.

---

## For developers

### Building

```sh
# once: system libraries and Rust (Linux)
sudo apt install libwebkit2gtk-4.1-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev build-essential
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install tauri-cli --version "^2" --locked

cargo tauri dev        # run from source
cargo tauri build      # release binary + AppImage in src-tauri/target/release/bundle/appimage/
```

KiVi is a [Tauri 2](https://tauri.app) app. Windows builds the same way, with
Rust and Python installed: `cargo tauri build --no-bundle` makes
`src-tauri/target/release/kivi-desktop.exe`, which runs as it is, with the
pages built in (plain `cargo tauri build` also makes an NSIS installer, set in
`src-tauri/tauri.windows.conf.json`, which Tauri merges on Windows).

On macOS, install the Xcode Command Line Tools (`xcode-select --install`,
which bring `python3`) and Rust; no other libraries are needed (Tauri uses
the system's WKWebView). `cargo tauri build` makes
`src-tauri/target/release/bundle/dmg/KiVi_<version>_aarch64.dmg` (set in
`src-tauri/tauri.macos.conf.json`, which Tauri merges on macOS); CI builds one
for both architectures with `rustup target add x86_64-apple-darwin` and
`cargo tauri build --target universal-apple-darwin`. If the build stops with
`hdiutil: couldn't unmount … Resource busy`, run it as
`CI=true cargo tauri build`: that skips the Finder window styling of the disk
image, which can keep it busy. Tauri doesn't cross-compile. The pages
are plain ES modules with no build step; `tools/build_web.py` (run by Tauri)
copies them to `dist/web`.

Settings and sign-in are kept per user (`%LOCALAPPDATA%\app.kivi.desktop` on
Windows, `~/.local/share/app.kivi.desktop` on Linux,
`~/Library/WebKit/app.kivi.desktop` on macOS), not next to the program.
The Windows `.exe` needs the WebView2 runtime, which is part of Windows 11 and
comes with Edge updates on Windows 10 (otherwise get the *Evergreen* runtime
from Microsoft).

To build in your own GitHub App, set `KIVI_GITHUB_CLIENT_ID` and
`KIVI_GITHUB_APP_SLUG` when building, and for GitLab your gitlab.com OAuth
application's ID as `KIVI_GITLAB_CLIENT_ID` (in CI: the repository variables
of the same names, under Settings → Secrets and variables → Actions →
Variables); without them the sign-in dialog asks for them. GitHub's
device-flow endpoints don't send CORS headers, so sign-in requests run in Rust
(`oauth_post` in `src-tauri/src/lib.rs`, for both forges).

### Layout

```
index.html              viewer
diff.html               visual diff
inbox.html              home screen (projects, pull requests, issues)
src/sexpr.js            S-expression parser (+ tree helpers)
src/geom.js             matrices, arcs, bounding boxes
src/text.js             text layout (KiCad metrics, markup, escapes)
src/drawing-sheet.js    .kicad_wks parser/renderer, built-in default sheet
src/project.js          project discovery, hierarchy walk, page numbering
src/forge/              code hosts: the forge interface (index.js) and one adapter
                        per forge (github.js, gitlab.js: every API request,
                        comparisons, review comments, issues, lists, sign-in
                        details, web links)
src/sources.js          text before a patch, 3D model path resolution
src/diff/               semantic schematic, net, board and design rule diffs, comment anchors
src/review.js           comment markers and the thread shape (review comments and
                        change requests), the same on every forge
src/sch/                schematic model, renderer, themes
src/pcb/                board model, renderer, shapes, hit testing,
                        outline extraction, face textures, three.js scene,
                        STEP conversion (worker) and its cache, measuring
src/app/                UI: tabs, pan/zoom viewport, inspectors, BOM, diff page,
                        branch and history menus, measuring
src/desktop/
  tauri.js              TauriSource (folder on disk), GitRevSource (it at a commit), drag and drop, link routing,
                        folder chooser, sign-in (forge chooser, device flow), token refresh
  desktop.js            additions to the viewer and diff pages
  account.js            header on every page: home icons, account menu, Settings dialog
  inbox.js, desktop.css home screen: view switch, pull/merge requests, issues
  card-zoom.js          Ctrl + wheel resizes the gallery's cards
  projects.js           project gallery: repository scan, caches, cards
  thumb-worker.js       board thumbnails (parse + render off the main thread)
  git.js                local copies: download/link, branch and history menus, commit, push, pull
  add-project.js        the "+" menu: local project, remote project (settings `watchRepos`)
  local-projects.js     local project folders in the gallery, Link to remote…
  icons.js              header and menu icons (repository / pull request follow Octicons)
src-tauri/              Rust app
  src/lib.rs            commands: open_folder, list_folder, read_file, startup_folder,
                        model folders, forge_build_config, oauth_post (sign-in)
  src/picker.rs         the folder chooser through the desktop portal (Linux)
  src/git.rs            git commands (clone, branch, local changes, commit, push, pull, fetch with prune),
                        GitHub and GitLab remotes (tokens only to their hosts)
  src/git_http.rs       git over HTTPS through reqwest (no OpenSSL)
  src/kicad.rs          linking KiCad (program, version, path variables), Open in KiCad
  tauri.conf.json       window, CSP, bundle targets
  capabilities/         which plugin APIs the page may call
  icons/                app icons (tools/make_icons.py)
vendor/                 three.js 0.169, occt-import-js (LGPL-2.1), see vendor/README.md
tests/                  headless checks (gjs), Tauri API mock
tools/                  build, CLI rendering, visual comparison, icons, headless browser,
                        screenshot preludes
assets/                 logo (SVG)
docs/README.md          user guide (every feature in detail)
docs/screenshots/       README images
```

The parsers, renderers and diff engines have no DOM dependency, so they run in
a page, a worker, or headless.

### Logo and icons

`assets/kivi-logo.svg` is the logo. The page headers show it in the header's
colours (`src/app/logo.js` inlines it: the orange parts follow the brand colour,
the white ones the header background). The app icons in `src-tauri/icons/` are
generated from it:

```sh
python3 tools/make_icons.py
```

### Tests and visual checks

The tooling runs on `gjs` (GNOME's JavaScript runtime), so Node is not needed.
The tests use KiCad's demo projects without a KiCad installation:
`tests/kicad-demos.txt` lists the design files they read (172 files, 74 MB, at a
pinned KiCad release, with git hashes), and `tools/fetch_demos.py` downloads
those from KiCad's GitHub mirror into the git-ignored `tests/kicad-demos/`,
checking each hash and skipping files already there.

```sh
python3 tools/fetch_demos.py                     # get / verify the listed files
python3 tools/fetch_demos.py --refresh 10.0.7    # move the list to another KiCad release

# Parse and render every KiCad demo project, check invariants
# (envelope, NaN, unresolved references, pin-to-wire connectivity, footprints)
gjs -m tests/run.js               # or: gjs -m tests/run.js path/to/projects …
gjs -m tests/diff.js              # schematic, library symbol, board, footprint and rules diffs
gjs -m tests/nets.js
gjs -m tests/review.js
gjs -m tests/gitlab.js
gjs -m tests/models.js
cargo test --manifest-path src-tauri/Cargo.toml --lib   # Rust side: model folders, git (needs dist/web: run tools/build_web.py once)

# Render a file to SVG
gjs -m tools/render.js board.kicad_pcb out.svg --layers F.Cu,F.SilkS,Edge.Cuts
gjs -m tools/render.js board.kicad_pcb face.svg --face front     # 3D texture artwork

# Optional, manual, needs KiCad installed: compare against KiCad's own export
kicad-cli sch export svg -o ref/ project.kicad_sch
python3 tools/compare.py ref/project.svg out.svg cmp.png  x0 y0 x1 y1  [px_per_mm]

# Smoke test: every page loads without script errors, the viewer opens
# pic_programmer (headless WebKit, Tauri API mocked, no network)
tests/smoke.sh

# Drive the pages yourself (served over HTTP, Tauri API mocked)
python3 -m http.server 8000 &
LIBGL_ALWAYS_SOFTWARE=1 xvfb-run -a gjs -m tools/browser-check.js \
  "http://127.0.0.1:8000/inbox.html#projects" shot.png \
  --prelude "$(cat tests/tauri-mock.js)" --wait "document.querySelector('.project-card')"
```

`tools/screenshots.sh` regenerates every screenshot in this README (all, or
by name: `tools/screenshots.sh viewer-3d-net`) after a UI change. It needs no
network or sign-in: `tools/screenshots-prelude.js` answers GitHub and the
desktop app from the KiCad demo files, with a pull request that applies a few
fixes to the CM5 MINIMA board, and serves KiCad's installed 3D library
(`KICAD3D`, default `/usr/share/kicad/3dmodels`).

What a passing run prints:

```console
$ python3 tools/fetch_demos.py          # here 5 files were missing or damaged
downloading 5 of 172 KiCad 10.0.6 demo files from KiCad/kicad-source-mirror …
  1.3 MB in 3 s
tests/kicad-demos: 172 KiCad 10.0.6 demo files ready
$ gjs -m tests/diff.js | tail -1
all diff checks passed
$ tests/smoke.sh
ok    home
ok    pull-requests
ok    viewer
ok    diff
```

### Continuous integration

`.github/workflows/ci.yml` runs the tests on every pull request and push to
`main` (or `master`), and builds only for releases and manual runs:

1. **Tests**: installs gjs, WebKitGTK and xvfb, restores the KiCad demo files
   from the Actions cache (keyed on `tests/kicad-demos.txt`, so they're
   downloaded only when the list changes or the cache expired after 7 unused
   days), then runs the unit tests, the full demo sweep and `tests/smoke.sh`.
2. **Rust tests**, alongside: `cargo test` on the Rust side, with the Rust
   build cached, and a check that `THIRD-PARTY-NOTICES.md` is up to date. All
   three builds below wait for both test jobs.
3. **Build (Linux)**, only for tags and manual runs (*Run workflow* on the
   Actions tab): `cargo tauri build`, with the Rust build and the Tauri CLI
   cached; lists the AppImage's bundled system libraries in
   `appimage-libraries.md`. The AppImage and that list are the `kivi-linux`
   artifact.
4. **Build (Windows)**, likewise: `cargo tauri build --no-bundle` on a Windows
   runner; the `kivi-windows` artifact holds `KiVi_<version>_x64.exe` with
   `LICENSE` and `THIRD-PARTY-NOTICES.md` next to it (GitHub zips every run
   artifact for download; release files aren't).
5. **Build (macOS)**, likewise: `cargo tauri build --target
   universal-apple-darwin` on a macOS runner; the `kivi-macos` artifact holds
   `KiVi_<version>_universal.dmg` (Apple Silicon and Intel; `LICENSE` and
   `THIRD-PARTY-NOTICES.md` are inside the app). Not code-signed or notarised.

Pushing a tag `v<version>` (for example `v0.2.0`) runs all five and publishes a
GitHub Release. The version comes from the tag: each build first runs
`tools/set_version.py`, which writes it into `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`, so there's nothing to bump
by hand (the versions in the repository are only for local and manual builds;
a tag that isn't `v<major>.<minor>.<patch>`, optionally with `-beta.1` and the
like, fails the build). The release has the AppImage, the
Windows `.exe`, the macOS `.dmg`, `LICENSE`, `THIRD-PARTY-NOTICES.md`,
`appimage-libraries.md` and `KiVi_<version>_source.tar.gz` (`git archive` of
the tag, with the version written in). Merges don't build, so run the workflow by hand on `main` before
tagging and check all three builds pass.

## Licence

KiVi is free software: you can redistribute it and/or modify it under the terms
of the [GNU General Public License](LICENSE), version 3 or (at your option) any
later version. It comes with no warranty.

It includes third-party software under its own licences: three.js (MIT),
Chevrotain (Apache-2.0), occt-import-js with Open CASCADE Technology (LGPL-2.1)
and the Rust crates behind Tauri (mostly MIT and Apache-2.0), plus three icons
from GitHub's Octicons (MIT) and KiCad's default drawing sheet (GPL-2.0-or-later).
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) has their licence texts and is
installed with the app. Each release also carries its source code
(`KiVi_<version>_source.tar.gz`). Regenerate it with `python3 tools/notices.py` after
changing `Cargo.lock` or `vendor/` (CI fails if it's out of date). The AppImage
also bundles system libraries (GTK, WebKitGTK, GStreamer…) from the build
machine; each release lists them with their licences and sources in
`appimage-libraries.md`.

The GitHub and GitLab logos in the sign-in dialog aren't part of KiVi: they're
loaded from GitHub and GitLab when the dialog opens (GitLab's artwork is
licensed CC BY-NC-SA, which isn't GPL-compatible, so KiVi doesn't ship it).
GitHub is a trademark of GitHub, Inc. and GITLAB is a trademark of GitLab
Inc.; KiVi isn't affiliated with either.
