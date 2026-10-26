// The visual diff's pickers for its two sides, in the Before and After pane
// labels (diff.js): a branch or a commit for each side, and for a local copy's
// after side its working files. The menu's branch list chooses whose commits
// are listed; its first item is the branch itself (which follows the branch),
// so the branch or any commit on any branch can be picked.

import { ago, escapeHtml, toast } from "./ui.js";

const PAGE = 50; // commits per "Show more"

document.addEventListener("click", (e) => {
  for (const el of document.querySelectorAll(".ref-picker[open]")) if (!el.contains(e.target)) el.open = false;
});

/**
 * A picker menu (a `<details>`, not yet in the page).
 * @param {object} o
 * @param {string} o.current what the button shows, e.g. "main", "a1b2c3d", "working files"
 * @param {string|null} o.value the chosen branch or SHA ("" = the working files), ticked in the menu
 * @param {boolean} [o.working] offer the working files (a local copy)
 * @param {string} o.hint one line on how this side is read
 * @param {string|null} o.commitsOf the branch whose commits are listed at first
 * @param {() => Promise<{name: string, note?: string}[]>} o.branches
 * @param {(branch: string, offset: number, count: number) => Promise<{sha: string, summary: string, author: string, time: number}[]>} o.commits
 * @param {(value: string) => Promise<void>} o.pick a branch, a SHA, or "" for the working files
 * @returns {HTMLDetailsElement}
 */
export function refPicker(o) {
  const el = document.createElement("details");
  el.className = "menu branch-menu ref-picker";
  el.innerHTML = `<summary class="btn small" title="${escapeHtml(o.hint)}"><span class="branch-name">${escapeHtml(o.current)}</span> ▾</summary>
    <div class="branch-menu-list">
      <p class="muted ref-hint">${escapeHtml(o.hint)}</p>
      <input class="input branch-filter" type="search" placeholder="Find a commit…" spellcheck="false" aria-label="Find a commit">
      <div class="branch-list" role="listbox"><span class="muted branch-note">Loading…</span></div>
    </div>`;
  const list = el.querySelector(".branch-list");
  const filter = el.querySelector(".branch-filter");
  let branches = null;
  let branch = o.commitsOf; // whose commits are listed
  let commits = [];
  let more = false;

  const option = (value, label, note, title = "") => {
    const on = value === o.value;
    return `<button type="button" role="option" data-ref="${escapeHtml(value)}"${title ? ` title="${escapeHtml(title)}"` : ""}${on ? ' aria-selected="true" disabled' : ""}><span class="branch-check">${on ? "✓" : ""}</span>${label}${note ? `<span class="muted branch-tag">${escapeHtml(note)}</span>` : ""}</button>`;
  };
  const show = () => {
    const q = filter.value.trim().toLowerCase();
    const cs = commits.filter((c) => `${c.sha} ${c.summary} ${c.author}`.toLowerCase().includes(q));
    list.innerHTML = [
      o.working && !q ? option("", "Working files", "uncommitted edits too") : "",
      // The branch is chosen here; its first item is the branch itself (it follows the branch), then its commits.
      `<div class="branch-head ref-commits-head">Commits on <select class="ref-branch" aria-label="Branch">${branches
        .map((b) => `<option value="${escapeHtml(b.name)}"${b.name === branch ? " selected" : ""}>${escapeHtml(b.name)}${b.note ? ` (${escapeHtml(b.note)})` : ""}</option>`)
        .join("")}</select></div>`,
      branch && !q ? option(branch, `Latest on <span class="mono">${escapeHtml(branch)}</span>`, "the branch") : "",
      cs
        .map((c) => option(c.sha, `<span class="mono">${c.sha.slice(0, 7)}</span><span class="base-summary">${escapeHtml(c.summary)}</span>`, ago(c.time), `${c.summary}\n${c.author}, ${new Date(c.time * 1000).toLocaleString()}\n${c.sha}`))
        .join("") || `<span class="muted branch-note">${commits.length ? "No commit matches" : "No commits"}</span>`,
      more ? `<button type="button" class="history-more" data-more>Show more</button>` : "",
    ].join("");
    list.querySelector(".ref-branch").addEventListener("change", (e) => listCommits(e.target.value).then(show, fail));
  };
  const fail = (e) => (list.innerHTML = `<span class="muted branch-note">Couldn't list branches and commits: ${escapeHtml(e.message ?? String(e))}</span>`);
  async function listCommits(b, append = false) {
    branch = b;
    const batch = b ? await o.commits(b, append ? commits.length : 0, PAGE) : [];
    commits = append ? [...commits, ...batch] : batch;
    more = batch.length === PAGE;
  }

  el.addEventListener("toggle", async () => {
    if (!el.open) return;
    filter.value = "";
    if (!branches) {
      try {
        branches = await o.branches();
        if (!branches.some((b) => b.name === branch)) branch = branches[0]?.name ?? null;
        await listCommits(branch);
      } catch (e) {
        branches = null;
        return fail(e);
      }
    }
    show();
    filter.focus();
  });
  filter.addEventListener("input", show);
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-ref], button[data-more]");
    if (!b || b.disabled) return;
    try {
      if (b.dataset.more !== undefined) {
        b.disabled = true;
        await listCommits(branch, true);
        return show();
      }
      el.open = false;
      await o.pick(b.dataset.ref);
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
