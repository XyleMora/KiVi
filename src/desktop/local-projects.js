// Local projects in the gallery: folders the user added with the "+" button,
// shown as cards next to the GitHub projects. Each folder can hold several
// projects. A folder that isn't in a git repository becomes one (git init, on
// main) when it is added, or read again if it was added before. It can be
// linked to a GitHub repository (Link to GitHub…: a git remote), which enables
// View on GitHub, the sync icon and pushing from the viewer.
//
// The folders are kept in settings.localProjects (a list of paths). A folder
// that is a clone of a repository already in the gallery isn't added: it is
// linked to that repository's card instead (settings.localCopies, git.js).

import { escapeHtml, settings, saveSettings, toast } from "../app/ui.js";
import { forge } from "../forge/index.js";
import { findProjects } from "../project.js";
import { dialog, localCopy, setLocalCopy } from "./git.js";
import { ensureFreshToken, invoke, pickFolder } from "./tauri.js";

const folders = () => settings().localProjects ?? [];
const sameFolder = (a, b) => a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");

function saveFolders(list) {
  saveSettings({ ...settings(), localProjects: list });
}

/** The folder's KiCad projects as gallery entries, or one "missing" entry if it can't be read. */
async function scanFolder(folder) {
  let files;
  try {
    files = await invoke("scan_kicad_folder", { dir: folder });
  } catch (e) {
    return [{ local: true, missing: true, folder, key: `local:${folder}`, name: folder.split(/[\\/]/).filter(Boolean).pop() ?? folder, error: String(e) }];
  }
  const byPath = new Map(files.map((f) => [f.path, f]));
  // Without a .kicad_pro, findProjects lists every loose schematic (sub-sheets too); keep only boards then, as for GitHub.
  const found = findProjects(files.map((f) => f.path)).filter((p) => p.pro || p.pcb);
  if (!found.length) return []; // refused when added: no repository made for it
  // Every local project is in a git repository: one is made if there's none yet.
  const git = await invoke("git_info", { path: folder }).catch(() =>
    invoke("git_init", { path: folder }).catch((e) => {
      console.warn(`git init ${folder}:`, e);
      return null;
    }),
  );
  return found.map((p) => {
    const own = [p.pro, p.pcb, ...(p.sch ? [p.sch] : [])].map((f) => byPath.get(f)).filter(Boolean);
    const pcb = p.pcb ? byPath.get(p.pcb) : null;
    return {
      local: true,
      folder,
      key: `local:${folder}:${p.pro ?? p.pcb}`,
      name: p.name,
      dir: p.dir,
      pro: p.pro,
      sch: p.sch,
      pcb: p.pcb,
      pcbSize: pcb?.size ?? 0,
      // The thumbnail cache key: a new one when the board file changes.
      pcbStamp: pcb ? `${folder}\n${p.pcb}\n${pcb.size}\n${pcb.modified}` : null,
      pushed: new Date(Math.max(...own.map((f) => f.modified)) * 1000).toISOString(),
      git: git?.owner ? { nwo: `${git.owner}/${git.repo}`, branch: git.branch, root: git.root } : null,
    };
  });
}

/** Gallery entries of every local project folder. */
export async function localProjects() {
  return (await Promise.all(folders().map(scanFolder))).flat();
}

/** The text of a local project's board file (for its thumbnail). */
export async function readLocalBoard(p) {
  return new TextDecoder().decode(new Uint8Array(await invoke("read_kicad_file", { dir: p.folder, path: p.pcb })));
}

/** Link a clone to the gallery card of its repository instead of adding it. */
function adopt(nwo, root) {
  setLocalCopy(nwo, root);
  toast(`${root} is a clone of ${nwo}: its card now opens this folder`);
}

/**
 * "+": pick a folder and add its projects to the gallery. `inGallery(nwo)` tells
 * whether a repository already has cards there. Resolves true when something changed.
 */
export async function addLocalProject(inGallery) {
  const folder = await pickFolder("Add a KiCad project folder");
  if (!folder) return false;
  if (folders().some((f) => sameFolder(f, folder))) {
    toast("That folder is already in the gallery");
    return false;
  }
  const projects = await scanFolder(folder);
  if (projects[0]?.missing) throw new Error(`Couldn't read ${folder}: ${projects[0].error}`);
  if (!projects.length) throw new Error(`No KiCad project in ${folder}`);
  const git = projects[0].git;
  if (git && inGallery(git.nwo)) {
    adopt(git.nwo, git.root);
    return true;
  }
  saveFolders([...folders(), folder]);
  toast(projects.length === 1 ? `Added ${projects[0].name}` : `Added ${projects.length} projects from ${folder}`);
  return true;
}

/**
 * Local folders linked to a GitHub repository that has cards in the gallery
 * (linked first, the repository added after, or listed by Reload) become that
 * repository's local copy, so the project shows once, as the GitHub card.
 * `locals` are localProjects() entries. Returns true when something changed.
 */
export function adoptLinkedFolders(locals, inGallery) {
  let changed = false;
  for (const p of locals) {
    if (!p.git || !inGallery(p.git.nwo) || !folders().some((f) => sameFolder(f, p.folder))) continue;
    const copy = localCopy(p.git.nwo);
    if (copy && !sameFolder(copy, p.git.root)) continue; // another clone is that card's copy: keep both
    saveFolders(folders().filter((f) => !sameFolder(f, p.folder)));
    if (!copy) setLocalCopy(p.git.nwo, p.git.root);
    toast(`${p.folder} is linked to ${p.git.nwo}: its card now opens this folder`);
    changed = true;
  }
  return changed;
}

/** Remove a folder from the gallery; nothing on disk changes. */
export function removeLocalProject(folder) {
  saveFolders(folders().filter((f) => !sameFolder(f, folder)));
  toast(`Removed ${folder} from the gallery; the folder is untouched`);
}

/**
 * Link to GitHub…: ask for the repository and add it as the folder's git remote
 * (git_link_github). The repository must exist; an empty one is best, since
 * KiVi can't merge a history GitHub already has. Resolves true once linked.
 */
export function linkLocalProject(p, inGallery) {
  const host = forge();
  return new Promise((resolve) => {
    const dlg = dialog(`<form method="dialog" class="settings">
      <h2>Link to GitHub</h2>
      <p class="muted settings-hint">Adds the repository as a git remote of <code>${escapeHtml(p.folder)}</code>. Nothing is uploaded until you commit and push from the project's branch menu. Use an empty repository: <a href="${escapeHtml(host.web.newRepo)}">create one on GitHub</a>.</p>
      <label class="field-label" for="link-repo">GitHub repository</label>
      <input id="link-repo" class="input mono" required spellcheck="false" autocomplete="off" placeholder="owner/repo or ${escapeHtml(host.web.repo("owner/repo"))}">
      <p class="muted settings-hint error-text" id="link-error" hidden></p>
      <div class="row end gap"><button value="cancel" class="btn" formnovalidate>Cancel</button><button value="ok" class="btn primary">Link</button></div>
    </form>`);
    const box = dlg.querySelector("#link-repo");
    const error = dlg.querySelector("#link-error");
    const form = dlg.querySelector("form");
    // Checked before the dialog closes, so a typo can be fixed in place.
    form.addEventListener("submit", async (e) => {
      if (e.submitter?.value !== "ok") return;
      e.preventDefault();
      const gh = host.parseSpec(box.value.trim());
      const fail = (msg) => {
        error.textContent = msg;
        error.hidden = false;
      };
      if (!gh || gh.ref || gh.path || gh.rest) return fail(`Enter the repository as owner/repo or its ${host.host} address`);
      try {
        // Its real name and case, and whether this account can see it.
        const r = await host.repo(`${gh.owner}/${gh.repo}`, await ensureFreshToken());
        const [owner, repo] = r.nwo.split("/");
        const info = await invoke("git_link_github", { path: p.folder, owner, repo });
        dlg.close("linked");
        if (inGallery(r.nwo)) {
          // The repository has cards already: the folder becomes their local copy.
          saveFolders(folders().filter((f) => !sameFolder(f, p.folder)));
          adopt(r.nwo, info.root);
        } else toast(`Linked ${p.folder} to ${r.nwo}`);
        resolve(true);
      } catch (err) {
        fail(err.status === 404 ? `${gh.owner}/${gh.repo} isn't on ${host.name}, or this account can't see it` : String(err.message ?? err));
      }
    });
    dlg.addEventListener("close", () => dlg.returnValue !== "linked" && resolve(false));
  });
}
