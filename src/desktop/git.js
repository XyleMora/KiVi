// Local git copies of GitHub projects (src-tauri/src/git.rs): download a
// project's repository to a folder or link a clone already on disk, then, in
// the viewer, a branch menu for a new branch, the visual diff of the local
// changes against main, and commit and push.
//
// Links are kept in settings.localCopies: {"owner/repo" (lower case): folder}.

import { $, escapeHtml, settings, saveSettings, toast } from "../app/ui.js";
import { GitHubSource } from "../sources.js";
import { ensureFreshToken, invoke, listen, pickFolder } from "./tauri.js";
import { mountBranchMenu } from "../app/branch-menu.js";


// ---- links between GitHub projects and folders --------------------------------

const key = (nwo) => nwo.toLowerCase();

/** The folder linked to a repository ("owner/repo"), if any. */
export function localCopy(nwo) {
  return settings().localCopies?.[key(nwo)] ?? null;
}

function setLocalCopy(nwo, path) {
  const s = settings();
  const copies = { ...(s.localCopies ?? {}) };
  if (path) copies[key(nwo)] = path;
  else delete copies[key(nwo)];
  saveSettings({ ...s, localCopies: copies });
}

export const unlinkLocalCopy = (nwo) => setLocalCopy(nwo, null);

/** The viewer URL of a project inside a linked folder, optionally on a tab (sch, pcb, 3d, bom). */
export function localViewUrl(folder, project, tab = null) {
  return `index.html#${new URLSearchParams({ folder, ...(project && { project }), ...(tab && { tab }) })}`;
}

/**
 * Download github.com/<nwo> into a folder the user picks (as `<folder>/<repo>`)
 * and link it. Resolves with the new folder, or null if cancelled.
 */
export async function cloneProject(nwo) {
  const parent = await pickFolder(`Download ${nwo} into…`);
  if (!parent) return null;
  const [owner, repo] = nwo.split("/");
  const token = await ensureFreshToken();
  const dlg = progressDialog(`Downloading ${nwo}`, "Connecting to GitHub…");
  const stop = await listen("git-progress", ({ payload: p }) => {
    const mb = (p.bytes / 1048576).toFixed(1);
    dlg.set(p.total ? `${p.received} of ${p.total} objects · ${mb} MB` : `${mb} MB`, p.total ? p.received / p.total : null);
  });
  try {
    const folder = await invoke("git_clone", { owner, repo, parent, token });
    setLocalCopy(nwo, folder);
    toast(`Downloaded to ${folder}`);
    return folder;
  } finally {
    stop();
    dlg.close();
  }
}

/** Link a folder that is already a clone of github.com/<nwo>. Resolves with its top folder, or null. */
export async function linkProject(nwo) {
  const picked = await pickFolder(`Choose your clone of ${nwo}`);
  if (!picked) return null;
  let info;
  try {
    info = await invoke("git_info", { path: picked });
  } catch {
    throw new Error(`${picked} isn't a git clone. Download the project instead, or choose the folder you cloned it into.`);
  }
  if (!info.owner || key(`${info.owner}/${info.repo}`) !== key(nwo)) {
    const what = info.owner ? `a clone of ${info.owner}/${info.repo}` : "not linked to GitHub";
    throw new Error(`${info.root} is ${what}, not ${nwo}.`);
  }
  setLocalCopy(nwo, info.root);
  toast(`Linked ${nwo} to ${info.root}`);
  return info.root;
}

// ---- sync state (the gallery's sync icon) ----------------------------------------------

const syncChecks = new Map(); // "owner/repo" (lower case) → Promise<{color, title}>
const syncKnown = new Map(); // the same, once settled, so a re-rendered card shows it at once

/** The last sync state found for a repository, or null if not checked yet. */
export const knownSync = (nwo) => syncKnown.get(key(nwo)) ?? null;

/** Check the linked copies again on the next syncState() (after Refresh, a commit, linking). */
export function forgetSync(nwo = null) {
  if (nwo) syncChecks.delete(key(nwo));
  else syncChecks.clear();
}

/**
 * How a repository's local copy compares with GitHub, as the gallery's sync icon:
 * grey (no local copy), green (nothing uncommitted, branch identical on GitHub)
 * or yellow (uncommitted changes, commits to push, or newer commits on GitHub).
 * @returns {Promise<{color: "grey"|"green"|"yellow", title: string}>}
 */
export function syncState(nwo) {
  const folder = localCopy(nwo);
  if (!folder) return Promise.resolve({ color: "grey", title: "Not on this computer: Download or Link it from the ⋯ menu" });
  if (!syncChecks.has(key(nwo))) {
    const check = (async () => {
      const [owner, repo] = nwo.split("/");
      let st = null;
      try {
        st = await invoke("git_remote_state", { path: folder, owner, repo, token: await ensureFreshToken() });
      } catch {
        // the folder was moved or deleted
      }
      if (!st) return { color: "grey", title: `The linked folder can't be read: ${folder}` };
      const offline = st.error ? ` (GitHub not reachable, as of the last fetch: ${st.error})` : "";
      if (!st.changes && st.relation === "same") return { color: "green", title: `In sync with GitHub on ${st.branch}${offline}\n${folder}` };
      const notes = [];
      if (st.changes) notes.push(`${st.changes} uncommitted file${st.changes > 1 ? "s" : ""}`);
      const why = {
        ahead: "commits not pushed yet",
        behind: "GitHub has newer commits",
        diverged: "both GitHub and this copy have new commits",
        unpushed: `the branch ${st.branch} isn't on GitHub`,
        unknown: st.branch ? `GitHub not reachable${st.error ? `: ${st.error}` : ""}` : "not on a branch",
      }[st.relation];
      if (why) notes.push(why);
      return { color: "yellow", title: `Local copy differs from GitHub: ${notes.join(", ")}\n${folder}` };
    })();
    syncChecks.set(key(nwo), check);
    check.then((r) => syncKnown.set(key(nwo), r));
  }
  return syncChecks.get(key(nwo));
}

// ---- the diff page's local mode -----------------------------------------------------

/**
 * What diff.js needs to compare a working copy with main, given to it by
 * desktop.js (shared app code doesn't call Tauri itself).
 */
export function localGitApi() {
  return {
    async changes(root, base) {
      // Bring main up to date first, best effort: offline, the last fetched main is used.
      const info = await invoke("git_info", { path: root });
      if (info.owner) {
        const token = await ensureFreshToken();
        await invoke("git_fetch", { path: root, owner: info.owner, repo: info.repo, token }).catch((e) => console.warn("fetch:", e));
      }
      return invoke("git_local_changes", { path: root, base: base || null });
    },
    source(root, rev) {
      return {
        readText: async (file) => new TextDecoder().decode(new Uint8Array(await invoke("git_read", { path: root, rev, file }))),
        list: () => invoke("git_list", { path: root, rev }),
      };
    },
  };
}

// ---- the viewer's branch menu --------------------------------------------------------

/**
 * The project bar's branch menu (src/app/branch-menu.js) while `folder`, a
 * local git copy, is open: its branches to switch to, plus new branch, the
 * visual diff and commit and push. Nothing if the folder isn't a git copy.
 * Returns {refresh()}.
 */
export function mountGitMenu(folder) {
  const removeOurs = () => $("#branch-menu")?.dataset.kind === "local" && $("#branch-menu").remove();
  async function refresh() {
    let info = null;
    try {
      info = await invoke("git_info", { path: folder });
    } catch {
      // not a git copy
    }
    if (window.kivi?.source?.path !== folder) return; // another project was opened meanwhile
    if (!info?.root) return removeOurs();
    // Like a GitHub project's bar: View on GitHub, here for the branch checked out.
    const gh = $("#gh-link");
    if (gh && info.owner) {
      gh.hidden = false;
      gh.href = `https://github.com/${info.owner}/${info.repo}${info.branch ? `/tree/${info.branch.split("/").map(encodeURIComponent).join("/")}` : ""}`;
    }
    const n = info.changes;
    const ahead = info.ahead ? `, ${info.ahead} commit${info.ahead > 1 ? "s" : ""} to push` : "";
    const commitItem = info.owner
      ? `<button type="button" data-act="commit">${n || !info.ahead ? "Commit and push…" : `Push ${info.ahead} commit${info.ahead > 1 ? "s" : ""}…`}</button>`
      : `<span class="muted branch-note">Not linked to GitHub: no push</span>`;
    mountBranchMenu({
      kind: "local",
      branch: info.branch,
      count: n,
      title: `${info.root}\n${n} changed file${n === 1 ? "" : "s"}${ahead}`,
      itemsHtml: `<button type="button" data-act="branch">New branch…</button>
        <a href="${escapeHtml(diffUrl(info.root))}">Visual diff of changes${n ? ` (${n})` : ""}</a>
        ${commitItem}`,
      onAct: async (act) => {
        try {
          if (act === "branch") await newBranchDialog(info);
          if (act === "commit") await commitDialog(info);
        } finally {
          refresh();
        }
      },
      listBranches: async () => {
        // GitHub's branches as they are now, best effort (offline: as last fetched).
        if (info.owner) await invoke("git_fetch", { path: info.root, owner: info.owner, repo: info.repo, token: await ensureFreshToken() }).catch(() => {});
        const list = await invoke("git_branches", { path: info.root });
        return list.map((b) => ({ name: b.name, current: b.current, note: b.remote ? "on GitHub" : "" }));
      },
      // The files change on disk, so live reload shows the other branch.
      switchTo: async (name) => {
        await invoke("git_switch_branch", { path: info.root, name });
        toast(`Switched to ${name}`);
        refresh();
      },
    });
  }
  refresh();
  return { refresh };
}

const diffUrl = (root) => `diff.html#${new URLSearchParams({ local: root })}`;

// ---- dialogs -------------------------------------------------------------------------------

function dialog(html) {
  const dlg = document.createElement("dialog");
  dlg.className = "git-dialog";
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("keydown", (e) => e.key === "Escape" && e.preventDefault()); // handled here, not by open menus
  dlg.showModal();
  return dlg;
}

function progressDialog(title, text) {
  const dlg = dialog(`<div class="settings"><h2>${escapeHtml(title)}</h2><progress class="git-progress"></progress><p class="muted git-progress-text">${escapeHtml(text)}</p></div>`);
  dlg.addEventListener("cancel", (e) => e.preventDefault()); // can't be stopped half-way
  return {
    set(t, fraction) {
      dlg.querySelector(".git-progress-text").textContent = t;
      const bar = dlg.querySelector("progress");
      if (fraction == null) bar.removeAttribute("value");
      else bar.value = fraction;
    },
    close: () => dlg.close(),
  };
}

function newBranchDialog(info) {
  return new Promise((resolve) => {
    const dlg = dialog(`<form method="dialog" class="settings">
      <h2>New branch</h2>
      <p class="muted settings-hint">From the current commit on <b>${escapeHtml(info.branch ?? "HEAD")}</b>. Uncommitted changes come along.</p>
      <label class="field-label" for="git-branch-name">Branch name</label>
      <input id="git-branch-name" class="input mono" required spellcheck="false" autocomplete="off" placeholder="fix/led/footprint">
      <div class="row end gap"><button value="cancel" class="btn" formnovalidate>Cancel</button><button value="ok" class="btn primary">Create and switch</button></div>
    </form>`);
    dlg.addEventListener("close", async () => {
      const name = dlg.querySelector("#git-branch-name").value.trim();
      if (dlg.returnValue === "ok" && name) {
        try {
          await invoke("git_create_branch", { path: info.root, name });
          toast(`Switched to the new branch ${name}`);
        } catch (e) {
          toast(String(e), true);
        }
      }
      resolve();
    });
  });
}

/** The commit author when the copy has no git identity: the GitHub account, with its private e-mail. */
async function fallbackAuthor() {
  try {
    const me = await GitHubSource.api("/user", await ensureFreshToken());
    return { name: me.name || me.login, email: `${me.id}+${me.login}@users.noreply.github.com` };
  } catch {
    return { name: "KiVi user", email: "kivi@users.noreply.github.com" };
  }
}

async function commitDialog(info) {
  if (!settings().token) {
    window.dispatchEvent(new Event("kivi:signin"));
    throw new Error("Sign in with GitHub to push");
  }
  const files = await invoke("git_status", { path: info.root });
  const onMain = info.branch === "main" || info.branch === "master";
  const icon = { added: "+", removed: "−", modified: "~", conflicted: "!" };
  return new Promise((resolve) => {
    const dlg = dialog(`<form method="dialog" class="settings git-commit">
      <h2>${files.length ? "Commit and push" : "Push"}</h2>
      <p class="muted settings-hint">To <b>${escapeHtml(info.branch ?? "?")}</b> on github.com/${escapeHtml(`${info.owner}/${info.repo}`)}.</p>
      ${onMain ? `<p class="git-warn">You're on <b>${escapeHtml(info.branch)}</b>: pushing changes it for everyone, and protected branches refuse it. Create a branch first to open a pull request instead.</p>` : ""}
      ${
        files.length
          ? `<label class="check"><input type="checkbox" id="git-all" checked> All ${files.length} changed files</label>
             <ul class="git-files">${files
               .map((f, i) => `<li><label class="check"><input type="checkbox" data-file="${i}" checked><span class="st st-${f.status === "removed" ? "removed" : f.status === "added" ? "added" : "modified"}">${icon[f.status] ?? "~"}</span><span class="mono">${escapeHtml(f.path)}</span></label></li>`)
               .join("")}</ul>
             <label class="field-label" for="git-message">Message</label>
             <textarea id="git-message" class="input" rows="3" required placeholder="What changed, e.g. Swap R12 for a 0603"></textarea>`
          : `<p>No uncommitted changes. ${info.ahead ? `${info.ahead} commit(s) aren't on GitHub yet.` : "Everything is pushed."}</p>`
      }
      <p class="git-result muted" hidden></p>
      <div class="row end gap"><button value="cancel" class="btn" formnovalidate>Close</button>${files.length ? `<button value="commit" class="btn">Commit</button>` : ""}<button value="push" class="btn primary">${files.length ? "Commit and push" : "Push"}</button></div>
    </form>`);
    const boxes = [...dlg.querySelectorAll("[data-file]")];
    const all = dlg.querySelector("#git-all");
    all?.addEventListener("change", () => boxes.forEach((b) => (b.checked = all.checked)));
    for (const b of boxes) {
      b.addEventListener("change", () => {
        const n = boxes.filter((x) => x.checked).length;
        all.checked = n === boxes.length;
        all.indeterminate = n > 0 && n < boxes.length;
      });
    }
    const result = dlg.querySelector(".git-result");
    const buttons = [...dlg.querySelectorAll("button")];
    let committed = false; // a failed push is retried without committing again
    dlg.querySelector("form").addEventListener("submit", async (e) => {
      const act = e.submitter?.value;
      if (act === "cancel") return;
      e.preventDefault(); // stay open to show the result
      buttons.forEach((b) => (b.disabled = true));
      try {
        if (files.length && !committed) {
          const chosen = files.filter((_, i) => boxes[i].checked).map((f) => f.path);
          if (!chosen.length) throw new Error("Choose at least one file");
          const message = dlg.querySelector("#git-message").value;
          const author = await fallbackAuthor();
          await invoke("git_commit", { path: info.root, files: chosen, message, name: author.name, email: author.email });
          committed = true;
          boxes.forEach((b) => (b.disabled = true));
          dlg.querySelector("button[value=commit]")?.remove();
        }
        if (act === "push") {
          result.hidden = false;
          result.textContent = "Pushing to GitHub…";
          const token = await ensureFreshToken();
          const branch = await invoke("git_push", { path: info.root, owner: info.owner, repo: info.repo, token });
          const compare = `https://github.com/${info.owner}/${info.repo}/compare/${encodeURIComponent(branch)}?expand=1`;
          result.innerHTML = `Pushed <b>${escapeHtml(branch)}</b> to GitHub. ${onMain ? "" : `<a href="${escapeHtml(compare)}" target="_blank" rel="noopener">Open a pull request</a>`}`;
        } else {
          result.hidden = false;
          result.textContent = "Committed. Push when you're ready.";
        }
        dlg.querySelector("button[value=commit]")?.remove();
        dlg.querySelector("button[value=push]")?.remove();
      } catch (err) {
        result.hidden = false;
        result.textContent = String(err.message ?? err);
        result.classList.add("git-error");
      } finally {
        buttons.forEach((b) => (b.disabled = false));
      }
    });
    dlg.addEventListener("close", () => resolve());
  });
}
