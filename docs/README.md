# Using KiVi

The full guide to KiVi's features. For what KiVi is and a five-minute
tour, see the [main README](../README.md).

KiVi works with GitHub and GitLab (gitlab.com). This guide uses GitHub's
words; on GitLab the same things are called differently, and KiVi uses
GitLab's words for GitLab projects:

| GitHub | GitLab |
|---|---|
| Pull request (`#12`, *PR*) | Merge request (`!12`, *MR*) |
| Review comment | Discussion on a file of the merge request |
| Repository | Project (`group/subgroup/project`) |
| "Fixes #N" closes an issue | "Closes #N" closes an issue |

Where GitLab behaves differently, the section says so.

## Projects

The home screen finds every `.kicad_pro` in the GitHub and GitLab
repositories you can reach and shows each as a card. The filter narrows the grid by project, repository, folder or
forge name as you type; a card's `⋯` menu opens the schematic, PCB, 3D view,
BOM or the repository's page on GitHub or GitLab directly. The header's three icons switch between
**Projects**, **Pull requests** and **Issues**.

The **+** button at the bottom right adds a project:

- **Remote project…** asks for the repository: its address
  (`https://github.com/…`, `https://gitlab.com/…`) or a short `owner/repo`,
  which means the forge you're signed in to (GitHub when signed out;
  `group/sub/project` is always GitLab). The line under the box shows where
  it'll look. It checks that it exists, that your account can see it,
  that it has KiCad projects and that it isn't in the gallery yet, then adds
  it: its projects join the gallery and its pull requests the pull request
  list.
- **Local project…** adds a folder on this computer; each KiCad project in it
  gets a card (with a folder icon and its path), listed with the GitHub and
  GitLab projects by date of the last change. Thumbnails are re-rendered when the
  board changes. A folder that isn't in a git repository becomes one when
  it's added (`git init`, on `main`, with a `.gitignore` leaving out KiCad's
  working files: local history `.history/`, lock files `~*.lck`, backups,
  autosaves and `fp-info-cache`, but not the project's local settings
  `*.kicad_prl`; nothing is committed), so its changes can be committed from
  the viewer's branch menu.

Projects also open from a folder dropped on the window, or given on the
command line (`./KiVi_*.AppImage /path/to/project`).

**Remove from projects** in a GitHub or GitLab card's `⋯` menu takes its whole
repository off the gallery and the pull request list. **Reload**, next to the
page title, lists every repository again, including removed ones. A local
card's **Remove from projects** leaves the folder on disk.

A local card's `⋯` menu also has **Open in KiCad**, **View on GitHub** or
**View on GitLab** (greyed out until linked) and **Link to remote…**:

- **Link to remote…** asks for a repository the same way, checks that it exists and that your account can see it, and adds it as the
  folder's git remote (`origin`, or `github` / `gitlab` if origin points
  elsewhere). Nothing is uploaded: open the project and use **Commit…** and
  **Push…** from its branch menu. Use an empty repository, since KiVi can't
  combine your history with one the forge already has.
- Once linked, the card gets the sync icon and View on GitHub or GitLab, and
  the branch menu gets **Push…**. A clone of a GitLab project is recognised
  the same way, whatever its remote's address form (HTTPS or SSH).
- A folder that is a clone of a repository already in the gallery doesn't get
  a card of its own: it becomes that repository's local copy.

## Schematic, PCB and 3D

**Cross-probing.** Click a symbol (fields, datasheet, every pin with its net)
or a wire or label (the net's labels and pins), then **Show on PCB** /
**Highlight on PCB** or **Show in 3D**: the PCB switches to the side the part
is on, or most of the net's copper is on, and the 3D view turns to the top or
bottom. Settings has a dark schematic option.

**PCB.** Layers can be switched one by one (or *Copper*, *Default*, *All*),
the board flipped to the bottom, and footprints, pads and tracks inspected.

**Measuring** (PCB and 3D). The ruler (under the zoom buttons, or **M**)
measures on the board: click two points to read the distance in mm and mil
with Δx and Δy (and the angle on the PCB, Δz in 3D, e.g. a part's height above
the board). Points snap to pads, vias, track ends, footprint origins and board
outline corners on the layers shown, and in 3D also to the corners of part
models; hold Shift to measure freely. Esc clears the measurement, a second Esc
leaves the tool.

**3D.** The board with the stackup from the KiCad file (soldermask, finish and
silkscreen colours, layer thicknesses) and component models from KiCad's
library, the project and any extra model sources. Free rotation, camera
presets, and +, − and fit buttons. Models come from the web by default; with
KiCad installed, link it in Settings (see [Linking KiCad](#linking-kicad)) to
load them from disk like KiCad does: faster, offline, and matching your KiCad
version. Other folders can be added as model sources (**Add folder…**). Each
model is looked for in the project first, then in model folders, then in web
sources (URLs, GitHub repositories and GitLab projects); the first found wins. STEP models are
converted once and cached, so a board opens several times faster the second
time.

**BOM.** Grouped by value, footprint and part number fields, filterable,
sortable, with DNP parts marked and a CSV download.

**Live reload.** A local project reloads when you save in KiCad, keeping the
tab, sheet and selection.

## Visual diff

A pull request, commit or branch comparison, side by side or overlaid, of a
GitHub or GitLab repository or a local git copy (its working files too). The list on
the left says what changed; click an item to zoom to it on both sides.

| What | Reported |
|---|---|
| Nets | Which pins joined or left each net, by the pins they connect (a net renamed or redrawn with the same pins isn't a change; re-annotation isn't either) |
| Symbols | Added, removed, value, footprint, fields, DNP, BOM, moved, rotated, unit |
| Library symbols | Pins added or removed; pin name, electrical type, shape, unit, position (swapped pins say whose place they took), length, visibility; body graphics per unit. Reported once with the parts that use the symbol |
| Sheets and labels | Sheets and sheet pins, labels added, removed or renamed, wires and buses, junctions, no-connects, text, title block |
| Footprints | Added, removed, moved, rotated, flipped, reference, value, DNP, attributes, pad nets |
| Inside footprints | Pads by number: size, shape, position, rotation, drill, layers, corner and chamfer settings, custom shapes, solder mask, paste, clearance and zone connection overrides (pads with the same change on one line). Footprint-level overrides, 3D models (file, offset, rotation, scale), silkscreen and other graphics per layer, texts. All compared in the footprint's own frame, so moving or rotating a part adds nothing |
| Routing | Tracks per net, vias |
| Zones | Outline, net, layers, priority, clearance, pad connections, thermal reliefs, minimum width, islands, hatching; rule areas; teardrops in one line (zone fills aren't compared: they're regenerated) |
| Board | Outline, graphics per layer, thickness, copper layers, finish, stackup, solder mask and paste settings |
| Design rules | A table of `.kicad_pro` and `.kicad_dru` changes: constraints, DRC severities, netclasses and which nets they cover, custom rules. A `.kicad_pro` whose rules didn't change is left out |

**Visual diff** in the viewer's project bar compares what's shown: a local
copy's working files (uncommitted edits included) against where the branch
left main, like the pull request would; a GitHub or GitLab branch against the
default branch; a commit from History against its parent; a pull request as
reviewed. The **Before** and **After** labels on the two panes pick each side:
a branch (local and the forge's ones for a local copy), its latest commit or an earlier one,
or a local copy's working files. A branch on the before side counts from where
the after side left it, like a pull request; a commit is compared as it is.

## Pull requests

The second icon in the header lists open pull requests (and GitLab merge
requests) in your remote projects and, once you sign in, those waiting for
your review and your own on the forge you're signed in to, in repositories
with KiCad projects only. Each says how many KiCad files it changes
(schematics, boards, custom rules, and a `.kicad_pro` only when its design
rules changed, as in the visual diff); **Visual diff** and **Hardware** open
it in KiVi.

## Review comments on pull requests

In the visual diff of a pull request, and in the viewer opened at a pull
request (marked *PR #N* in the project bar, *MR !N* on GitLab), press **C** (or **Comment**) and
click a footprint, pad, trace/net, symbol, wire or an empty spot to comment on
it. Comments are pinned on the canvas and listed in the side panel (Open /
Resolved / All); click a pin to read the thread, reply or resolve it. The same
threads show up in both places, numbered the same way; in the schematic the
list covers every sheet and jumps to the one a comment is on.

GitHub and GitLab only take review comments on files the pull request changes. In the
viewer at a pull request, a sheet or board it doesn't change gets **Request
change** instead of **Comment**: the pin becomes a change request (an issue,
see below), made on the pull request's head commit and listed with the
pull request's other issues.

They are ordinary GitHub review comments on the `.kicad_sch` / `.kicad_pcb`
file, so they appear in the pull request conversation and *Files changed*,
notify reviewers, and share GitHub's resolve state both ways. What a comment
points at is kept in a hidden `<!-- kivi:{…} -->` marker (stable UUID /
reference / pad / net name plus the clicked point), so pins follow parts and
nets across later pushes; when the element is gone the pin stays where it was,
marked as not found. A comment on the HDMI connector is stored on GitHub as:

```markdown
Can the HDMI connector move 1 mm towards the edge? The shield tabs touch the keep-out.

<sub>📍 KiVi · footprint **J501**</sub>
<!-- kivi:{"v":1,"type":"footprint","ref":"J501","x":99.09,"y":72.07,"side":"head"} -->
```

On github.com it reads as the text with a small "📍 KiVi · footprint **J501**"
line under it; in KiVi it's a pin on J501.

Reading comments on public repositories works without signing in (resolve
state needs it). Posting, replying and resolving need the GitHub App's *Pull
requests: Read and write* permission.

**On GitLab** a KiVi comment is a discussion on the file (*Comment on this
file*), with the same hidden marker, so it shows in the merge request's
*Overview* and *Changes* and can be replied to and resolved there. GitLab shows
comments only to signed-in users, also on public projects: signed out, the
panel says so instead of listing them. Commenting needs the Developer role on
the project (Reporter can read).

## Change requests as issues

Outside a pull request (a branch of a GitHub or GitLab project, or a local
copy linked to one) the same pins are issues: press **C** (or **Request change**),
click a part, pad, net or spot, give it a title (and details if you like) and
**Open issue**. The issue gets the label `kivi` (created in the repository the
first time) and the same hidden marker, plus the file and commit it was made
on (`"file":"hw/board.kicad_pcb","commit":"3f2a…"`).

Issues are listed in the schematic and PCB side panels (Open / Closed / All)
and pinned like review comments; comment on them, close or reopen them there
or on GitHub or GitLab. Pins follow the part or net on later commits; when it's gone the
pin stays where it was, with the commit it was requested at. The third icon in
the header lists open change requests: those assigned to you and opened by you
once you sign in, and those in your projects; **Hardware** opens one where it's
pinned, in the local copy when there is one.

In a pull request (the viewer at its head, or its visual diff) the
repository's issues are shown too, in green next to the review comments, since
the pull request may be what fixes them. One the pull request already closes
says so; on the others **Close with this PR** (**Close with this MR**) adds
"Fixes #N" ("Closes #N" on GitLab) to the description, so the forge closes the
issue when it's merged (**Close issue** closes it straight away).

KiVi lists only issues labelled `kivi`. GitHub drops the label for people
without write access to the repository; KiVi says so when that happens (a
maintainer can add it). Reading issues of public repositories works without
signing in; opening, commenting and closing need the GitHub App's *Issues:
Read and write* permission. Projects that are only on this computer have no
issues.

**On GitLab** opening an issue needs the Reporter role; the `kivi` label is
created with KiVi's colour the first time. GitLab lists issues signed out,
but shows their comments only to signed-in users.

## Local copies, branches and pushing

A project from the gallery can be worked on in a folder on your computer and
pushed back, without Git installed: KiVi has git built in (libgit2, through the
Rust `git2` crate), with HTTPS going through the same TLS stack as sign-in.

- **Download** (a project card's `⋯` menu) clones the whole repository into
  `<chosen folder>/<repository>` and opens the project from it. **Link**
  instead uses a clone you already have; KiVi checks that it is a clone of
  that repository and never changes its files or history. Once linked, the
  card always opens the local copy; **Unlink** goes back to opening it from
  GitHub or GitLab.
- Each card has a sync icon left of its `⋯` menu (hover it for the details):
  grey when the project isn't on this computer, green when the local copy has
  nothing uncommitted and matches the forge (GitHub or GitLab), yellow
  otherwise; the hover text names the forge. It checks the forge's branch tips (one small request per repository, no download) on **Reload**
  and when the window regains focus.
- The branch button (`⎇ main`) on the right of the project bar lists the
  branches (with a filter); picking one switches to it. For a GitHub or GitLab
  project that reopens the project on that branch; for a local copy it checks
  the branch out (including the forge's branches the copy doesn't have yet,
  marked "on GitHub" or "on GitLab"): uncommitted edits come along, unless that branch changes the same
  files, in which case nothing happens and KiVi says why.
- **History**, next to the branch button, lists the commits on that branch,
  newest first (with a filter and **Show more**). Picking one shows the
  project as it was at that commit, on the same tab, sheet and selection; the
  button then shows the commit (`🕘 07eced8`, in orange) and the menu's first
  item goes back to the latest. For a local copy, while an earlier commit is
  shown, live reload and **Open in KiCad** wait until you're back on the
  working files. Not shown while reviewing a pull request.
- With a local copy open, the branch button also counts the changed files and
  its menu has:
  - **New branch…** creates a branch at the current commit and switches to it;
    uncommitted edits come along. Before the first commit it replaces `main`:
    the first commit starts the new branch.
  - **Commit…** lists the changed files with checkboxes and commits the
    chosen ones with your message, on this computer. The commit author is
    your git identity if the clone has one, else your account on the copy's
    forge with its private e-mail address (GitHub's `…@users.noreply.github.com`,
    GitLab's `…@users.noreply.gitlab.com`).
  - **Push…** (**Push 2 commits…** when it knows how many) pushes the branch
    to the same branch on GitHub or GitLab, then offers to open a pull (merge)
    request. On `main` it warns first, since protected branches refuse it. A
    local project not linked to a forge has no Push. Pushing to GitLab needs
    the Developer role.
  - **Pull…** (**Pull 2 commits…** when the last fetch saw them) brings in
    the forge's commits on the branch: when you have no commits of your own the
    branch simply moves forward, and uncommitted edits stay unless those
    commits changed the same files (then nothing happens and KiVi says so). When both
    sides have commits on *different* files, KiVi combines them in a merge
    commit for you to push. When both changed the *same* file, nothing is
    changed; KiVi lists the files and offers **Move my commits to a new
    branch**: your work (uncommitted edits too) goes to a branch you can push
    and open a pull request from, and the old branch then matches the forge's.
  - Commit and Push are greyed out, saying why, when there's nothing to do. A
    push that the forge refuses because it has newer commits offers **Pull…**.
- The forge is always reached at `https://github.com/<owner>/<repo>.git` or
  `https://gitlab.com/<group>/<project>.git` with your sign-in token (in a
  request header, never stored in the clone, and never sent to any other
  host), so a clone with an SSH remote works too. Resolving a file changed on both sides means
  choosing in KiCad (or with git) which version to keep.

## Linking KiCad

Settings → **KiCad** takes KiCad's program or installation folder (typed, or
**Browse…**): `/usr` or `/usr/bin/kicad` on Linux,
`C:\Program Files\KiCad\10.0` on Windows, `/Applications/KiCad` on macOS.
KiVi checks it with `kicad-cli version` (so KiCad 7 or later) and lists what it
found. Linking is never automatic; an empty box unlinks it.

- **3D models**: KiVi expands KiCad's path variables the way KiCad does: the
  installation's library (`${KICAD10_3DMODEL_DIR}`), the Plugin and Content
  Manager's add-ons (`${KICAD10_3RD_PARTY}`) and your *Preferences → Configure
  Paths* variables, with environment variables winning. A model path using one
  is loaded from exactly that place (after the project's own copy), and other
  KiCad versions' library variables map to the linked library. The library and
  add-on folders are also searched by file name like any model folder.
- **Open in KiCad**: a button next to the branch button when a project is open,
  and an item in each project card's `⋯` menu. It opens the project's
  `.kicad_pro` in KiCad's project manager; saving in KiCad reloads the view.
  It's greyed out (hover it for why) until KiCad is linked, for projects that
  aren't on this computer (a GitHub or GitLab project without a local copy: **Download**
  or **Link** it first), and for projects without a `.kicad_pro`.

## Signing in to GitHub and GitLab

KiVi works with GitHub and with GitLab (gitlab.com), signed in to one of them
at a time. **Sign in** in the account menu asks which, with each forge's logo
(loaded from GitHub and GitLab themselves: KiVi doesn't ship their logos, so
offline the buttons show only the names); signing in to the other one later
signs you out of the first, and the dialog says so. Projects added with
**Remote project…** from either forge stay in the gallery and the lists
whoever you're signed in as (public ones work signed out), with a GitLab tag
on GitLab projects. In GitLab's words a pull
request is a merge request (`!5`), and a review comment a discussion on a
file. Sign-in is the only way to give KiVi access: there is no token to paste.

### GitHub

Sign-in uses a GitHub App (free, no server). Signing in from the account menu
shows a one-time code (like `WDJB-MJHT`) and a **Copy code and open GitHub**
button; you paste the code on github.com/login/device and approve KiVi, and
the dialog finishes by itself. If the App isn't installed on any of your
accounts yet, it then offers **Install on GitHub** to choose the repositories.

- The token only reaches repositories where the App is **installed** (and you
  have access); public repositories are readable regardless. The account menu
  has **Repository access** for changing it later. "Waiting for your review"
  only lists pull requests in repositories the App can see.
- Tokens expire after 8 hours and are renewed automatically (when a page
  opens, on a timer, and when the window regains focus) with a refresh token
  valid for 6 months. Device-flow tokens refresh without the client secret, so
  none is shipped.
- An organisation that restricts third-party access may need an owner to
  approve the installation.
- Permissions the App needs (repository permissions): *Metadata: Read-only*,
  *Pull requests: Read and write* (review comments), *Issues: Read and write*
  (change requests) and *Contents: Read and write* (reading files, and pushing
  from a local copy). After raising a permission in the App's settings, each
  installation has to accept it once.
- Without signing in, GitHub allows 60 API requests an hour from your network;
  a large gallery uses them up quickly. Signed in, the limit is 5,000.

### GitLab

Sign-in uses an OAuth application on gitlab.com (free, no server), with the
same one-time code: **Copy code and open GitLab**, paste it on gitlab.com and
approve KiVi. KiVi builds have the application built in
(`KIVI_GITLAB_CLIENT_ID`); otherwise the dialog asks for its Application ID.
To register one: gitlab.com → Preferences → **Applications** → *Add new
application*, any name and redirect URI, **Confidential unticked**, scopes
**api** and **write_repository**.

- Signed in, the gallery lists every project you're a member of (Reporter or
  above, not archived); **Remove from projects** hides one, as for GitHub.
- Tokens expire after 2 hours and are renewed automatically, like GitHub's.
- Merge requests, review comments, issues and pushing need the matching role
  on the project: Reporter for issues, Developer for comments on merge
  requests and for pushing (protected branches may need more).
- Signed out, GitLab shows public projects and their merge requests and
  issues, but **no comments** (it answers those only to signed-in users), and
  it limits requests from your network tightly (a few hundred every few
  minutes); a big repository is listed 100 files per request.
- Only gitlab.com for now, not self-hosted GitLab servers.

## Links into the viewer

```
index.html#gh=owner/repo@main:hardware&tab=pcb&sel=U3     project in a repository
index.html#gh=owner/repo&pr=owner/repo%2312               … at a pull request's head, with its review comments
index.html#folder=/path/to/project                        local folder
index.html#folder=/path/to/project&commit=<sha>           … at a commit (git copies)
index.html#gh=owner/repo&file=hw/board.kicad_pcb&thread=12  … on issue #12's pin (also with folder=)
diff.html#gh=owner/repo&pr=42                             visual diff of a pull request
diff.html#gh=owner/repo&commit=<sha>                      … of a commit
diff.html#gh=owner/repo&base=main&head=feature&file=hw/board.kicad_pcb
diff.html#gh=owner/repo&head=feature                      … against the default branch
diff.html#local=/path/to/copy[&base=<ref>][&head=<ref>]   a local copy (no head: its working files)
index.html#gl=group/sub/project@main:hardware&tab=pcb     a GitLab project (any gh= link works with gl=)
index.html#gl=group/project&pr=group/project%235          … at merge request !5's head
diff.html#gl=group/project&pr=5                           visual diff of merge request !5
inbox.html#projects, #prs, #issues                        home screen views
```

`gh=` takes `owner/repo`, `owner/repo@branch:path/to/project` or any
`https://github.com/owner/repo/tree/<ref>/<path>` URL; `gl=` the same for
GitLab (`group/sub/project`, or `https://gitlab.com/group/project/-/tree/<ref>/<path>`).

## How the gallery stays fast

- Repositories come from the GitHub App's installations (signed in to GitHub)
  or your GitLab member projects (signed in to GitLab), plus your remote
  projects from either. Each repository's default branch is listed and cached
  until its last push or default branch changes, so **Reload** with no new
  commits only costs the repository listing. GitHub lists a branch in one
  request; GitLab 100 files per request, so a big GitLab project's first scan
  takes longer, and its board sizes aren't known, so a very large GitLab
  board still gets a preview attempt.
- Thumbnails are the realistic front face (soldermask, copper, silkscreen),
  clipped to the board outline, rendered in the background when a card
  scrolls into view and cached by the board file's git blob SHA, so each board
  version is downloaded and rendered once. Boards over 30 MB aren't previewed.
- The grid renders 48 cards at a time and adds more as you scroll. A
  rate-limit error stops the scan and keeps what it found.
