// Home screen project grid: every KiCad project in the repositories the
// signed-in user can reach (where the GitHub App is installed), plus remote
// projects (watched repositories), each as a
// card with a rendered board thumbnail.
//
// API cost is kept low with two caches:
//   - the project list per repository (localStorage), reused until the
//     repository's last push or default branch changes, so a refresh without
//     new commits costs only the repository listing;
//   - thumbnails (IndexedDB), keyed by the board file's git blob SHA, so a board
//     is fetched and rendered once per version.

import { escapeHtml, settings, toast, tokenFor } from "../app/ui.js";
import { FORGES, forge, forgeNames, parseRepoKey, repoKey } from "../forge/index.js";
import { findProjects } from "../project.js";
import { cloneProject, forgetSync, knownSync, linkProject, localCopy, localViewUrl, syncState, unlinkLocalCopy } from "./git.js";
import { kicadAction, openInKicad, projectPath } from "./tauri.js";
import { addLocalProject, adoptLinkedFolders, linkLocalProject, localProjects, readLocalBoard, removeLocalProject } from "./local-projects.js";
import { addRemoteProject, mountAddMenu, removeRepo } from "./add-project.js";

const INDEX_KEY = "kivi.projectIndex";
const THUMB_W = 640, THUMB_H = 400;
const PAGE = 48; // cards rendered at a time; more as the end of the grid scrolls into view
const MAX_PREVIEW = 30e6; // bytes; bigger boards (KiCad's 85 MB Jetson demo) take minutes and a lot of memory to parse
// ---- repositories and projects ------------------------------------------------------
// Repositories of every forge are kept by key (repoKey: "owner/repo" on GitHub,
// "gitlab:group/project" on GitLab), in the index and in settings.watchRepos /
// hiddenRepos.

/** Repository keys grouped by forge: Map forge id → [nwo]. */
function byForge(keys) {
  const out = new Map();
  for (const k of keys) {
    const r = parseRepoKey(k);
    if (r) out.set(r.forge.id, [...(out.get(r.forge.id) ?? []), r.nwo]);
  }
  return out;
}

/**
 * Repositories to scan, from every forge: the signed-in account's, then remote
 * projects, less those removed from projects. Each is a RepoInfo plus `forge`
 * and `key`. A forge that can't be listed is reported in `errors`, the others still are.
 */
async function listRepos() {
  const watched = byForge(settings().watchRepos ?? []);
  // Removed from the gallery by the user (Remove from projects), until added again.
  const hidden = byForge(settings().hiddenRepos ?? []);
  const out = [];
  out.errors = [];
  await Promise.all(
    FORGES.filter((f) => tokenFor(f) || watched.has(f.id)).map(async (f) => {
      try {
        const repos = await f.listRepos(tokenFor(f), { watched: watched.get(f.id) ?? [], hidden: new Set((hidden.get(f.id) ?? []).map((h) => h.toLowerCase())) });
        for (const r of repos) out.push({ ...r, forge: f, key: repoKey(f, r.nwo) });
      } catch (e) {
        out.errors.push(`${f.name}: ${e.message}`);
      }
    }),
  );
  return out;
}

function loadIndex() {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function saveIndex(index) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    /* storage full or unavailable: rescan next time */
  }
}

/** Projects of one repository at its default branch (one tree listing). @param {import("../forge/index.js").RepoInfo & {forge: object}} r */
async function scanRepo(r) {
  const tree = await r.forge.tree(r.nwo, r.defaultBranch, tokenFor(r.forge));
  const blobs = new Map(tree.files.filter((e) => /\.kicad_(pro|sch|pcb)$/.test(e.path)).map((e) => [e.path, e]));
  // Without a .kicad_pro, findProjects lists every loose schematic (sub-sheets too); keep only boards then.
  const projects = findProjects([...blobs.keys()])
    .filter((p) => p.pro || p.pcb)
    .map((p) => ({ name: p.name, dir: p.dir, pro: p.pro, sch: p.sch, pcb: p.pcb, pcbSha: blobs.get(p.pcb)?.sha ?? null, pcbSize: blobs.get(p.pcb)?.size ?? null })); // null: not listed (GitLab)
  return {
    repo: { nwo: r.nwo, private: r.private, archived: r.archived, forge: r.forge.id },
    pushed: r.pushedAt,
    branch: r.defaultBranch,
    truncated: !!tree.truncated,
    projects,
  };
}

// ---- repositories with projects (the pull request list) ---------------------------------

const KICAD_REPOS_KEY = "kivi.kicadRepos"; // {repository key: {pushed, branch, has}}

/**
 * Repositories (keys) in the gallery with KiCad projects, as last scanned (the
 * project index), plus remote projects, less those removed from projects. No
 * requests: the Issues view searches these.
 */
export function galleryRepos() {
  const hidden = new Set((settings().hiddenRepos ?? []).map((h) => h.toLowerCase()));
  const out = new Map();
  for (const [k, e] of Object.entries(loadIndex())) if (e?.projects?.length || e?.truncated) out.set(k.toLowerCase(), k);
  for (const k of settings().watchRepos ?? []) if (!out.has(k.toLowerCase())) out.set(k.toLowerCase(), k);
  return [...out].filter(([k]) => !hidden.has(k)).map(([, k]) => k);
}

/**
 * Whether a repository (its key) has KiCad projects (as the gallery counts
 * them), for showing only its pull requests. The gallery's index answers
 * without a request; other repositories cost one request (more when pushed to
 * since the last check) and are remembered. Rejects when the forge can't tell (not cached).
 */
export async function repoHasProjects(key) {
  const known = loadIndex()[key];
  if (known) return known.projects.length > 0 || known.truncated;
  let cache;
  try {
    cache = JSON.parse(localStorage.getItem(KICAD_REPOS_KEY) ?? "{}");
  } catch {
    cache = {};
  }
  const { forge: f, nwo } = parseRepoKey(key);
  const r = { ...(await f.repo(nwo, tokenFor(f))), forge: f };
  const k = repoKey(f, r.nwo);
  const hit = cache[k];
  if (hit && hit.pushed === r.pushedAt && hit.branch === r.defaultBranch) return hit.has;
  const scanned = await scanRepo(r);
  // A truncated tree may hide projects: show its pull requests rather than lose them.
  const has = scanned.projects.length > 0 || scanned.truncated;
  try {
    cache = JSON.parse(localStorage.getItem(KICAD_REPOS_KEY) ?? "{}"); // other checks ran meanwhile
    localStorage.setItem(KICAD_REPOS_KEY, JSON.stringify({ ...cache, [k]: { pushed: r.pushedAt, branch: r.defaultBranch, has } }));
  } catch {
    /* storage unavailable: checked again next time */
  }
  return has;
}

// ---- thumbnails -------------------------------------------------------------------------

let dbPromise = null;
function db() {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("kivi-thumbs", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("thumbs");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}
async function idb(mode, fn) {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const tx = d.transaction("thumbs", mode);
      const req = fn(tx.objectStore("thumbs"));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return undefined; // no IndexedDB: thumbnails last for this page only
  }
}

/** Board SVG from a worker of its own, ended afterwards: frees the parse's memory, and a slow board can't hold up the others. */
function renderInWorker(text, name) {
  const worker = new Worker(new URL("./thumb-worker.js", import.meta.url), { type: "module" });
  let timer;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("took too long")), 120_000);
    worker.onmessage = ({ data }) => (data.error ? reject(new Error(data.error)) : resolve(data));
    worker.onerror = (e) => reject(new Error(e.message || "worker failed"));
    worker.postMessage({ id: 0, text, name });
  }).finally(() => {
    clearTimeout(timer);
    worker.terminate();
  });
}

/** SVG → small raster image, so the grid doesn't keep dozens of heavy SVGs alive. */
async function rasterize({ svg, w, h }) {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(THUMB_W / w, THUMB_H / h);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/webp", 0.88));
  } finally {
    URL.revokeObjectURL(url);
  }
}

const thumbUrls = new Map(); // blob SHA → object URL
const thumbJobs = new Map(); // blob SHA → Promise<url>
let running = 0;
const queue = [];
function limited(fn) {
  return new Promise((resolve, reject) => {
    queue.push(() => fn().then(resolve, reject));
    pump();
  });
}
function pump() {
  while (running < 2 && queue.length) {
    running++;
    queue.shift()().finally(() => {
      running--;
      pump();
    });
  }
}

/** The thumbnail cache key: the board's git blob SHA on its forge, or its path, size and time on disk. */
const thumbKey = (p) => p.pcbSha ?? p.pcbStamp ?? null;

/** Object URL of a project's board thumbnail (cached, rendered on first use). */
function thumbnail(p) {
  const k = thumbKey(p);
  if (thumbUrls.has(k)) return Promise.resolve(thumbUrls.get(k));
  if (!thumbJobs.has(k)) {
    const job = (async () => {
      let blob = await idb("readonly", (s) => s.get(k));
      if (!blob) {
        blob = await limited(async () => {
          const r = p.local ? null : parseRepoKey(p.repoKey);
          const text = p.local ? await readLocalBoard(p) : await r.forge.source({ owner: r.owner, repo: r.repo, ref: p.branch, token: tokenFor(r.forge) }).readText(p.pcb);
          return rasterize(await renderInWorker(text, p.pcb));
        });
        await idb("readwrite", (s) => s.put(blob, k));
      }
      const url = URL.createObjectURL(blob);
      thumbUrls.set(k, url);
      return url;
    })();
    job.finally(() => thumbJobs.delete(k)).catch(() => {}); // failures aren't cached: try again next time
    thumbJobs.set(k, job);
  }
  return thumbJobs.get(k);
}

// ---- grid ---------------------------------------------------------------------------------

const BOARD_ICON = `<svg class="project-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor"/><rect x="5" y="5.5" width="6" height="5" rx="0.5" fill="currentColor"/><path d="M1.5 7h2M1.5 9.5h2M12.5 7h2M12.5 9.5h2" stroke="currentColor"/></svg>`;
/** Two arrows in a circle; coloured by the local copy's sync state (git.js syncState). */
const SYNC_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.2 6.4A5.3 5.3 0 0 0 3.6 4.4L2.6 5.6"/><path d="M2.6 2.6v3h3"/><path d="M2.8 9.6a5.3 5.3 0 0 0 9.6 2l1-1.2"/><path d="M13.4 13.4v-3h-3"/></svg>`;
const FOLDER_ICON = `<svg width="12" height="12" viewBox="0 0 16 16" aria-label="On this computer" role="img"><path d="M1.5 3.5h4.2l1.5 1.5h7.3v8.5h-13z" fill="currentColor"/></svg>`;
const LOCK_ICON = `<svg width="12" height="12" viewBox="0 0 16 16" aria-label="Private" role="img"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;

function when(iso) {
  const d = new Date(iso);
  const thisYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, { month: "short", day: "numeric", ...(thisYear ? { hour: "numeric", minute: "2-digit" } : { year: "numeric" }) });
}

const tooBig = (p) => p.pcbSize > MAX_PREVIEW;

function thumbHtml(p) {
  const url = thumbKey(p) && thumbUrls.get(thumbKey(p));
  return !p.pcb
    ? `<span class="thumb-note">Schematic only</span>`
    : tooBig(p)
      ? `<span class="thumb-note">Board too large to preview</span>`
      : url
      ? `<img src="${url}" alt="">`
      : `<span class="thumb-note pending">Rendering board…</span>`;
}

/** The forge's name next to a repository, on every forge card (the user's choice), and on local cards linked to one. */
const forgeTag = (f) => (f ? ` <span class="tag forge-tag">${escapeHtml(f.name)}</span>` : "");

function cardHtml(p) {
  if (p.local) return localCardHtml(p);
  const f = forge(p.forge);
  const spec = `${p.nwo}@${p.branch}:${p.pro ?? p.pcb}`;
  const local = localCopy(p.repoKey);
  // A linked project always opens from its local copy; otherwise from its forge.
  const view = (tab) => (local ? localViewUrl(local, p.pro ?? p.pcb, tab) : `index.html#${new URLSearchParams({ [f.hashKey]: spec, ...(tab && { tab }) })}`);
  const web = f.web.tree(p.nwo, p.branch, p.dir);
  const thumb = thumbHtml(p);
  const where = p.dir ? `${p.nwo}/${p.dir}` : p.nwo;
  // Linked: the views above open the copy; otherwise download the repository or link a clone.
  const localItems = local
    ? `<button type="button" data-git="unlink" title="${escapeHtml(`Stop using the local copy in ${local} (the folder is kept)`)}">Unlink</button>`
    : `<button type="button" data-git="clone" title="Download the repository to a folder on this computer">Download</button><button type="button" data-git="link" title="Use a clone of this repository that's already on this computer">Link</button>`;
  // Greyed out until KiCad is linked in Settings, and without a local copy to open.
  const kicad = kicadAction(local ? projectPath(local, p.pro ?? p.pcb) : null, "Download or Link this repository first: KiCad opens the local copy");
  return `<li class="project-card" data-key="${escapeHtml(p.key)}">
    <a class="project-thumb" href="${escapeHtml(view())}" tabindex="-1" aria-hidden="true">${thumb}</a>
    <div class="project-info">
      <div class="project-title">${BOARD_ICON}<a href="${escapeHtml(view())}" title="${escapeHtml(p.pro ?? p.pcb)}">${escapeHtml(p.name)}</a>
        ${syncIconHtml(p, local)}
        <details class="menu card-menu">
          <summary class="btn small" aria-label="More actions for ${escapeHtml(p.name)}">⋯</summary>
          <div class="card-menu-list">
            ${p.sch ? `<a href="${escapeHtml(view("sch"))}">Schematic</a>` : ""}
            ${p.pcb ? `<a href="${escapeHtml(view("pcb"))}">PCB</a><a href="${escapeHtml(view("3d"))}">3D view</a>` : ""}
            <a href="${escapeHtml(view("bom"))}">Bill of materials</a>
            <button type="button" data-kicad aria-disabled="${!kicad.ok}" title="${escapeHtml(kicad.title)}">Open in KiCad</button>
            <a href="${escapeHtml(web)}">View on ${escapeHtml(f.name)}</a>
            <hr>
            ${localItems}
            <button type="button" data-repo="remove" title="${escapeHtml(`Stop showing ${p.nwo} in the gallery and the ${f.words.pr} list${p.repoCount > 1 ? ` (all its ${p.repoCount} projects)` : ""}; Reload brings it back`)}">Remove from projects</button>
          </div>
        </details>
      </div>
      <div class="project-meta muted" title="${escapeHtml(`${where} @ ${p.branch}`)}">${p.private ? LOCK_ICON : ""}<span>${escapeHtml(where)}</span>${forgeTag(f)}${p.archived ? ` <span class="tag">archived</span>` : ""}</div>
      <div class="project-meta muted">${escapeHtml(when(p.pushed))}</div>
    </div>
  </li>`;
}

/** "a/b" when `folder` is inside `root` (both paths on this computer), else "". */
function relativeTo(root, folder) {
  const norm = (x) => x.replace(/\\/g, "/").replace(/\/+$/, "");
  const [r, f] = [norm(root), norm(folder)];
  return f.startsWith(`${r}/`) ? f.slice(r.length + 1) : "";
}

/**
 * A project from a folder added with "+": opens from the folder; View on GitHub
 * and the sync icon only once the folder is linked to a GitHub repository.
 */
function localCardHtml(p) {
  const remove = `<button type="button" data-local="remove" title="${escapeHtml(`Take ${p.folder} off the gallery (the folder is kept)`)}">Remove from projects</button>`;
  const meta = `<div class="project-meta muted" title="${escapeHtml(p.folder)}">${FOLDER_ICON}<span>${escapeHtml(p.folder)}</span>${p.git ? forgeTag(forge(p.git.forge)) : ""}</div>`;
  if (p.missing) {
    return `<li class="project-card" data-key="${escapeHtml(p.key)}">
      <div class="project-thumb"><span class="thumb-note">Folder not found</span></div>
      <div class="project-info">
        <div class="project-title">${BOARD_ICON}<span class="project-name" title="${escapeHtml(p.error)}">${escapeHtml(p.name)}</span>
          <details class="menu card-menu"><summary class="btn small" aria-label="More actions for ${escapeHtml(p.name)}">⋯</summary><div class="card-menu-list">${remove}</div></details>
        </div>
        ${meta}
      </div>
    </li>`;
  }
  const view = (tab) => localViewUrl(p.folder, p.pro ?? p.pcb, tab);
  const kicad = kicadAction(projectPath(p.folder, p.pro ?? p.pcb));
  // The project's place in the repository, on the branch checked out.
  const sub = p.git ? [relativeTo(p.git.root, p.folder), p.dir].filter(Boolean).join("/") : "";
  const f = p.git ? forge(p.git.forge) : null;
  const names = forgeNames();
  const web = f
    ? `<a href="${escapeHtml(f.web.tree(p.git.nwo, p.git.branch, sub))}">View on ${escapeHtml(f.name)}</a>`
    : `<button type="button" aria-disabled="true" title="Not linked to ${escapeHtml(names)} yet: use Link to remote…">View on ${escapeHtml(names.includes(" or ") ? "the web" : names)}</button>`;
  const link = p.git ? "" : `<button type="button" data-local="link" title="Add a ${escapeHtml(names)} repository as this folder's git remote">Link to remote…</button>`;
  const known = p.git ? knownSync(p.git.key, p.git.root) : { color: "grey", title: `Not linked to ${names}: Link to remote… from the ⋯ menu` };
  const syncTitle = known?.title ?? `Checking ${p.git.root} against ${f.name}…`;
  const sync = `<span class="sync-icon ${known ? `sync-${known.color}` : "sync-pending"}"${p.git ? ` data-sync="${escapeHtml(p.git.key)}" data-folder="${escapeHtml(p.git.root)}"` : ""} role="img" aria-label="${escapeHtml(syncTitle)}" title="${escapeHtml(syncTitle)}">${SYNC_ICON}</span>`;
  return `<li class="project-card" data-key="${escapeHtml(p.key)}">
    <a class="project-thumb" href="${escapeHtml(view())}" tabindex="-1" aria-hidden="true">${thumbHtml(p)}</a>
    <div class="project-info">
      <div class="project-title">${BOARD_ICON}<a href="${escapeHtml(view())}" title="${escapeHtml(p.pro ?? p.pcb)}">${escapeHtml(p.name)}</a>
        ${sync}
        <details class="menu card-menu">
          <summary class="btn small" aria-label="More actions for ${escapeHtml(p.name)}">⋯</summary>
          <div class="card-menu-list">
            ${p.sch ? `<a href="${escapeHtml(view("sch"))}">Schematic</a>` : ""}
            ${p.pcb ? `<a href="${escapeHtml(view("pcb"))}">PCB</a><a href="${escapeHtml(view("3d"))}">3D view</a>` : ""}
            <a href="${escapeHtml(view("bom"))}">Bill of materials</a>
            <button type="button" data-kicad aria-disabled="${!kicad.ok}" title="${escapeHtml(kicad.title)}">Open in KiCad</button>
            ${web}
            <hr>
            ${link}${remove}
          </div>
        </details>
      </div>
      ${meta}
      <div class="project-meta muted">${escapeHtml(when(p.pushed))}</div>
    </div>
  </li>`;
}

/** The sync icon: grey without a local copy, else the last known state (checked after rendering). */
function syncIconHtml(p, local) {
  const known = local ? knownSync(p.repoKey) : { color: "grey", title: "Not on this computer: Download or Link it from the ⋯ menu" };
  const cls = known ? `sync-${known.color}` : "sync-pending";
  const title = known?.title ?? `Checking ${local} against ${forge(p.forge).name}…`;
  return `<span class="sync-icon ${cls}" data-sync="${escapeHtml(p.repoKey)}" role="img" aria-label="${escapeHtml(title)}" title="${escapeHtml(title)}">${SYNC_ICON}</span>`;
}

/** Check the linked copies shown in the grid and colour their icons (one check per repository). */
function updateSyncIcons(grid) {
  for (const el of grid.querySelectorAll(".sync-icon[data-sync]")) {
    const rk = el.dataset.sync; // the repository's key
    const folder = el.dataset.folder ?? localCopy(rk); // a local project's, or a forge card's copy
    if (!folder) continue;
    syncState(rk, folder).then(({ color, title }) => {
      el.className = `sync-icon sync-${color}`;
      el.title = title;
      el.setAttribute("aria-label", title);
    });
  }
}

/**
 * Wire up the project grid.
 * @param {{grid: HTMLElement, status: HTMLElement, filter: HTMLInputElement, add?: HTMLDetailsElement,
 *   onWatched?: (added: boolean) => void}} els `add`: the "+" menu (desktop app only), adding a local
 *   project folder or a GitHub repository; `onWatched` runs after a repository was added to the
 *   watched ones (true) or removed from the gallery (false)
 * @returns {{refresh(): Promise<void>}}
 */
export function initProjects({ grid, status, filter, add = null, onWatched = null }) {
  let index = loadIndex();
  let locals = []; // local project folders' entries (local-projects.js)
  let scan = 0; // a refresh during a scan supersedes it
  let byKey = new Map();
  let renderQueued = false;
  let limit = PAGE;

  // The last item of a long grid is a "show more" row: reaching it renders the next page.
  const more = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      limit += PAGE;
      render();
    }
  }, { rootMargin: "600px" });

  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        observer.unobserve(e.target);
        const p = byKey.get(e.target.dataset.key);
        if (!p) continue;
        thumbnail(p)
          .then((url) => {
            const box = grid.querySelector(`[data-key="${CSS.escape(p.key)}"] .project-thumb`);
            if (box) box.innerHTML = `<img src="${url}" alt="">`;
          })
          .catch((err) => {
            console.warn(`Thumbnail for ${p.key}:`, err);
            const box = grid.querySelector(`[data-key="${CSS.escape(p.key)}"] .project-thumb`);
            if (box) box.innerHTML = `<span class="thumb-note">No preview</span>`;
          });
      }
    },
    { rootMargin: "300px" },
  );

  /** Whether a repository has cards in the gallery (then a clone of it is linked, not added). */
  const inGallery = (key) => Object.entries(index).some(([k, r]) => k.toLowerCase() === key.toLowerCase() && r.projects.length);

  function projects() {
    const out = [];
    for (const [k, r] of Object.entries(index))
      for (const p of r.projects) out.push({ ...p, ...r.repo, forge: r.repo.forge ?? FORGES[0].id, repoKey: k, branch: r.branch, pushed: r.pushed, repoCount: r.projects.length, key: `${k}:${p.pro ?? p.pcb}` });
    // A local folder that is also a repository card's linked copy shows as that card only.
    const copies = new Set(Object.values(settings().localCopies ?? {}).map((f) => f.replace(/[\\/]+$/, "")));
    for (const p of locals) if (!(p.git && inGallery(p.git.key) && copies.has(p.git.root.replace(/[\\/]+$/, "")))) out.push({ ...p, pushed: p.pushed ?? "" });
    const where = (p) => p.nwo ?? p.folder;
    const file = (p) => p.pro ?? p.pcb ?? "";
    return out.sort((a, b) => b.pushed.localeCompare(a.pushed) || where(a).localeCompare(where(b)) || file(a).localeCompare(file(b)));
  }

  function render() {
    renderQueued = false;
    const all = projects();
    byKey = new Map(all.map((p) => [p.key, p]));
    const q = filter.value.trim().toLowerCase();
    const shown = q ? all.filter((p) => `${p.name} ${p.nwo ?? p.folder} ${p.dir ?? ""} ${p.local ? "" : forge(p.forge).name}`.toLowerCase().includes(q)) : all;
    observer.disconnect();
    more.disconnect();
    const page = shown.slice(0, limit);
    grid.innerHTML =
      page.map(cardHtml).join("") +
        (shown.length > page.length ? `<li class="project-more"><button type="button" class="btn">Show more (${shown.length - page.length} left)</button></li>` : "") ||
      `<li class="muted project-empty">${all.length ? "No project matches the filter" : scan ? "Looking for KiCad projects…" : "No KiCad projects found"}</li>`;
    const moreRow = grid.querySelector(".project-more");
    if (moreRow) {
      moreRow.querySelector("button").addEventListener("click", () => {
        limit += PAGE;
        render();
      });
      more.observe(moreRow);
    }
    for (const card of grid.querySelectorAll(".project-card")) {
      const p = byKey.get(card.dataset.key);
      if (thumbKey(p) && !tooBig(p) && !thumbUrls.has(thumbKey(p))) observer.observe(card);
    }
    updateSyncIcons(grid);
  }
  /** Read the local project folders again (their files may have changed). */
  async function loadLocals() {
    locals = await localProjects().catch((e) => {
      toast(`Local projects: ${e.message ?? e}`, true);
      return locals;
    });
    adoptLinkedFolders(locals, inGallery);
    queueRender();
  }
  // Back from KiCad or a terminal: the copies may have been committed or pushed,
  // and local projects saved.
  window.addEventListener("focus", () => {
    forgetSync();
    updateSyncIcons(grid);
    loadLocals();
  });
  const queueRender = () => !renderQueued && (renderQueued = true) && requestAnimationFrame(render);

  filter.addEventListener("input", () => {
    limit = PAGE;
    render();
  });

  // Linking or unlinking KiCad in Settings greys "Open in KiCad" in or out.
  window.addEventListener("kivi:settings", () => render());

  // Card menu: a greyed-out item says why (the menu stays open); open in KiCad.
  grid.addEventListener("click", (e) => {
    const off = e.target.closest('.card-menu-list [aria-disabled="true"]');
    if (off) return toast(off.title, true);
    const b = e.target.closest("button[data-kicad]");
    const p = b && byKey.get(b.closest(".project-card")?.dataset.key);
    if (!p) return;
    b.closest("details").open = false;
    openInKicad(projectPath(p.local ? p.folder : localCopy(p.repoKey), p.pro)).catch((err) => toast(err.message ?? String(err), true));
  });

  // "+": a local project folder, or a forge repository (watched, then scanned like
  // the others). A local card's menu links it to a forge or removes it.
  const afterLocalChange = async () => {
    forgetSync();
    await loadLocals();
    render();
  };
  if (add) {
    mountAddMenu(add, {
      local: async () => {
        try {
          if (await addLocalProject(inGallery)) await afterLocalChange();
        } catch (err) {
          toast(err.message ?? String(err), true);
        }
      },
      remote: async () => {
        const added = await addRemoteProject({ inGallery, hasProjects: repoHasProjects });
        if (!added) return;
        toast(`Added ${parseRepoKey(added).nwo}`);
        if (onWatched) onWatched(true);
        else refresh();
      },
    });
  }
  // Remove from projects: the whole repository goes, at once (its scan is forgotten too).
  grid.addEventListener("click", (e) => {
    const b = e.target.closest('button[data-repo="remove"]');
    const p = b && byKey.get(b.closest(".project-card")?.dataset.key);
    if (!p) return;
    b.closest("details").open = false;
    removeRepo(p.repoKey);
    delete index[p.repoKey];
    saveIndex(index);
    render();
    toast(`Removed ${p.nwo}${p.repoCount > 1 ? ` (${p.repoCount} projects)` : ""}; Reload brings it back`);
    onWatched?.(false);
  });

  grid.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-local]");
    const p = b && byKey.get(b.closest(".project-card")?.dataset.key);
    if (!p) return;
    b.closest("details").open = false;
    try {
      if (b.dataset.local === "remove") removeLocalProject(p.folder);
      else if (!(await linkLocalProject(p, inGallery))) return;
      await afterLocalChange();
    } catch (err) {
      toast(err.message ?? String(err), true);
    }
  });

  // Card menu: download, link or unlink a local copy.
  grid.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-git]");
    if (!b) return;
    const p = byKey.get(b.closest(".project-card")?.dataset.key);
    if (!p) return;
    b.closest("details").open = false;
    try {
      forgetSync(p.repoKey);
      if (b.dataset.git === "unlink") {
        unlinkLocalCopy(p.repoKey);
        toast(`Unlinked ${p.nwo}; the folder is untouched`);
        return render();
      }
      const folder = b.dataset.git === "clone" ? await cloneProject(p.repoKey) : await linkProject(p.repoKey);
      if (folder) location.href = localViewUrl(folder, p.pro ?? p.pcb);
    } catch (err) {
      toast(err.message ?? String(err), true);
    }
  });

  async function refresh() {
    const id = ++scan;
    forgetSync(); // Reload checks the local copies again too
    loadLocals();
    render();
    if (!FORGES.some((f) => tokenFor(f)) && !(settings().watchRepos ?? []).length) {
      index = {};
      status.textContent = "Sign in to list the projects in your repositories, or add a public repository with + → Remote project….";
      scan = 0;
      return render();
    }
    status.textContent = "Listing repositories…";
    let repos;
    try {
      repos = await listRepos();
    } catch (e) {
      if (id === scan) status.textContent = `Couldn't list repositories: ${e.message}`;
      return;
    }
    if (id !== scan) return;
    // Forget repositories that are no longer reachable (not those of a forge that couldn't be listed).
    const keys = new Set(repos.map((r) => r.key));
    const failedForges = new Set(repos.errors.map((e) => e.split(":")[0]));
    for (const k of Object.keys(index)) if (!keys.has(k) && !failedForges.has(parseRepoKey(k)?.forge.name)) delete index[k];
    queueRender();

    const todo = repos.filter((r) => index[r.key]?.pushed !== r.pushedAt || index[r.key]?.branch !== r.defaultBranch);
    let done = 0, failed = 0, stop = null;
    const progress = () => (status.textContent = `Scanning repositories… ${done} of ${todo.length}`);
    if (todo.length) progress();
    const work = async () => {
      for (let r; !stop && id === scan && (r = todo.shift()); ) {
        try {
          index[r.key] = await scanRepo(r);
          queueRender();
        } catch (e) {
          failed++; // keep the previous result, if any; don't cache the failure
          if (e.status === 403 || e.status === 429) stop = e;
        }
        done++;
        if (id === scan && !stop) progress();
      }
    };
    await Promise.all([work(), work(), work(), work()]);
    if (id !== scan) return;
    saveIndex(index);
    scan = 0;
    adoptLinkedFolders(locals, inGallery); // a repository just listed may be a local folder's remote
    const all = projects().filter((p) => !p.local); // the status counts the forges'
    const inRepos = new Set(all.map((p) => p.repoKey)).size;
    status.textContent = stop
      ? `Stopped: ${stop.message}`
      : `${all.length} project${all.length === 1 ? "" : "s"} in ${inRepos} of ${repos.length} repositor${repos.length === 1 ? "y" : "ies"}` +
        (failed ? ` · ${failed} couldn't be read` : "") +
        (repos.errors.length ? ` · couldn't list ${repos.errors.join("; ")}` : "") +
        (Object.values(index).some((r) => r.truncated) ? " · some repositories are too large to list completely" : "");
    render();
  }

  return { refresh };
}
