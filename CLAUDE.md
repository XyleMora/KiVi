# KiVi — Tauri 2 desktop app

KiVi renders KiCad 6–10 projects (schematic, PCB, 3D, BOM) from GitHub
repositories or local folders, with a project gallery, a pull request inbox,
a visual diff and review comments pinned to parts/nets that are stored as
ordinary GitHub PR review comments. GitHub stays the backend for source
control, diffs and review comments.

README.md is the user-facing pitch and developer reference (build, layout,
test commands); `docs/README.md` is the user guide (every feature, GitHub App
setup, deep links). Read them first; this file covers what the
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
- Measuring (PCB and 3D only; not the schematic, the user's choice: sheet
  distances mean nothing physically). PCB: `src/app/measure.js`
  (`MeasureTool`, ruler in the zoom column, key M) works through
  `SvgView.tool` (gets picks and hovers first, so selection and comment
  picking stay out of the way) and draws on `SvgView.toolLayer` (not wiped by
  selection redraws; labels sized in screen pixels, redrawn on zoom). Points
  are board coordinates; the bottom view only changes where they're drawn
  (`flipX`). 3D: `src/pcb/measure3d.js` (`Measure3D`, ruler in the 3D zoom column, which also has +, − and fit (`Board3D.zoom`, `fit`); the camera presets and Components sit left of it, on the right like the PCB's)
  through `Board3D.tool` (pick/hover, `frame()` each rendered frame keeps the
  HTML label on its point); snaps to model vertices of the part hit, or on the
  board face to the same points as the PCB; a ray through a drill hole (no
  geometry) falls back to the face plane, and face points are put on the face
  itself (the face meshes sit 0.002 mm off). Both get snap points from
  `src/pcb/snap.js` (`snapPoints`; `r` = pad/via/track size so clicking the
  copper snaps).
- Cross-probing shows the side the part or net is on: the PCB switches to
  the part's side, or for a net to `netSide` (pcb/model.js: the outer side
  with more of its pads and track pieces; even = stay), and the 3D view
  glides to the Top or Bottom preset around it (`Board3D.focusOn(box, side)`,
  `onView` presses the preset button). Clicks inside a view never move it.
- `src/desktop/` holds the Tauri integration; it's a no-op when
  `window.__TAURI__` is missing (`isDesktop`), which is what lets the pages run
  in a plain headless browser for tests.

## Desktop parts

- `inbox.html` + `src/desktop/inbox.js`: the home window, with three views
  switched by GitHub-style icon buttons in the header (`data-home`,
  `aria-pressed`, reachable as `inbox.html#projects` / `#prs` / `#issues`;
  each loads on first show, since they cost API requests). There's no Watched drawer or
  recent folders list any more (the user's choice): repositories are added
  with "+" → Remote project… (`watchRepos`). **Reload** (`#reload`) clears
  `hiddenRepos` and lists every repository again, so removed GitHub
  repositories come back (the user's choice; local projects stay removed).
  - **Projects** (`src/desktop/projects.js` + `thumb-worker.js`): a card grid of
    every `.kicad_pro` in reachable repositories, with board thumbnails. Caches:
    `kivi.projectIndex` in localStorage (per repository, keyed on `pushed_at`
    and the default branch) and the IndexedDB database `kivi-thumbs` (by blob
    SHA). 48 cards per page; boards over 30 MB get no thumbnail.
  - **"+" menu** (`src/desktop/add-project.js`, `#add-project`, a
    `<details class="menu">`, desktop only): **Local project…** or **Remote
    project…** (a GitHub repository, checked to exist, be visible, have
    projects and not be in the gallery, then added to `watchRepos`). It
    replaced the address bar, removed from all three pages (the user's choice):
    pages open only from the gallery, the PR list, drops, the CLI and hashes.
    GitHub cards have **Remove from projects** (`removeRepo`): the whole
    repository leaves the gallery and PR list: added to settings
    `hiddenRepos` (listRepos and the PR list skip those) but kept in
    `watchRepos`, so Reload brings it back; `watchRepo` (Remote project…) also
    clears it.
  - **Local projects** (`src/desktop/local-projects.js`): "Local project…"
    adds a folder to settings `localProjects`
    and `git_init`s it (on main, plus a `.gitignore` of KiCad's working files,
    `IGNORED` in git.rs: `.history/`, `~*.lck`, backups, autosaves,
    `fp-info-cache`; not `*.kicad_prl`, the user's choice) unless it's already in a repository (the
    user's choice; also for folders added earlier, when next scanned, and only
    folders with a project);
    its projects become cards (`p.local`, `localCardHtml` in projects.js) read
    through `scan_kicad_folder` / `read_kicad_file` (lib.rs, KiCad design files
    only); thumbnails are cached by path, size and change time. Their menu: no
    Download, View on GitHub greyed out (`aria-disabled`) until linked, **Link
    to GitHub…** = `git_link_github` (git.rs: `git init` on main if still needed,
    then remote origin, or `github` when origin points elsewhere; the repository
    must exist via the API), **Remove from projects**. A clone of a repository
    in the gallery is linked to that card (`localCopies`) instead of added, and
    a local card whose folder is such a linked copy isn't shown; a local
    folder linked to GitHub first, whose repository joins the gallery later
    (Remote project…, Reload, app access), is turned into that card's copy
    the same way (`adoptLinkedFolders`, after each scan) (the user's
    design: "+" button, no Download, greyed View on GitHub, Link = add remote).
  - **Pull requests**: the GitHub search API, with a KiCad-files-changed badge
    per PR (from `/pulls/N/files`) and buttons to the visual diff, the viewer
    at the PR head, and github.com. Only PRs in repositories with KiCad
    projects (the user's choice), by `repoHasProjects` (projects.js): the
    gallery's index if it has the repository, else `/repos/x` plus a tree scan,
    cached in localStorage `kivi.kicadRepos` by `pushed_at` and default branch;
    a failed check shows the PR. Hidden PRs aren't mentioned (the user's choice).
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
  header, adds drag and drop, live reload on
  `folder-changed` (keeps tab, sheet and selection) and
  `index.html#folder=<path>[&project=…][&commit=<sha>]`.
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

## Visual diff engines (`src/diff/`)

- `sch-diff.js`: symbols/sheets by UUID, wires/labels by geometry, plus
  `net-diff.js`: nets matched by name (same name on a sheet = one net), then
  by shared pins; pins keyed by symbol UUID + pin number (renumbering isn't a
  change) and pins of added/removed symbols left out. Per sheet only: a net
  joined through a global label on another sheet isn't followed.
  `diffSchematic` returns `connA`/`connB`, reused by diff.js for anchors.
  Each sheet's copy of a library symbol (`lib_symbols`) is compared per
  matched symbol with the same `libId` (`libSymbolDiffs`: pins keyed by
  number, swapped pins named, body graphics per unit) and reported once as a
  "library symbol" change listing its parts (`boxesBefore`/`boxesAfter`).
- `pcb-diff.js`: zones by UUID, else net+layers+outline; settings from
  `zoneSettings` (pcb/model.js); teardrop zones (`attr teardrop`) collapsed
  into one "Teardrops" line; Board setup adds stackup, finish and the
  mask/paste fields of `(setup)`.
  Inside a footprint (`footprintDiffs`), compared in its own frame so moving
  or rotating the part adds nothing: pads by number (`byOccurrence`, shared
  with sch-diff.js; size, shape, drill, layers, mask/paste/clearance overrides
  from `padSettings` in pcb/model.js; pads with the same change on one line),
  footprint-level overrides, 3D models, graphics per layer (`localFrame`), and
  texts. A flipped footprint only says "moved to bottom".
- `rules-diff.js`: `.kicad_pro` (rules, rule_severities, size presets,
  netclasses: a missing field inherits from Default in KiCad 9+, netclass
  patterns and assignments) and `.kicad_dru` (`#` comments, several top-level
  rules). Everything else in a `.kicad_pro` is ignored. `RULE_FILES`
  (sources.js) files are fetched by the diff page, shown as a table
  (`#rules-view`, `.rules-mode`) and dropped when unchanged
  (`dropUnchangedRules`). The inbox badge counts the same files
  (`src/desktop/pr-files.js`): a modified `.kicad_pro` is read at the PR head
  and its base rebuilt from the PR's `patch` (`textBeforePatch`, sources.js),
  so no extra API request for the base; unverifiable files count.
- Changes may carry `boxesBefore`/`boxesAfter` (per-side marks) and `rows`
  (rules table).

## GitHub integration notes

- Don't cache failures as empty results (the "no KiCad files" sessionStorage
  cache, the project index, thumbnails).
- Review comment markers: `<!-- kivi:{json} -->` after a `<sub>📍 KiVi · …</sub>`
  footer; `src/review.js` encodes and decodes both (`tests/review.js`).
- New comments carry no link in their footer (just "📍 KiVi · <what>");
  `encodeBody` still accepts one.

## Change requests (GitHub issues)

- The user's design: issues pinned like review comments, outside PRs, listed
  in a home view; only issues labelled `kivi` (`ISSUE_LABEL`, the user's
  choice over listing every issue).
- `src/issues.js` `IssueComments` extends `ReviewComments` (same request and
  error code) and turns issues into the same thread shape: `rootId` = issue
  number (so `thread=12` is issue #12), resolved = closed, the body is the
  first comment (never deletable). The marker carries `file` (repository path)
  and `commit`. Signed in: one GraphQL query (issues + comments); signed out:
  REST, comments fetched when a thread opens (`repliesPending`,
  `store.loadReplies`). `create` first POSTs the label (422 = exists) and
  reports `labelled: false` when GitHub dropped it (no write access).
- `ReviewStore.openIssues({owner, repo, prefix, commit})` (review-ui.js):
  `kind` "pr" | "issues" switches the panel's wording (`WORDS`) and the
  composer (title input, "Open issue"). `prefix` maps repository paths to the
  open folder's (a local copy below the repository's root); re-opening the
  same repository only updates `commit`, so live reload costs no requests.
- In PR mode the store holds both (`api` = review comments, `issueApi` =
  issues; `apiFor(t)`, `wordsFor(t)`), keys keep them apart (`t.key`: comment
  id, or "i12"), only review threads are numbered 1…n, issue pins are green
  (`.cm-pin.issue`), `openCounts` skips issues. `closingIssues()` (review.js:
  GraphQL `closingIssuesReferences` signed in, else `closingNumbers` of the
  description) marks the ones the PR closes; **Close with this PR**
  (`addClosingIssue`) appends "Fixes #N" to the description, re-read first. An
  issue load failure only leaves a note (`issueError`), comments still load.
  GitHub refuses review comments on files the PR doesn't change (422 "path
  could not be resolved"), so new pins there are issues (the user's choice):
  `store.changed` (`changedFiles()`, `/pulls/N/files`, signed in only, unknown
  = review comment) and `kindFor(path)` / `wordsAt(path)` pick the button,
  composer and `post()` target per file (the viewer at a PR's head; the visual
  diff lists only changed files).
- main.js `showIssues()`: GitHub sources outside PR mode; local folders once
  git.js `mountGitMenu` calls `kivi.setLocalIssues` with `git_info`'s owner
  (`folderPrefix`, tauri.js). `file=` without `project=` picks the project
  holding that file (`projectOfFile`).
- Home view Issues: search API, "Assigned to you", "Opened by you" (signed
  in) and "In your projects" (`galleryRepos()` from the project index plus
  remote projects, chunked into queries under GitHub's 256-character limit).
  Rows link to the local copy when linked (`localCopy`), else `gh=`.
- Tested: `tests/review.js` (mocked API) and headless with a fetch mock;
  never against GitHub. The GitHub App needs *Issues: Read and write*; ask the
  user whether it was added before assuming writes work.

## Local copies and git

- `src-tauri/src/git.rs` (git2 with "vendored-libgit2", no "https"/"ssh"
  features) and `git_http.rs`: libgit2's HTTPS transport replaced by reqwest
  (rustls, blocking client), so no OpenSSL (libssl-dev isn't installed here and
  needs sudo). The token rides in the URL's user part
  (`https://x-access-token:TOKEN@github.com/…`), which git_http.rs moves into an
  Authorization header; clones keep the plain URL, errors are scrubbed of it.
  GitHub is always reached at `https://github.com/<owner>/<repo>.git`, whatever
  the clone's remote says. Commands: `git_info`, `git_status`, `git_clone`
  (emits `git-progress`), `git_create_branch`, `git_local_changes` (merge base
  with origin/HEAD, main or master ↔ working files incl. untracked, renames),
  `git_read` / `git_list` (rev "" = working files), `git_fetch` (prunes branches deleted on GitHub, like `--prune`; pull fetches the same way), `git_commit`,
  `git_push`, `git_pull` (fetch, then fast-forward with a safe checkout; both
  sides with commits on disjoint files → merge commit; any file changed on
  both → outcome "diverged", nothing touched), `git_move_commits` (after a
  diverged pull: new branch at HEAD, checked out, old branch set to GitHub's),
  `git_remote_state`, `git_branches`, `git_switch_branch`,
  `git_link_github`, `git_init`, `git_log`; all run
  on a blocking thread.
- Branch menu `#branch-menu` (`src/app/branch-menu.js`, shared, the user's
  design): the same button and branch list for GitHub projects (main.js
  `mountGitHubBranches`: `/branches` API, switching rewrites the URL's `gh=`
  ref so `restoreFromHash` reopens the project, same tab) and local copies
  (git.js `mountGitMenu`: `git_branches` after a best-effort fetch,
  `git_switch_branch` = safe checkout like `git switch`, plus New branch…,
  Commit…, Push… and Pull… on top (separate items and dialogs, the user's request;
  Pull… runs at once and shows the outcome, a refused push offers it;
  greyed out via `aria-disabled` with the reason as title/toast when there's
  nothing to do); a folder without a GitHub remote gets no Push (no sign-in
  needed; the user's request), and before its first
  commit `git_info.branch` is the unborn branch and a new branch replaces it). `data-kind` tells which side owns it: main.js
  removes only a "github" one, desktop.js mounts the "local" one after a folder
  opens and on live reload/focus. The left of the bar shows the repository
  (GitHub) or folder (local), no longer the ref.
- History menu `#history-menu` (`src/app/history-menu.js`, shared, next to
  the branch menu; `data-kind` like it): the branch's commits, 50 per
  **Show more**. GitHub (main.js `mountGitHubHistory`, hidden in PR mode):
  `/commits?sha=<ref>` (one API request per page per page load); picking one
  sets `commit=<SHA>` in the URL, which `openGitHub` turns into the source's
  `sha`/`commit` while `ref` (and the branch menu) keep the branch. Local
  (git.js `mountGitMenu(folder, history)`, state in desktop.js `viewing`):
  `git_log`, and `GitRevSource` (tauri.js: `git_list`/`git_read` at that
  commit, paths made relative to the open folder, which may sit below the
  repository's root). While a `GitRevSource` is open, live reload is skipped
  and Open in KiCad is greyed out; switching branch returns to the working files.
- Visual diff button `#visual-diff` (index.html, set by `setDiffButton` in
  `src/app/diff-button.js` from main.js `setGitHubDiff` or git.js
  `mountGitMenu`; it replaced the branch menu's "Visual diff of changes", the
  user's request). The side pickers, in the Before/After pane labels and the
  Overlay one (`.pick-slot`, the user's design; the bar shows only the
  project's name, `projectName`: the `.kicad_pro` next to the shown file,
  else the repository or folder) (`src/app/ref-picker.js`, diff.js
  `mountPickers`; none for a PR) list
  branches and the commits of a branch chosen in the menu, for GitHub through
  the API and for a local copy through `localGitApi` (so diff.js stays
  Tauri-free), and reload with `base=` / `head=`. Local: `git_local_changes`
  takes a base branch (from the merge base) or revision (that commit itself,
  `base_tip`) and an optional head (`rev_tip`: local branch, GitHub's, then any
  revision; none = working files); `git_log` takes `rev`. GitHub
  (`resolveComparison`): no base = default branch, base = head → that commit
  vs its parent, a full-SHA base that isn't the merge base → `treeDiff` (two
  recursive trees; refuses truncated ones).
- `src/desktop/git.js`: card menu actions (projects.js), the local branch
  menu, the dialogs,
  and `localGitApi()` which desktop.js hands to `kiviDiff.attachLocalGit()` for
  `diff.html#local=<folder>` (diff.js stays free of Tauri).
- Links: settings `localCopies` {"owner/repo" lower case → folder}. Linking
  accepts only existing clones of that repository (the user's choice). A linked
  card always opens the local copy (`index.html#folder=…&project=…&tab=…`, the
  user's choice; no separate "Open local copy" item).
- Gallery sync icon (left of a card's ⋯, the user's design): grey = no local
  copy, green = no uncommitted changes and the branch tip equals GitHub's,
  yellow = anything else. `git_remote_state` asks GitHub for its branch tips
  (ls-remote, no download; falls back to the remote-tracking ref offline);
  `syncState()` in git.js checks once per repository, again after Refresh,
  link/unlink and window focus.
- The user chose: built-in git, KiVi makes the commits, link existing clones
  only, diff against the merge base with main.
- Tested: `cargo test` (local bare repositories: branch, edit, diff, commit,
  push, rejected push) and `cargo test -- --ignored clone_over_https` (needs the
  network; clones octocat/Hello-World through git_http.rs). Pushing over HTTPS
  needs a token with *Contents: Read and write* and has only been tested against
  local repositories and mocks. The UI was checked headless with mocked commands.

## Linking KiCad

`src-tauri/src/kicad.rs`: `kicad_inspect` (program or installation folder →
`{program, version, vars}`; version from `kicad-cli version`, so KiCad 7+; vars =
the installation's `KICADn_3DMODEL_DIR`, the user's `KICADn_3RD_PARTY`, then
`environment.vars` from `kicad_common.json`, then the process environment; only
existing absolute folders) and `kicad_open` (program + `.kicad_pro` only; macOS
through `open -a`). Settings key `kicad` (account.js, re-inspected each time
Settings opens). Children are started with the AppImage launcher's environment
removed (`outside_appimage`: entries pointing into `$APPDIR`, and its forced
`GTK_THEME=Adwaita:dark|light`), checked by starting the real KiCad 10 from a
mounted AppImage's environment under xvfb (`--ignored opens_installed_kicad`,
run with `KIVI_TEST_PROJECT`; isolate `XDG_CONFIG_HOME` or KiCad adds it to the
user's recent projects). "Open in KiCad" (`#open-kicad` in `index.html`, next to
the branch menu, and the cards' `⋯` menu) is greyed out with `aria-disabled`
(the tooltip and a click say why): KiCad not linked, project not on this
computer, or no `.kicad_pro`. The user chose an explicit link (no
auto-detection), a path box with Browse…, and greying out instead of hiding.
Windows paths come from KiCad's documentation, untested; macOS paths were
checked by hand with KiCad 10.0.1 (see Build and run).

## 3D models

Settings key `modelSources` (list of URL prefixes, GitHub repos and local
folders; replaced the old single `modelBase`, which is still read). The default
is the web mirror; a folder (e.g. `/usr/share/kicad/3dmodels`, KiCad 10.0.6 is
installed here: 7,251 STEP files, no VRML) is only used when the user adds it
(Settings → **Add folder…**) or links KiCad (no auto-detection, on purpose).
The linked KiCad's vars reach `makeModelResolver` as `pathVars`: a
`${VAR}/path` it defines is read exactly from that folder after the project
(library vars of any version map to the linked library), and its library and
3rd-party folders join the folder sources after the user's.
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

STEP models go through `src/pcb/step.js`: converted by occt-import-js in one
worker (`step-worker.js`, a classic worker because occt-import-js is a plain
script loaded with `importScripts`), falling back to the main thread if the
worker can't run, and cached in the IndexedDB database `kivi-models` by the
file's SHA-256 (key prefix `CACHE_VERSION`: bump it when the conversion or the
payload changes). Measured on CM5_MINIMA_3 with the KiCad folder: reopening
24 s → 5 s. More workers were slower in WebKitGTK (each compiles the 7.7 MB of
WebAssembly; three cold workers 25 s vs one 6 s for the same work). Headless
timings are skewed by the 3D view's 60 fps render loop in software GL, which
competes with the worker for the CPU; clear `kivi-models` after 3D tests.

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
  switches to `python` (Windows has no `python3`) and an NSIS target. CI
  doesn't use the installer (the user wants no install, like the AppImage): it
  runs `cargo tauri build --no-bundle` and ships `kivi-desktop.exe` as a bare
  `KiVi_<version>_x64.exe` (no zip either: download and run), with `LICENSE` and
  `THIRD-PARTY-NOTICES.md` as separate release files (the pages are in the
  .exe; the Rust side reads no bundled resources). It's built only in CI, on tags and
  manual runs, and has never been run by hand:
  nothing Windows-specific was tested locally. `src-tauri/icons/icon.ico` (from
  `tools/make_icons.py`) is required for the Windows build.
- macOS: `src-tauri/tauri.macos.conf.json` (merged by Tauri on macOS) makes a
  `.dmg` (macOS 11+). No extra libraries (system WKWebView); `python3` comes
  with the Xcode Command Line Tools. Tauri makes `KiVi.icns` from the PNGs, so
  there's no `.icns` in `icons/`. CI (`build-macos`, macos-14) runs
  `cargo tauri build --target universal-apple-darwin` (Apple Silicon + Intel)
  and ships `KiVi_<version>_universal.dmg`, not code-signed or notarised (the
  linker's ad-hoc signature only). Locally, `bundle_dmg.sh`'s Finder styling
  can leave the image busy (`hdiutil: couldn't unmount … Resource busy`):
  `CI=true` skips it (Actions sets it). WebView data (localStorage,
  IndexedDB) lives in `~/Library/WebKit/app.kivi.desktop` for the `.app`, but
  `~/Library/WebKit/kivi-desktop` for `cargo tauri dev` (an unbundled binary):
  the two don't share settings. Tested by hand on Apple Silicon (macOS 27,
  KiCad 10.0.1): dev and `.dmg` builds, viewer, 3D, Settings → KiCad
  (`/Applications/KiCad` → `KiCad.app/Contents/MacOS/kicad`,
  `SharedSupport/3dmodels`, `kicad_common.json` in
  `~/Library/Preferences/kicad/10.0`), Open in KiCad, GitHub sign-in with a
  GitHub App. Not tested on Intel.
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
Third-party code pasted into KiVi's own files goes in `COPIED` (notices.py) with
its notice under `vendor/` and a credit comment where it's used: so far Octicons
(`icons.js`, `vendor/octicons/LICENSE`) and KiCad's default drawing sheet
(`drawing-sheet.js` `DEFAULT_WKS`, GPL-2.0-or-later, `vendor/kicad/COPYRIGHT`).
The release job attaches `KiVi_<version>_source.tar.gz` (`git archive` of the
tag): the repository is private, and the patched occt-import-js (LGPL, built
into the binary) needs the source to be rebuildable.

## Tests

```sh
python3 tools/fetch_demos.py                 # KiCad demo files → tests/kicad-demos (skips intact ones)
gjs -m tests/run.js                          # parse+render all KiCad demos
gjs -m tests/diff.js
gjs -m tests/nets.js
gjs -m tests/review.js                       # GitHub API layer, mocked
gjs -m tests/models.js                       # 3D model path resolution order
cargo test --manifest-path src-tauri/Cargo.toml --lib   # Rust: model folders, git (needs dist/web)
tests/smoke.sh                               # pages load cleanly, viewer opens pic_programmer (~15 s)
```

- The tests never read a KiCad installation. `tests/kicad-demos.txt` (committed,
  generated by `fetch_demos.py --refresh <tag>` from one GitHub API call) pins
  the KiCad tag (10.0.6) and lists the 172 design files the tests read (incl. `.kicad_dru`) (no
  models/PDFs/Gerbers, nothing over 20 MB) with git blob hashes; the script
  downloads them from `raw.githubusercontent.com/KiCad/kicad-source-mirror`
  and verifies each. `tests/gjs-fs.js` `kicadDemos()` finds them and exits
  with a hint if they're missing. This machine's connection is slow
  (~0.2 MB/s): a full fetch takes ~6 min here.
- CI is `.github/workflows/ci.yml` (see README): tests and Rust tests (with the notices check) on PRs and main → Linux, Windows and macOS builds (artifacts; tags and manual runs only, the user's choice to save Actions minutes on the private repo)
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

`tools/screenshots.sh [name …]` regenerates all of `docs/screenshots/*.png`
(1440 wide, dark UI, signed out: the user asked for no signed-in account in
them); rerun it after UI changes and look at each image. Run it with
`TMPDIR` set to the scratchpad. It needs no network and costs no API
requests: `tools/screenshots-prelude.js` (after `tests/tauri-mock.js`) mocks
`fetch` for api.github.com / raw.githubusercontent.com and the Tauri commands:

- `XyleMora/cm5_minima_test_repo` = the cm5_minima demo on main, plus PR #1
  whose head applies `EDITS` (U405 pads, mask margin, 3D model and silk mark;
  M701 drill; AP2553W6 GND pin type; LED pins swapped) and one KiVi review
  comment on U405 and a description saying "Fixes #9", plus open `kivi`
  issues #9 (M701, closed by the PR's drill change), #12 (J501, one reply),
  #13 (+5V net) and #14 (D605 on IO.kicad_sch), anchored at real positions; `KiCad/kicad-source-mirror` = the demo projects of
  `tests/kicad-demos.txt` (its real blob SHAs). Both are in `watchRepos`.
- `diff.html#local=…` = a copy of cm5_minima with `EDITS` as working files;
  in the viewer (`index.html#folder=/home/designer/cm5_minima`, the
  `git-branch-menu` shot) the same folder is a clone of the test repository
  with one commit to push (`git_info` answers by page).
- `review-comment` = the viewer at PR #1's head with comment 101 open;
  `settings-kicad` = the Settings dialog with the linked KiCad.
- A linked KiCad 10 whose library is `/usr/share/kicad/3dmodels`, served at
  `/kicad3d/` from a temporary web root of symlinks (`--directory`, so the
  server is killed by PID cleanly); `modelSources: []` keeps it offline.
- Avatars are `<img>`s of github.com/XyleMora.png: the only real network use.
- The browser profile keeps storage: the script clears `kivi.projectIndex`,
  `kivi.kicadRepos`, `kivi-thumbs` and `kivi-models` before and after.
- The cross-probing trio (`viewer-schematic`, `viewer-pcb`, `viewer-3d-net`;
  the user wants all three views of one net) selects `/USB_C.D_P` through
  `net=` (a selected net's inspector says "Highlight on PCB").
  `viewer-issues` opens issue #12 with `thread=12`; in a PR's diff an issue
  is `thread=i9` (`pr-closes-issue`). The README's "Reviewing hardware"
  section walks through PR review vs issues with these shots (the user's
  request).
- 3D waits until `#status3d` counts 70+ models and is unchanged for 10 s
  (~60 s cold; a big STEP model can stall the count for 10 s mid-load). Diff shots
  click a change, then zoom with `kiviDiff.after.zoomTo(c.after, mm)` or
  `(c.boxesAfter[0], mm)`.

The real `XyleMora/KiVi` and `cm5_minima_test_repo` aren't publicly readable
(API 404 signed out, checked 2026-10-30), so the README's quick start uses
`greatscottgadgets/hackrf` (public, `hardware/hackrf-one/hackrf-one.kicad_pro`).

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
- No text merge of a file changed on both sides (on purpose: KiCad files
  don't merge reliably); Pull offers moving the commits to a new branch instead.
- No auto-update, code signing or file associations.
