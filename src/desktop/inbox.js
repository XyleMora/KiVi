// The desktop app's home page, with two views switched by the header icons (as
// on github.com): Projects (a grid of every KiCad project in the user's
// repositories, see projects.js) and Pull requests (open PRs waiting for the
// user's review, their own, and those of watched repositories, only in
// repositories with KiCad projects, marked with the KiCad files they change,
// opening in the visual diff or the hardware viewer).
// The avatar opens the shared account menu (account.js).
// Local folders open from here too.

import { $, escapeHtml, settings, saveSettings, toast } from "../app/ui.js";
import { DIFFABLE } from "../sources.js";
import { initHeader } from "./account.js";
import { ICONS } from "./icons.js";
import { initProjects, repoHasProjects } from "./projects.js";
import { ensureFreshToken, invoke, isDesktop, onDrop, pickFolder, recentFolders, routeExternalLinks } from "./tauri.js";

const token = () => settings().token ?? null;
const watched = () => settings().watchRepos ?? [];

async function api(path) {
  const headers = { Accept: "application/vnd.github+json" };
  if (token()) headers.Authorization = `Bearer ${token()}`;
  const r = await fetch(`https://api.github.com${path}`, { headers });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(`GitHub ${r.status}: ${body.message ?? r.statusText}`);
  }
  return r.json();
}

// ---- pull requests -----------------------------------------------------------------

function sections() {
  const out = [];
  if (token()) {
    out.push({ title: "Waiting for your review", q: "is:pr is:open archived:false review-requested:@me" });
    out.push({ title: "Your pull requests", q: "is:pr is:open archived:false author:@me" });
  }
  if (watched().length) out.push({ title: "Watched repositories", q: `is:pr is:open ${watched().map((r) => `repo:${r}`).join(" ")}` });
  return out;
}

function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  for (const [n, unit] of [[86400 * 365, "y"], [86400 * 30, "mo"], [86400, "d"], [3600, "h"], [60, "min"]]) if (s >= n) return `${Math.floor(s / n)} ${unit} ago`;
  return "just now";
}

function prRow(it) {
  const [owner, repo] = it.repository_url.split("/").slice(-2);
  const nwo = `${owner}/${repo}`;
  const diff = `diff.html#${new URLSearchParams({ gh: nwo, pr: String(it.number) })}`;
  const hw = `index.html#${new URLSearchParams({ gh: nwo, pr: `${nwo}#${it.number}` })}`;
  return `<li class="pr-row" data-repo="${escapeHtml(nwo)}" data-number="${it.number}">
    <img class="avatar" src="${escapeHtml(it.user.avatar_url)}&s=48" alt="" title="${escapeHtml(it.user.login)}">
    <div class="pr-body">
      <div class="pr-title"><a href="${escapeHtml(diff)}">${escapeHtml(it.title)}</a>${it.draft ? ' <span class="tag">draft</span>' : ""}</div>
      <div class="pr-meta muted"><span class="mono">${escapeHtml(nwo)}#${it.number}</span> · ${escapeHtml(it.user.login)} · updated ${ago(it.updated_at)} · <span class="kicad-badge">checking files…</span></div>
    </div>
    <div class="pr-actions">
      <a class="btn small primary" href="${escapeHtml(diff)}">Visual diff</a>
      <a class="btn small" href="${escapeHtml(hw)}">Hardware</a>
      <a class="btn small" href="${escapeHtml(it.html_url)}" title="Open on github.com">GitHub ↗</a>
    </div>
  </li>`;
}

/** Mark each row with how many schematic/board files the PR changes (a few at a time). */
async function checkKicadFiles(rows) {
  const queue = [...rows];
  const worker = async () => {
    for (let row; (row = queue.shift()); ) {
      const badge = row.querySelector(".kicad-badge");
      try {
        const files = await api(`/repos/${row.dataset.repo}/pulls/${row.dataset.number}/files?per_page=100`);
        const n = files.filter((f) => DIFFABLE.test(f.filename)).length;
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
    lists.innerHTML = `<p class="inbox-note">Nothing to show yet: sign in, or watch a repository on the right.</p>`;
    return;
  }
  lists.innerHTML = secs.map((s, i) => `<h2>${escapeHtml(s.title)}</h2><ul class="pr-list" id="sec-${i}"><li class="muted">Loading…</li></ul>`).join("");
  const seen = new Set();
  const hasProjects = new Map(); // "owner/repo" → Promise<boolean>, once per refresh
  const keep = (it) => {
    const nwo = it.repository_url.split("/").slice(-2).join("/");
    if (!hasProjects.has(nwo)) hasProjects.set(nwo, repoHasProjects(nwo).catch(() => true)); // unknown: show it
    return hasProjects.get(nwo);
  };
  for (const [i, s] of secs.entries()) {
    const ul = $(`#sec-${i}`);
    try {
      const res = await api(`/search/issues?${new URLSearchParams({ q: s.q, sort: "updated", per_page: "30" })}`);
      const found = res.items.filter((it) => !seen.has(it.html_url));
      for (const it of found) seen.add(it.html_url);
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

// ---- side panel ---------------------------------------------------------------------

function renderWatched() {
  $("#watched-count").textContent = watched().length ? String(watched().length) : "";
  $("#watched").innerHTML =
    watched().map((r) => `<li><a href="index.html#${new URLSearchParams({ gh: r })}" class="mono">${escapeHtml(r)}</a><button class="btn small" data-unwatch="${escapeHtml(r)}" aria-label="Stop watching ${escapeHtml(r)}">×</button></li>`).join("") ||
    `<li class="muted">None</li>`;
  for (const b of document.querySelectorAll("[data-unwatch]")) {
    b.addEventListener("click", () => {
      saveSettings({ ...settings(), watchRepos: watched().filter((r) => r !== b.dataset.unwatch) });
      renderWatched();
      refreshTabs();
    });
  }
}

function renderRecent() {
  const recent = isDesktop ? recentFolders() : [];
  $("#recent").innerHTML =
    recent.map((p) => `<li><a href="index.html#${new URLSearchParams({ folder: p })}" class="mono" title="${escapeHtml(p)}">${escapeHtml(p.split(/[\\/]/).pop())}</a><span class="muted path">${escapeHtml(p)}</span></li>`).join("") ||
    `<li class="muted">None yet</li>`;
}

// ---- projects / pull requests switch -----------------------------------------------

const TAB_KEY = "kivi.homeTab";
const TITLES = { projects: "Projects", prs: "Pull requests" };
// Signing in or out reloads the lists here rather than the whole page.
const header = isDesktop ? initHeader({ homeLinks: false, onAccountChange: () => refresh() }) : null;
const projects = initProjects({ grid: $("#projects"), status: $("#projects-status"), filter: $("#project-filter") });
const loaded = new Set(); // tabs fetched since the last refresh

function showHomeTab(name) {
  if (!TITLES[name]) name = "projects";
  for (const b of document.querySelectorAll("[data-home]")) b.setAttribute("aria-pressed", String(b.dataset.home === name));
  $("#home-title").textContent = TITLES[name];
  document.title = `KiVi — ${TITLES[name]}`;
  history.replaceState(null, "", `#${name}`);
  $("#home-projects").hidden = name !== "projects";
  $("#home-prs").hidden = name !== "prs";
  try {
    localStorage.setItem(TAB_KEY, name);
  } catch {
    /* storage unavailable */
  }
  // Each tab costs API requests, so it loads when first shown.
  if (!loaded.has(name)) {
    loaded.add(name);
    if (name === "projects") projects.refresh();
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
  renderWatched();
  renderRecent();
}

/** Watched repositories changed: reload the visible tab, the other one on next show. */
function refreshTabs() {
  loaded.clear();
  showHomeTab(currentTab());
}

// ---- drawer (watched repositories, recent folders) -------------------------------------

function setDrawer(open) {
  const side = $("#side");
  side.classList.toggle("open", open);
  side.inert = !open; // off-screen: out of the tab order and the accessibility tree
  $("#side-toggle").setAttribute("aria-expanded", String(open));
  if (open) setTimeout(() => $("#watch-input").focus(), 0);
}
$("#side-toggle").addEventListener("click", () => setDrawer(!$("#side").classList.contains("open")));
$("#side-close").addEventListener("click", () => {
  setDrawer(false);
  $("#side-toggle").focus();
});
// Escape or a click outside closes it (an open menu or dialog takes the Escape first).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !e.defaultPrevented && $("#side").classList.contains("open") && !document.querySelector("dialog[open]")) {
    setDrawer(false);
    $("#side-toggle").focus();
  }
});
document.addEventListener("click", (e) => {
  // isConnected: the un-watch button re-renders its list, so its click target is already detached.
  if ($("#side").classList.contains("open") && e.target.isConnected && !e.target.closest("#side, #side-toggle")) setDrawer(false);
});

// ---- wiring ---------------------------------------------------------------------------

if (isDesktop) {
  routeExternalLinks();
  // A folder or KiCad file dropped on the home page opens in the viewer.
  onDrop({ drop: (folder, project) => (location.href = `index.html#${new URLSearchParams({ folder, ...(project && { project }) })}`) });
}
// "Open": the repository in the box, or a local folder when the box is empty.
$("#gh-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const spec = $("#gh-input").value.trim();
  if (spec) location.href = `index.html#${new URLSearchParams({ gh: spec })}`;
  else if (isDesktop) {
    const path = await pickFolder();
    if (path) location.href = `index.html#${new URLSearchParams({ folder: path })}`;
  }
});
$("#watch-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec($("#watch-input").value.trim());
  if (!m) return toast("Enter a repository as owner/repo", true);
  if (!watched().includes(m[1])) saveSettings({ ...settings(), watchRepos: [...watched(), m[1]] });
  $("#watch-input").value = "";
  renderWatched();
  refreshTabs();
});
$("#side-icon").outerHTML = ICONS.eye;
for (const b of document.querySelectorAll("[data-home]")) {
  b.innerHTML = b.dataset.home === "projects" ? ICONS.repo : ICONS.pullRequest;
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
$("#refresh").addEventListener("click", refresh);
refresh();

// `kivi-desktop path/to/project`: go straight to the viewer (once, not on every return to the inbox).
if (isDesktop && !sessionStorage.getItem("kivi.startupHandled")) {
  sessionStorage.setItem("kivi.startupHandled", "1");
  invoke("startup_folder").then((p) => {
    if (p) location.href = `index.html#${new URLSearchParams({ folder: p })}`;
  });
}
