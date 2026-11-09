// The Projects view's "+" button: a small menu to add a local project (a
// folder on this computer, local-projects.js) or a remote one (a GitHub or
// GitLab repository, added to the watched repositories that the gallery scans,
// by key: see repoKey in ../forge/index.js).
// It replaced the address bar the pages used to have.

import { escapeHtml, settings, saveSettings, signedInForge, tokenFor } from "../app/ui.js";
import { FORGES, forge, forgeNames, parseRepoInput, repoKey } from "../forge/index.js";
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
    <button type="button" role="menuitem" data-add="remote">${ICONS.repo}<span><strong>Remote project…</strong><span class="muted">A ${escapeHtml(forgeNames())} repository</span></span></button>`;
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
 * Watch a repository (its key), so the gallery and the pull request list include
 * it; a repository removed from the gallery before (settings.hiddenRepos) shows again.
 */
export function watchRepo(key) {
  const s = settings();
  const watched = s.watchRepos ?? [];
  saveSettings({
    ...s,
    watchRepos: watched.some((w) => same(w, key)) ? watched : [...watched, key],
    hiddenRepos: (s.hiddenRepos ?? []).filter((h) => !same(h, key)),
  });
}

/**
 * Remove from projects (a GitHub card's menu): the repository leaves the gallery
 * and the pull request list, remembered as hidden. It stays watched, so Reload
 * (which clears the hidden ones) brings it back, as does adding it again with
 * Remote project….
 */
export function removeRepo(key) {
  const s = settings();
  saveSettings({ ...s, hiddenRepos: [...(s.hiddenRepos ?? []).filter((h) => !same(h, key)), key] });
}

/**
 * Remote project…: ask for a repository and watch it, so the gallery lists its
 * projects. Its address says which forge it's on; a shorthand (owner/repo) goes
 * to the forge signed in to (parseRepoInput), shown under the box as it's
 * typed. Checked first: it must exist, be visible to this account, have KiCad
 * projects (`hasProjects`) and not be in the gallery already (`inGallery`).
 * Resolves with the repository's key once added, or null.
 */
export function addRemoteProject({ inGallery, hasProjects }) {
  const preferred = forge(signedInForge() ?? undefined);
  return new Promise((resolve) => {
    const dlg = dialog(`<form method="dialog" class="settings">
      <h2>Add a remote project</h2>
      <p class="muted settings-hint">A ${escapeHtml(forgeNames())} repository with KiCad projects. Its projects join the gallery and its pull or merge requests the list of them. Remove from projects in a card's menu takes it off again, until the next Reload.</p>
      <label class="field-label" for="remote-repo">Repository</label>
      <input id="remote-repo" class="input mono" required spellcheck="false" autocomplete="off" placeholder="${escapeHtml(`owner/repo, ${FORGES.map((f) => f.web.repo("owner/repo")).join(" or ")}`)}">
      <p class="muted settings-hint" id="remote-where">&nbsp;</p>
      <p class="muted settings-hint error-text" id="remote-error" hidden></p>
      <div class="row end gap"><button value="cancel" class="btn" formnovalidate>Cancel</button><button value="ok" class="btn primary">Add</button></div>
    </form>`);
    const box = dlg.querySelector("#remote-repo");
    const where = dlg.querySelector("#remote-where");
    const error = dlg.querySelector("#remote-error");
    // Where the repository will be looked for, as it's typed.
    box.addEventListener("input", () => {
      const at = parseRepoInput(box.value, preferred);
      where.textContent = at ? `On ${at.forge.name}: ${at.spec.owner}/${at.spec.repo}` : "\u00a0";
    });
    const add = dlg.querySelector('button[value="ok"]');
    const fail = (msg) => {
      error.textContent = msg;
      error.hidden = false;
    };
    // Checked before the dialog closes, so a typo can be fixed in place.
    dlg.querySelector("form").addEventListener("submit", async (e) => {
      if (e.submitter?.value !== "ok") return;
      e.preventDefault();
      const at = parseRepoInput(box.value, preferred);
      if (!at) return fail(`Enter the repository as owner/repo or its address (${FORGES.map((f) => f.host).join(", ")})`);
      const { forge: host, spec: gh } = at;
      error.hidden = true;
      add.disabled = true;
      try {
        const r = await host.repo(`${gh.owner}/${gh.repo}`, await ensureFreshToken(host));
        const nwo = r.nwo; // its real name and case
        const key = repoKey(host, nwo);
        if (inGallery(key)) return fail(`${nwo} is in the gallery already`);
        if (!(await hasProjects(key))) return fail(`${nwo} has no KiCad projects`);
        watchRepo(key);
        dlg.close("added");
        resolve(key);
      } catch (err) {
        // Not found: a typo, or private and not visible to this sign-in (or signed out).
        const why = tokenFor(host) ? "or this account can't see it" : `or it's private: sign in to ${host.name} to add it`;
        fail(err.status === 404 ? `${gh.owner}/${gh.repo} isn't on ${host.name}, ${why}` : String(err.message ?? err));
      } finally {
        add.disabled = false;
      }
    });
    dlg.addEventListener("close", () => dlg.returnValue !== "added" && resolve(null));
  });
}
