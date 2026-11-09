// The desktop app's home page, with three views switched by the header icons
// (as on github.com): Projects (a grid of every KiCad project in the user's
// repositories on GitHub and GitLab, see projects.js), Pull requests (open
// pull and merge requests waiting for the
// user's review, their own, and those of remote projects, only in
// repositories with KiCad projects, marked with the KiCad files they change,
// opening in the visual diff or the hardware viewer) and Issues (open
// hardware change requests, the "kivi" issues of ../review.js, opening in the
// viewer on their pin).
// The avatar opens the shared account menu (account.js).
// "+" adds projects to the gallery: a local folder or a forge repository.
// Reload lists every repository again, bringing back those removed from projects.

import { $, escapeHtml, settings, saveSettings, tokenFor } from "../app/ui.js";
import { FORGES, parseRepoKey, repoKey } from "../forge/index.js";
import { initHeader } from "./account.js";
import { ICONS } from "./icons.js";
import { galleryRepos, initProjects, repoHasProjects } from "./projects.js";
import { initCardZoom } from "./card-zoom.js";
import { localCopy } from "./git.js";
import { ISSUE_LABEL, decodeBody, anchorLabel } from "../review.js";
import { kicadFilesChanged } from "./pr-files.js";
import { ensureFreshTokens, invoke, isDesktop, onDrop, routeExternalLinks } from "./tauri.js";

// The lists gather every forge: those signed in, and those with remote
// projects. Repositories are kept by key (repoKey in ../forge/index.js).
const hidden = () => new Set((settings().hiddenRepos ?? []).map((h) => h.toLowerCase())); // removed from projects
// Repositories added with + → Remote project…, unless removed from projects since (keys).
const watched = () => (settings().watchRepos ?? []).filter((r) => !hidden().has(r.toLowerCase()));
const signedIn = () => FORGES.filter((f) => tokenFor(f));

/** Repository keys → Map forge → [nwo]. */
function byForge(keys) {
  const out = new Map();
  for (const k of keys) {
    const r = parseRepoKey(k);
    if (r) out.set(r.forge, [...(out.get(r.forge) ?? []), r.nwo]);
  }
  return out;
}

/** "pull requests", "merge requests", or both, for the forges in a list. */
const prWords = (forges) => [...new Set(forges.map((f) => f.words.prs))].join(" and ").replace(/^(\w+) requests and (\w+) requests$/, "$1 and $2 requests");

/**
 * Each section's lists, one per forge: {title, parts: [{forge, filter}]}.
 * `what` is "prs" or "issues".
 */
function sections(what) {
  const out = [];
  const mine = signedIn();
  const remote = what === "prs" ? byForge(watched()) : byForge(galleryRepos().filter((k) => !hidden().has(k.toLowerCase())));
  const label = { label: ISSUE_LABEL };
  if (mine.length && what === "prs") {
    out.push({ title: "Waiting for your review", parts: mine.map((f) => ({ forge: f, filter: { reviewRequested: true } })) });
    out.push({ title: `Your ${prWords(mine)}`, parts: mine.map((f) => ({ forge: f, filter: { author: "me" } })) });
  }
  if (mine.length && what === "issues") {
    out.push({ title: "Assigned to you", parts: mine.map((f) => ({ forge: f, filter: { ...label, assignee: "me" } })) });
    out.push({ title: "Opened by you", parts: mine.map((f) => ({ forge: f, filter: { ...label, author: "me" } })) });
  }
  if (remote.size) {
    const parts = [...remote].map(([f, repos]) => ({ forge: f, filter: what === "prs" ? { repos } : { ...label, repos } }));
    out.push({ title: what === "prs" ? "Remote projects" : "In your projects", parts });
  }
  return out;
}

/** One section's items from every forge, each with its `forge` and `key`; a forge that fails leaves a note. */
async function gather(s, search) {
  const items = [], errors = [];
  await Promise.all(
    s.parts.map(async ({ forge: f, filter }) => {
      try {
        for (const it of await search(f, filter)) items.push({ ...it, forge: f, key: repoKey(f, it.nwo) });
      } catch (e) {
        errors.push(e.message);
      }
    }),
  );
  return { items: items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), errors };
}

// ---- pull requests -----------------------------------------------------------------

function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  for (const [n, unit] of [[86400 * 365, "y"], [86400 * 30, "mo"], [86400, "d"], [3600, "h"], [60, "min"]]) if (s >= n) return `${Math.floor(s / n)} ${unit} ago`;
  return "just now";
}

/** The button to the item's own page on its forge. */
const forgeButton = (it) => `<a class="btn small" href="${escapeHtml(it.url)}" title="Open on ${escapeHtml(it.forge.host)}">${escapeHtml(it.forge.name)} ↗</a>`;

/** A pull (merge) request row. @param {import("../forge/index.js").SearchItem & {forge: object, key: string}} it */
function prRow(it) {
  const { nwo, forge: f } = it;
  const diff = `diff.html#${new URLSearchParams({ [f.hashKey]: nwo, pr: String(it.number) })}`;
  const hw = `index.html#${new URLSearchParams({ [f.hashKey]: nwo, pr: `${nwo}#${it.number}` })}`;
  return `<li class="pr-row" data-key="${escapeHtml(it.key)}" data-number="${it.number}">
    <img class="avatar" src="${escapeHtml(f.avatar(it.avatar, 48))}" alt="" title="${escapeHtml(it.author)}">
    <div class="pr-body">
      <div class="pr-title"><a href="${escapeHtml(diff)}">${escapeHtml(it.title)}</a>${it.draft ? ' <span class="tag">draft</span>' : ""}</div>
      <div class="pr-meta muted"><span class="mono">${escapeHtml(nwo)}${f.words.prRef(it.number)}</span> · ${escapeHtml(it.author)} · updated ${ago(it.updatedAt)} · <span class="kicad-badge">checking files…</span></div>
    </div>
    <div class="pr-actions">
      <a class="btn small primary" href="${escapeHtml(diff)}">Visual diff</a>
      <a class="btn small" href="${escapeHtml(hw)}">Hardware</a>
      ${forgeButton(it)}
    </div>
  </li>`;
}

/** Mark each row with how many KiCad files the PR changes (a few at a time; see pr-files.js). */
async function checkKicadFiles(rows) {
  const queue = [...rows];
  const worker = async () => {
    for (let row; (row = queue.shift()); ) {
      const badge = row.querySelector(".kicad-badge");
      try {
        const { forge: f, owner, repo } = parseRepoKey(row.dataset.key);
        const token = tokenFor(f);
        const files = await f.pullFiles(owner, repo, Number(row.dataset.number), token, { max: 1 });
        const read = (path, ref) => f.source({ owner, repo, ref, sha: ref, token }).readText(path);
        const n = (await kicadFilesChanged(files, read)).length;
        badge.textContent = n ? `${n} KiCad file${n > 1 ? "s" : ""} changed` : "no KiCad changes";
        badge.classList.toggle("has-kicad", n > 0);
        row.classList.toggle("no-kicad", n === 0);
      } catch {
        badge.textContent = "files unknown";
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

async function renderLists() {
  const lists = $("#lists");
  const secs = sections("prs");
  if (!secs.length) {
    lists.innerHTML = `<p class="inbox-note">Nothing to show yet: sign in, or add a remote project with + in Projects.</p>`;
    return;
  }
  lists.innerHTML = secs.map((s, i) => `<h2>${escapeHtml(s.title)}</h2><ul class="pr-list" id="sec-${i}"><li class="muted">Loading…</li></ul>`).join("");
  const seen = new Set();
  const hasProjects = new Map(); // repository key → Promise<boolean>, once per refresh
  const removed = hidden();
  const keep = (it) => {
    if (removed.has(it.key.toLowerCase())) return false;
    if (!hasProjects.has(it.key)) hasProjects.set(it.key, repoHasProjects(it.key).catch(() => true)); // unknown: show it
    return hasProjects.get(it.key);
  };
  for (const [i, s] of secs.entries()) {
    const ul = $(`#sec-${i}`);
    const { items: all, errors } = await gather(s, (f, filter) => f.searchPullRequests(filter, tokenFor(f)));
    const found = all.filter((it) => !seen.has(it.url));
    for (const it of found) seen.add(it.url);
    // Only pull requests in repositories with KiCad projects.
    const flags = await Promise.all(found.map(keep));
    const items = found.filter((_, j) => flags[j]);
    const notes = errors.map((e) => `<li class="muted">${escapeHtml(e)}</li>`).join("");
    ul.innerHTML = items.length || notes ? items.map(prRow).join("") + notes : `<li class="muted">None</li>`;
    checkKicadFiles([...ul.querySelectorAll(".pr-row")]);
  }
}

// ---- issues ------------------------------------------------------------------------

/** Where an issue opens: on its pin in the local copy if there is one, else on the forge's default branch. */
function issueViewUrl(it, anchor) {
  const at = anchor?.file ? { file: anchor.file, tab: anchor.file.endsWith(".kicad_pcb") ? "pcb" : "sch", thread: String(it.number) } : {};
  const copy = localCopy(it.key);
  return `index.html#${new URLSearchParams(copy ? { folder: copy, ...at } : { [it.forge.hashKey]: it.nwo, ...at })}`;
}

/** @param {import("../forge/index.js").SearchItem & {forge: object, key: string}} it */
function issueRow(it) {
  const { nwo, forge: f } = it;
  const { anchor } = decodeBody(it.body);
  const pin = anchor?.file ? `📍 <span class="mono">${escapeHtml(anchorLabel(anchor))}</span> in <span class="mono">${escapeHtml(anchor.file.split("/").pop())}</span>` : "not pinned";
  const hw = issueViewUrl(it, anchor);
  return `<li class="pr-row issue-row">
    <img class="avatar" src="${escapeHtml(f.avatar(it.avatar, 48))}" alt="" title="${escapeHtml(it.author)}">
    <div class="pr-body">
      <div class="pr-title"><a href="${escapeHtml(hw)}">${escapeHtml(it.title)}</a></div>
      <div class="pr-meta muted"><span class="mono">${escapeHtml(nwo)}#${it.number}</span> · ${escapeHtml(it.author)} · updated ${ago(it.updatedAt)} · ${pin}${it.comments ? ` · ${it.comments} comment${it.comments > 1 ? "s" : ""}` : ""}</div>
    </div>
    <div class="pr-actions">
      <a class="btn small primary" href="${escapeHtml(hw)}"${localCopy(it.key) ? ` title="Opens the local copy"` : ""}>Hardware</a>
      ${forgeButton(it)}
    </div>
  </li>`;
}

async function renderIssues() {
  const lists = $("#issue-lists");
  const removed = hidden();
  const secs = sections("issues");
  if (!secs.length) {
    lists.innerHTML = `<p class="inbox-note">Nothing to show yet: sign in, or add a remote project with + in Projects.</p>`;
    return;
  }
  lists.innerHTML = secs.map((s, i) => `<h2>${escapeHtml(s.title)}</h2><ul class="pr-list" id="isec-${i}"><li class="muted">Loading…</li></ul>`).join("");
  const seen = new Set();
  for (const [i, s] of secs.entries()) {
    const ul = $(`#isec-${i}`);
    const { items: found, errors } = await gather(s, (f, filter) => f.searchIssues(filter, tokenFor(f)));
    const items = found.filter((it) => !seen.has(it.url) && !removed.has(it.key.toLowerCase())).slice(0, 50);
    for (const it of items) seen.add(it.url);
    const notes = errors.map((e) => `<li class="muted">${escapeHtml(e)}</li>`).join("");
    ul.innerHTML = items.length || notes ? items.map(issueRow).join("") + notes : `<li class="muted">None</li>`;
  }
}

// ---- projects / pull requests / issues switch -------------------------------------

const TAB_KEY = "kivi.homeTab";
const TITLES = { projects: "Projects", prs: "Pull requests", issues: "Issues" };
// Signing in or out reloads the lists here rather than the whole page.
const header = isDesktop ? initHeader({ homeLinks: false, onAccountChange: () => refresh() }) : null;
const projects = initProjects({
  grid: $("#projects"),
  status: $("#projects-status"),
  filter: $("#project-filter"),
  add: isDesktop ? $("#add-project") : null,
  onWatched: (added) => {
    if (added) refreshTabs();
    else (loaded.delete("prs"), loaded.delete("issues")); // the lists drop it on their next showing
  },
});
const loaded = new Set(); // tabs fetched since the last refresh
initCardZoom($("#home-projects"), $("#projects"));

function showHomeTab(name) {
  if (!TITLES[name]) name = "projects";
  for (const b of document.querySelectorAll("[data-home]")) b.setAttribute("aria-pressed", String(b.dataset.home === name));
  $("#home-title").textContent = TITLES[name];
  document.title = `KiVi — ${TITLES[name]}`;
  history.replaceState(null, "", `#${name}`);
  $("#home-projects").hidden = name !== "projects";
  $("#home-prs").hidden = name !== "prs";
  $("#home-issues").hidden = name !== "issues";
  try {
    localStorage.setItem(TAB_KEY, name);
  } catch {
    /* storage unavailable */
  }
  // Each tab costs API requests, so it loads when first shown.
  if (!loaded.has(name)) {
    loaded.add(name);
    if (name === "projects") projects.refresh();
    else if (name === "issues") renderIssues();
    else renderLists();
  }
}
const currentTab = () => document.querySelector('[data-home][aria-pressed="true"]')?.dataset.home ?? "projects";

async function refresh() {
  await ensureFreshTokens(); // after a night off the token has expired; get a new one first
  header?.renderAccount();
  $("#signed-out").hidden = signedIn().length > 0;
  loaded.clear();
  showHomeTab(currentTab());
}

/** Reload: every GitHub repository again, including those removed from projects. */
function reload() {
  const s = settings();
  if (s.hiddenRepos?.length) saveSettings({ ...s, hiddenRepos: [] });
  refresh();
}

/** Remote projects changed: reload the visible tab, the other one on next show. */
function refreshTabs() {
  loaded.clear();
  showHomeTab(currentTab());
}

// ---- wiring ---------------------------------------------------------------------------

if (isDesktop) {
  routeExternalLinks();
  // A folder or KiCad file dropped on the home page opens in the viewer.
  onDrop({ drop: (folder, project) => (location.href = `index.html#${new URLSearchParams({ folder, ...(project && { project }) })}`) });
}
for (const b of document.querySelectorAll("[data-home]")) {
  b.innerHTML = { projects: ICONS.repo, prs: ICONS.pullRequest, issues: ICONS.issue }[b.dataset.home];
  b.addEventListener("click", () => showHomeTab(b.dataset.home));
}
// Start on the view named in the link (the viewer's header icons link to inbox.html#prs), else the last one used.
{
  let start = location.hash.slice(1);
  if (!TITLES[start]) {
    try {
      start = localStorage.getItem(TAB_KEY);
    } catch {
      /* storage unavailable */
    }
  }
  for (const b of document.querySelectorAll("[data-home]")) b.setAttribute("aria-pressed", String(b.dataset.home === (TITLES[start] ? start : "projects")));
}
window.addEventListener("hashchange", () => TITLES[location.hash.slice(1)] && showHomeTab(location.hash.slice(1)));
$("#reload").addEventListener("click", reload);
refresh();

// `kivi-desktop path/to/project`: go straight to the viewer (once, not on every return to the inbox).
if (isDesktop && !sessionStorage.getItem("kivi.startupHandled")) {
  sessionStorage.setItem("kivi.startupHandled", "1");
  invoke("startup_folder").then((p) => {
    if (p) location.href = `index.html#${new URLSearchParams({ folder: p })}`;
  });
}
