// The Projects view's "+" button: a small menu to add a local project (a
// folder on this computer, local-projects.js) or a remote one (a GitHub
// repository, added to the watched repositories that the gallery scans).
// It replaced the address bar the pages used to have.

import { escapeHtml, settings, saveSettings } from "../app/ui.js";
import { forge } from "../forge/index.js";
import { dialog } from "./git.js";
import { ICONS } from "./icons.js";
import { ensureFreshToken } from "./tauri.js";

/**
 * Turn `el` (a <details class="menu"> holding the "+" summary) into the add menu.
 * The menu closes on an outside click or Escape like the other menus (account.js).
 * @param {HTMLDetailsElement} el
 * @param {{local: () => Promise<void>, remote: () => Promise<void>}} actions
 */
export function mountAddMenu(el, actions) {
  const panel = el.querySelector(".menu-panel");
  panel.innerHTML = `
    <button type="button" role="menuitem" data-add="local">${ICONS.folder}<span><strong>Local project…</strong><span class="muted">A folder on this computer</span></span></button>
    <button type="button" role="menuitem" data-add="remote">${ICONS.repo}<span><strong>Remote project…</strong><span class="muted">A GitHub repository</span></span></button>`;
  for (const b of panel.querySelectorAll("[data-add]")) {
    b.addEventListener("click", () => {
      el.open = false;
      actions[b.dataset.add]();
    });
  }
  el.hidden = false;
}

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * Watch a repository, so the gallery and the pull request list include it; a
 * repository removed from the gallery before (settings.hiddenRepos) shows again.
 */
export function watchRepo(nwo) {
  const s = settings();
  const watched = s.watchRepos ?? [];
  saveSettings({
    ...s,
    watchRepos: watched.some((w) => same(w, nwo)) ? watched : [...watched, nwo],
    hiddenRepos: (s.hiddenRepos ?? []).filter((h) => !same(h, nwo)),
  });
}

/**
 * Remove from projects (a GitHub card's menu): the repository leaves the gallery
 * and the pull request list, remembered as hidden. It stays watched, so Reload
 * (which clears the hidden ones) brings it back, as does adding it again with
 * Remote project….
 */
export function removeRepo(nwo) {
  const s = settings();
  saveSettings({ ...s, hiddenRepos: [...(s.hiddenRepos ?? []).filter((h) => !same(h, nwo)), nwo] });
}

/**
 * Remote project…: ask for a GitHub repository and watch it, so the gallery lists
 * its projects. Checked first: it must exist, be visible to this account, have
 * KiCad projects (`hasProjects`) and not be in the gallery already (`inGallery`).
 * Resolves with "owner/repo" once added, or null.
 */
export function addRemoteProject({ inGallery, hasProjects }) {
  const host = forge();
  return new Promise((resolve) => {
    const dlg = dialog(`<form method="dialog" class="settings">
      <h2>Add a remote project</h2>
      <p class="muted settings-hint">A GitHub repository with KiCad projects. Its projects join the gallery and its pull requests the pull request list. Remove from projects in a card's menu takes it off again, until the next Reload.${
        settings().token ? "" : " Signed out, only public repositories can be added."
      }</p>
      <label class="field-label" for="remote-repo">GitHub repository</label>
      <input id="remote-repo" class="input mono" required spellcheck="false" autocomplete="off" placeholder="owner/repo or ${escapeHtml(host.web.repo("owner/repo"))}">
      <p class="muted settings-hint error-text" id="remote-error" hidden></p>
      <div class="row end gap"><button value="cancel" class="btn" formnovalidate>Cancel</button><button value="ok" class="btn primary">Add</button></div>
    </form>`);
    const box = dlg.querySelector("#remote-repo");
    const error = dlg.querySelector("#remote-error");
    const add = dlg.querySelector('button[value="ok"]');
    const fail = (msg) => {
      error.textContent = msg;
      error.hidden = false;
    };
    // Checked before the dialog closes, so a typo can be fixed in place.
    dlg.querySelector("form").addEventListener("submit", async (e) => {
      if (e.submitter?.value !== "ok") return;
      e.preventDefault();
      const gh = host.parseSpec(box.value.trim());
      if (!gh) return fail(`Enter the repository as owner/repo or its ${host.host} address`);
      error.hidden = true;
      add.disabled = true;
      try {
        const r = await host.repo(`${gh.owner}/${gh.repo}`, await ensureFreshToken());
        const nwo = r.nwo; // its real name and case
        if (inGallery(nwo)) return fail(`${nwo} is in the gallery already`);
        if (!(await hasProjects(nwo))) return fail(`${nwo} has no KiCad projects`);
        watchRepo(nwo);
        dlg.close("added");
        resolve(nwo);
      } catch (err) {
        fail(err.status === 404 ? `${gh.owner}/${gh.repo} isn't on ${host.name}, or this account can't see it` : String(err.message ?? err));
      } finally {
        add.disabled = false;
      }
    });
    dlg.addEventListener("close", () => dlg.returnValue !== "added" && resolve(null));
  });
}
