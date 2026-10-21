// The project bar's branch button (⎇ main) and its menu, the same for a GitHub
// project (main.js: the repository's branches) and a local git copy
// (src/desktop/git.js: its branches, plus new branch, diff, commit and push).
// The menu lists the branches with a filter; picking one switches to it.

import { $, escapeHtml, toast } from "./ui.js";

// One listener for whichever menu is current (the menu is re-made on every refresh).
document.addEventListener("click", (e) => {
  const el = $("#branch-menu");
  if (el?.open && !el.contains(e.target)) el.open = false;
});

export const BRANCH_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.49 2.49 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>`;

/**
 * Put the branch menu in the project bar (replacing any earlier one).
 * @param {object} o
 * @param {string} o.kind "github" | "local", so each side removes only its own menu
 * @param {string|null} o.branch the branch shown on the button
 * @param {string} [o.title] the button's tooltip
 * @param {number} [o.count] a badge after the name (local: changed files)
 * @param {string} [o.itemsHtml] extra menu items above the branch list; buttons carry data-act
 * @param {(act: string) => Promise<void>} [o.onAct] called for those buttons
 * @param {() => Promise<{name: string, current?: boolean, note?: string}[]>} o.listBranches
 * @param {(name: string) => Promise<void>} o.switchTo
 * @returns {HTMLDetailsElement}
 */
export function mountBranchMenu(o) {
  $("#branch-menu")?.remove();
  const el = document.createElement("details");
  el.id = "branch-menu";
  el.className = "menu branch-menu";
  el.dataset.kind = o.kind;
  el.innerHTML = `<summary class="btn" title="${escapeHtml(o.title ?? "Branch")}">${BRANCH_ICON}<span class="branch-name">${escapeHtml(o.branch ?? "(no branch)")}</span>${o.count ? `<span class="branch-count">${o.count}</span>` : ""}</summary>
    <div class="branch-menu-list">
      ${o.itemsHtml ? `${o.itemsHtml}<hr>` : ""}
      <div class="branch-head">Switch branch</div>
      <input class="input branch-filter" type="search" placeholder="Find a branch…" spellcheck="false" aria-label="Find a branch">
      <div class="branch-list" role="listbox"><span class="muted branch-note">Loading branches…</span></div>
    </div>`;
  $("#projbar .proj-actions")?.prepend(el);

  let branches = null;
  const list = el.querySelector(".branch-list");
  const filter = el.querySelector(".branch-filter");
  const show = () => {
    const q = filter.value.trim().toLowerCase();
    const shown = (branches ?? []).filter((b) => b.name.toLowerCase().includes(q));
    list.innerHTML =
      shown
        .map((b) => `<button type="button" role="option" data-branch="${escapeHtml(b.name)}"${b.current ? ' aria-selected="true" disabled' : ""}><span class="branch-check">${b.current ? "✓" : ""}</span><span class="mono">${escapeHtml(b.name)}</span>${b.note ? `<span class="muted branch-tag">${escapeHtml(b.note)}</span>` : ""}</button>`)
        .join("") || `<span class="muted branch-note">${branches?.length ? "No branch matches" : "No other branches"}</span>`;
  };
  el.addEventListener("toggle", async () => {
    if (!el.open) return;
    filter.value = "";
    if (!branches) {
      try {
        branches = await o.listBranches();
      } catch (e) {
        list.innerHTML = `<span class="muted branch-note">Couldn't list branches: ${escapeHtml(e.message ?? String(e))}</span>`;
        return;
      }
    }
    show();
    filter.focus();
  });
  filter.addEventListener("input", show);
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-branch], button[data-act]");
    if (!b || b.disabled) return;
    el.open = false;
    try {
      if (b.dataset.branch) await o.switchTo(b.dataset.branch);
      else await o.onAct?.(b.dataset.act);
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
