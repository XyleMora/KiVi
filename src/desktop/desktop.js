// Desktop additions to the viewer (index.html) and diff (diff.html) pages.
// Loaded after the page's own module; does nothing outside the Tauri app.

import { ensureFreshToken, GitRevSource, isDesktop, invoke, kicadAction, listen, ModelDirSource, onDrop, openFolder, openInKicad, projectPath, routeExternalLinks, TauriSource } from "./tauri.js";
import { $, toast } from "../app/ui.js";
import { initHeader } from "./account.js";
import { localGitApi, mountGitMenu } from "./git.js";

if (isDesktop) {
  document.body.classList.add("desktop");
  routeExternalLinks();
  ensureFreshToken(); // and keeps refreshing it while the page is open

  // The brand goes back to the home page (projects and pull requests).
  const brand = $(".brand");
  if (brand) brand.href = "inbox.html";

  // Home icons and the account menu, as on the home page. Signing in or out reloads
  // the page, which restores the view from the URL with the new access.
  initHeader().renderAccount();

  if (window.kivi) setUpViewer(); // the viewer (index.html)
  // The diff page compares a local git copy with main (diff.html#local=…) through these.
  window.kiviDiff?.attachLocalGit(localGitApi());
}

function setUpViewer() {
  const app = window.kivi;
  app.openModelDir = (path) => new ModelDirSource(path); // folder model sources from Settings, and the linked KiCad's

  onDrop({
    enter: () => document.body.classList.add("dragging"),
    leave: () => document.body.classList.remove("dragging"),
    drop: (folder, project) => show(folder, project ? { project } : null),
  });

  // A local folder that is a git copy gets the branch menu (new branch, diff, commit and push)
  // and the history menu, which shows the folder at an earlier commit (`viewing`) instead of the working files.
  let gitMenu = null;
  let folder = null;
  let viewing = null;
  window.addEventListener("focus", () => gitMenu?.refresh()); // it may have been committed elsewhere
  // Opening a GitHub repository (the viewer's own box) leaves the local folder behind;
  // main.js then shows that repository's branch menu in place of the local one.
  const openSource = app.openSource.bind(app);
  app.openSource = async (src, state) => {
    const r = await openSource(src, state);
    if (src.kind !== "local") gitMenu = null;
    updateKicadButton();
    return r;
  };

  // Open in KiCad, next to the branch button: greyed out until KiCad is linked
  // in Settings, and for projects that aren't on this computer.
  const kicadButton = $("#open-kicad");
  kicadButton.hidden = false;
  // The project's file on disk (kicadAction says so when it isn't a .kicad_pro), or null.
  const projectFile = () => {
    const e = app.entry;
    return app.source instanceof TauriSource && e ? projectPath(app.source.path, e.pro ?? e.pcb ?? e.sch) : null;
  };
  function updateKicadButton() {
    const { ok, title } = kicadAction(projectFile(), app.source instanceof GitRevSource ? "Showing an earlier commit: go back to the working files (History) to open it in KiCad" : undefined);
    kicadButton.setAttribute("aria-disabled", String(!ok));
    kicadButton.title = title;
  }
  kicadButton.addEventListener("click", () => {
    if (kicadButton.getAttribute("aria-disabled") === "true") return toast(kicadButton.title, true);
    openInKicad(projectFile()).catch((e) => toast(e.message ?? String(e), true));
  });
  window.addEventListener("kivi:settings", updateKicadButton);
  updateKicadButton();

  /** Open a folder (watched for live reload), at its working files or at `commit`. */
  async function show(path, state = null, commit = null) {
    try {
      const working = await openFolder(path);
      await app.openSource(commit ? await GitRevSource.open(path, commit) : working, state);
      document.title = `${app.project?.name ?? "KiVi"} — ${path}`;
      folder = path;
      viewing = commit;
      gitMenu = mountGitMenu(path, { viewing: () => viewing, show: showCommit });
    } catch (e) {
      toast(e.message ?? String(e), true);
    }
  }

  // The tab, sheet and selection, to keep when the same project is opened again.
  const viewState = () => {
    const tab = app.tab;
    return {
      project: app.entry ? (app.entry.pro ?? app.entry.sch ?? app.entry.pcb) : null,
      tab,
      page: tab === "sch" ? app.sch.pageIndex : 0,
      sel: tab === "pcb" ? app.pcb.selectedRef : tab === "sch" ? app.sch.selectedRef : null,
    };
  };

  /** The open folder at a commit (history menu), or with null its working files again. */
  async function showCommit(sha) {
    const path = folder;
    const src = sha ? await GitRevSource.open(path, sha) : await openFolder(path);
    await app.openSource(src, viewState());
    if (app.source === src) viewing = sha; // else it couldn't be shown (openSource said why)
    gitMenu?.refresh();
  }

  // KiCad saved something: reload in place, keeping the tab, sheet and selection.
  let reloading = false;
  listen("folder-changed", async (e) => {
    // An earlier commit stays as it is; only the change count moves.
    if (app.source instanceof GitRevSource) return gitMenu?.refresh();
    if (!(app.source instanceof TauriSource) || reloading) return;
    reloading = true;
    try {
      const src = app.source;
      src.files = await invoke("list_folder");
      await app.openSource(src, viewState());
      gitMenu?.refresh(); // the change count moved
      const names = e.payload.map((p) => p.split("/").pop());
      toast(`Reloaded: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""} changed`);
    } finally {
      reloading = false;
    }
  });

  // Folder from the home page, the command line or the visual diff
  // (index.html#folder=/path[&project=x.kicad_pro][&commit=<sha>]).
  const hash = new URLSearchParams(location.hash.slice(1));
  const fromHash = hash.get("folder");
  if (fromHash) show(fromHash, { project: hash.get("project") ?? undefined, tab: hash.get("tab") ?? undefined }, hash.get("commit"));
}
