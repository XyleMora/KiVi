// Desktop additions to the viewer (index.html) and diff (diff.html) pages.
// Loaded after the page's own module; does nothing outside the Tauri app.

import { ensureFreshToken, isDesktop, invoke, listen, onDrop, openFolder, pickFolder, routeExternalLinks, TauriSource } from "./tauri.js";
import { $, toast } from "../app/ui.js";
import { initHeader } from "./account.js";

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

  if (window.kivi) setUpViewer(); // the viewer (index.html); the diff page has no folders
}

function setUpViewer() {
  const app = window.kivi;

  // "Open" with an empty repository box picks a local folder (the viewer's own
  // handler opens a repository when there is one).
  $("#gh-form").addEventListener("submit", async () => {
    if ($("#gh-input").value.trim()) return;
    const path = await pickFolder();
    if (path) await show(path);
  });
  onDrop({
    enter: () => document.body.classList.add("dragging"),
    leave: () => document.body.classList.remove("dragging"),
    drop: (folder, project) => show(folder, project ? { project } : null),
  });

  async function show(path, state = null) {
    try {
      await app.openSource(await openFolder(path), state);
      document.title = `${app.project?.name ?? "KiVi"} — ${path}`;
    } catch (e) {
      toast(e.message ?? String(e), true);
    }
  }

  // KiCad saved something: reload in place, keeping the tab, sheet and selection.
  let reloading = false;
  listen("folder-changed", async (e) => {
    if (!(app.source instanceof TauriSource) || reloading) return;
    reloading = true;
    try {
      const src = app.source;
      src.files = await invoke("list_folder");
      const tab = app.tab;
      const state = {
        project: app.entry ? (app.entry.pro ?? app.entry.sch ?? app.entry.pcb) : null,
        tab,
        page: tab === "sch" ? app.sch.pageIndex : 0,
        sel: tab === "pcb" ? app.pcb.selectedRef : tab === "sch" ? app.sch.selectedRef : null,
      };
      await app.openSource(src, state);
      const names = e.payload.map((p) => p.split("/").pop());
      toast(`Reloaded: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""} changed`);
    } finally {
      reloading = false;
    }
  });

  // Folder from the home page or the command line (index.html#folder=/path[&project=x.kicad_pro]).
  const hash = new URLSearchParams(location.hash.slice(1));
  const fromHash = hash.get("folder");
  if (fromHash) show(fromHash, hash.get("project") ? { project: hash.get("project") } : null);
}
