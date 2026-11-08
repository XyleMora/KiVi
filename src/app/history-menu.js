// The project bar's history button, next to the branch button: the commits on
// the branch being viewed, newest first. Picking one shows the project as it was
// at that commit; the first item goes back to the latest (a GitHub project's
// branch tip, main.js; a local copy's working files, src/desktop/git.js).

import { $, ago, escapeHtml, toast } from "./ui.js";

// One listener for whichever menu is current (the menu is re-made on every refresh).
document.addEventListener("click", (e) => {
  const el = $("#history-menu");
  if (el?.open && !el.contains(e.target)) el.open = false;
});

const HISTORY_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="m.427 1.927 1.215 1.215a8.002 8.002 0 1 1-1.6 5.685.75.75 0 1 1 1.493-.154 6.5 6.5 0 1 0 1.18-4.458l1.358 1.358A.25.25 0 0 1 3.896 6H.25A.25.25 0 0 1 0 5.75V2.104a.25.25 0 0 1 .427-.177ZM7.75 4a.75.75 0 0 1 .75.75v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5A.75.75 0 0 1 7.75 4Z"/></svg>`;

const PAGE = 50; // commits per "Show more"

/**
 * Put the history menu in the project bar (replacing any earlier one), after the branch menu.
 * @param {object} o
 * @param {string} o.kind "forge" | "local", so each side removes only its own menu
 * @param {string|null} o.viewing the commit shown (full SHA), or null for the latest
 * @param {string} o.latest the first item, e.g. "Latest on main" or "Working files"
 * @param {string} [o.latestNote] a note after it (local: the changed files)
 * @param {string|null} [o.branch] for the list's heading
 * @param {(offset: number, count: number) => Promise<{sha: string, summary: string, author: string, time: number}[]>} o.listCommits
 *   `count` commits from `offset`, newest first; `time` in seconds
 * @param {(sha: string|null) => Promise<void>} o.show open a commit, or the latest with null
 * @returns {HTMLDetailsElement}
 */
export function mountHistoryMenu(o) {
  $("#history-menu")?.remove();
  const el = document.createElement("details");
  el.id = "history-menu";
  el.className = `menu branch-menu history-menu${o.viewing ? " history-old" : ""}`;
  el.dataset.kind = o.kind;
  const title = o.viewing ? `Showing commit ${o.viewing.slice(0, 7)}, not the latest: pick another in the history` : "History: show the project at an earlier commit";
  el.innerHTML = `<summary class="btn" title="${escapeHtml(title)}">${HISTORY_ICON}<span class="branch-name">${o.viewing ? escapeHtml(o.viewing.slice(0, 7)) : "History"}</span></summary>
    <div class="branch-menu-list">
      <button type="button" data-sha=""${o.viewing ? "" : ' aria-selected="true" disabled'}><span class="branch-check">${o.viewing ? "" : "✓"}</span>${escapeHtml(o.latest)}${o.latestNote ? `<span class="muted branch-tag">${escapeHtml(o.latestNote)}</span>` : ""}</button>
      <hr>
      <div class="branch-head">Commits${o.branch ? ` on ${escapeHtml(o.branch)}` : ""}</div>
      <input class="input branch-filter" type="search" placeholder="Find a commit…" spellcheck="false" aria-label="Find a commit">
      <div class="branch-list" role="listbox"><span class="muted branch-note">Loading commits…</span></div>
    </div>`;
  const actions = $("#projbar .proj-actions");
  const next = actions?.querySelector("#visual-diff, #open-kicad");
  if (next) next.before(el);
  else actions?.append(el);

  let commits = null;
  let more = false;
  const list = el.querySelector(".branch-list");
  const filter = el.querySelector(".branch-filter");
  const show = () => {
    const q = filter.value.trim().toLowerCase();
    const shown = commits.filter((c) => `${c.sha} ${c.summary} ${c.author}`.toLowerCase().includes(q));
    const row = (c) => {
      const on = c.sha === o.viewing;
      const tip = `${c.summary}\n${c.author}, ${new Date(c.time * 1000).toLocaleString()}\n${c.sha}`;
      return `<button type="button" role="option" data-sha="${escapeHtml(c.sha)}" title="${escapeHtml(tip)}"${on ? ' aria-selected="true" disabled' : ""}><span class="branch-check">${on ? "✓" : ""}</span><span class="mono">${c.sha.slice(0, 7)}</span><span class="base-summary">${escapeHtml(c.summary)}</span><span class="muted branch-tag">${ago(c.time)}</span></button>`;
    };
    list.innerHTML =
      (shown.map(row).join("") || `<span class="muted branch-note">${commits.length ? "No commit matches" : "No commits yet"}</span>`) +
      (more ? `<button type="button" class="history-more" data-more>Show more</button>` : "");
  };
  const load = async () => {
    const batch = await o.listCommits(commits?.length ?? 0, PAGE);
    commits = [...(commits ?? []), ...batch];
    more = batch.length === PAGE;
  };
  el.addEventListener("toggle", async () => {
    if (!el.open) return;
    filter.value = "";
    if (!commits) {
      try {
        await load();
      } catch (e) {
        list.innerHTML = `<span class="muted branch-note">Couldn't list commits: ${escapeHtml(e.message ?? String(e))}</span>`;
        return;
      }
    }
    show();
    filter.focus();
  });
  filter.addEventListener("input", show);
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-sha], button[data-more]");
    if (!b || b.disabled) return;
    try {
      if (b.dataset.more !== undefined) {
        b.disabled = true;
        await load();
        return show();
      }
      el.open = false;
      await o.show(b.dataset.sha || null);
    } catch (err) {
      toast(err.message ?? String(err), true);
    }
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && el.open) {
      e.preventDefault();
      el.open = false;
    }
  });
  return el;
}
