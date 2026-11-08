// The desktop app's home page, with three views switched by the header icons
// (as on github.com): Projects (a grid of every KiCad project in the user's
// repositories, see projects.js), Pull requests (open PRs waiting for the
// user's review, their own, and those of remote projects, only in
// repositories with KiCad projects, marked with the KiCad files they change,
// opening in the visual diff or the hardware viewer) and Issues (open
// hardware change requests, the "kivi" issues of ../review.js, opening in the
// viewer on their pin).
// The avatar opens the shared account menu (account.js).
// "+" adds projects to the gallery: a local folder or a GitHub repository.
// Reload lists every repository again, bringing back those removed from projects.

import { $, escapeHtml, settings, saveSettings } from "../app/ui.js";
import { forge } from "../forge/index.js";
import { initHeader } from "./account.js";
import { ICONS } from "./icons.js";
import { galleryRepos, initProjects, repoHasProjects } from "./projects.js";
import { localCopy } from "./git.js";
import { ISSUE_LABEL, decodeBody, anchorLabel } from "../review.js";
import { kicadFilesChanged } from "./pr-files.js";
import { ensureFreshToken, invoke, isDesktop, onDrop, routeExternalLinks } from "./tauri.js";

const token = () => settings().token ?? null;
// The forge the home page lists; repositories ("owner/repo") are on it.
const host = forge();
const hidden = () => new Set((settings().hiddenRepos ?? []).map((h) => h.toLowerCase())); // removed from projects
// Repositories added with + → Remote project…, unless removed from projects since.
const watched = () => (settings().watchRepos ?? []).filter((r) => !hidden().has(r.toLowerCase()));

// ---- pull requests -----------------------------------------------------------------

function sections() {
  const out = [];
  if (token()) {
    out.push({ title: "Waiting for your review", filter: { reviewRequested: true } });
    out.push({ title: "Your pull requests", filter: { author: "me" } });
  }
  if (watched().length) out.push({ title: "Remote projects", filter: { repos: watched() } });
  return out;
}

function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  for (const [n, unit] of [[86400 * 365, "y"], [86400 * 30, "mo"], [86400, "d"], [3600, "h"], [60, "min"]]) if (s >= n) return `${Math.floor(s / n)} ${unit} ago`;
  return "just now";
}

/** @param {import("../forge/index.js").SearchItem} it */
function prRow(it) {
  const nwo = it.nwo;
  const diff = `diff.html#${new URLSearchParams({ [host.hashKey]: nwo, pr: String(it.number) })}`;
  const hw = `index.html#${new URLSearchParams({ [host.hashKey]: nwo, pr: `${nwo}#${it.number}` })}`;
  return `<li class="pr-row" data-repo="${escapeHtml(nwo)}" data-number="${it.number}">
    <img class="avatar" src="${escapeHtml(host.avatar(it.avatar, 48))}" alt="" title="${escapeHtml(it.author)}">
    <div class="pr-body">
      <div class="pr-title"><a href="${escapeHtml(diff)}">${escapeHtml(it.title)}</a>${it.draft ? ' <span class="tag">draft</span>' : ""}</div>
      <div class="pr-meta muted"><span class="mono">${escapeHtml(nwo)}#${it.number}</span> · ${escapeHtml(it.author)} · updated ${ago(it.updatedAt)} · <span class="kicad-badge">checking files…</span></div>
    </div>
    <div class="pr-actions">
      <a class="btn small primary" href="${escapeHtml(diff)}">Visual diff</a>
      <a class="btn small" href="${escapeHtml(hw)}">Hardware</a>
      <a class="btn small" href="${escapeHtml(it.url)}" title="Open on ${escapeHtml(host.host)}">${escapeHtml(host.name)} ↗</a>
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
        const [owner, repo] = row.dataset.repo.split("/");
        const files = await host.pullFiles(owner, repo, Number(row.dataset.number), token(), { max: 1 });
        const read = (path, ref) => host.source({ owner, repo, ref, sha: ref, token: token() }).readText(path);
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
  const secs = sections();
  if (!secs.length) {
    lists.innerHTML = `<p class="inbox-note">Nothing to show yet: sign in, or add a remote project with + in Projects.</p>`;
    return;
  }
  lists.innerHTML = secs.map((s, i) => `<h2>${escapeHtml(s.title)}</h2><ul class="pr-list" id="sec-${i}"><li class="muted">Loading…</li></ul>`).join("");
  const seen = new Set();
  const hasProjects = new Map(); // "owner/repo" → Promise<boolean>, once per refresh
  const removed = hidden();
  const keep = (it) => {
    const nwo = it.nwo;
    if (removed.has(nwo.toLowerCase())) return false;
    if (!hasProjects.has(nwo)) hasProjects.set(nwo, repoHasProjects(nwo).catch(() => true)); // unknown: show it
    return hasProjects.get(nwo);
  };
  for (const [i, s] of secs.entries()) {
    const ul = $(`#sec-${i}`);
    try {
      const found = (await host.searchPullRequests(s.filter, token())).filter((it) => !seen.has(it.url));
      for (const it of found) seen.add(it.url);
      // Only pull requests in repositories with KiCad projects.
      const flags = await Promise.all(found.map(keep));
      const items = found.filter((_, j) => flags[j]);
      ul.innerHTML = items.length ? items.map(prRow).join("") : `<li class="muted">None</li>`;
      checkKicadFiles([...ul.querySelectorAll(".pr-row")]);
    } catch (e) {
      ul.innerHTML = `<li class="muted">${escapeHtml(e.message)}</li>`;
    }
  }
}

// ---- issues ------------------------------------------------------------------------

/** Where an issue opens: on its pin in the local copy if there is one, else on the forge's default branch. */
function issueViewUrl(nwo, number, anchor) {
  const at = anchor?.file ? { file: anchor.file, tab: anchor.file.endsWith(".kicad_pcb") ? "pcb" : "sch", thread: String(number) } : {};
  const copy = localCopy(nwo);
  return `index.html#${new URLSearchParams(copy ? { folder: copy, ...at } : { [host.hashKey]: nwo, ...at })}`;
}

/** @param {import("../forge/index.js").SearchItem} it */
function issueRow(it) {
  const nwo = it.nwo;
  const { anchor } = decodeBody(it.body);
  const pin = anchor?.file ? `📍 <span class="mono">${escapeHtml(anchorLabel(anchor))}</span> in <span class="mono">${escapeHtml(anchor.file.split("/").pop())}</span>` : "not pinned";
  const hw = issueViewUrl(nwo, it.number, anchor);
  return `<li class="pr-row issue-row">
    <img class="avatar" src="${escapeHtml(host.avatar(it.avatar, 48))}" alt="" title="${escapeHtml(it.author)}">
    <div class="pr-body">
      <div class="pr-title"><a href="${escapeHtml(hw)}">${escapeHtml(it.title)}</a></div>
      <div class="pr-meta muted"><span class="mono">${escapeHtml(nwo)}#${it.number}</span> · ${escapeHtml(it.author)} · updated ${ago(it.updatedAt)} · ${pin}${it.comments ? ` · ${it.comments} comment${it.comments > 1 ? "s" : ""}` : ""}</div>
    </div>
    <div class="pr-actions">
      <a class="btn small primary" href="${escapeHtml(hw)}"${localCopy(nwo) ? ` title="Opens the local copy"` : ""}>Hardware</a>
      <a class="btn small" href="${escapeHtml(it.url)}" title="Open on ${escapeHtml(host.host)}">${escapeHtml(host.name)} ↗</a>
    </div>
  </li>`;
}

async function renderIssues() {
  const lists = $("#issue-lists");
  const removed = hidden();
  const repos = galleryRepos();
  const secs = [];
  if (token()) {
    secs.push({ title: "Assigned to you", filter: { label: ISSUE_LABEL, assignee: "me" } });
    secs.push({ title: "Opened by you", filter: { label: ISSUE_LABEL, author: "me" } });
  }
  if (repos.length) secs.push({ title: "In your projects", filter: { label: ISSUE_LABEL, repos } });
  if (!secs.length) {
    lists.innerHTML = `<p class="inbox-note">Nothing to show yet: sign in, or add a remote project with + in Projects.</p>`;
    return;
  }
  lists.innerHTML = secs.map((s, i) => `<h2>${escapeHtml(s.title)}</h2><ul class="pr-list" id="isec-${i}"><li class="muted">Loading…</li></ul>`).join("");
  const seen = new Set();
  for (const [i, s] of secs.entries()) {
    const ul = $(`#isec-${i}`);
    try {
      const found = await host.searchIssues(s.filter, token());
      const items = found
        .filter((it) => !seen.has(it.url) && !removed.has(it.nwo.toLowerCase()))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 50);
      for (const it of items) seen.add(it.url);
      ul.innerHTML = items.length ? items.map(issueRow).join("") : `<li class="muted">None</li>`;
    } catch (e) {
      ul.innerHTML = `<li class="muted">${escapeHtml(e.message)}</li>`;
    }
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
  await ensureFreshToken(); // after a night off the token has expired; get a new one first
  header?.renderAccount();
  $("#signed-out").hidden = !!token();
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
