// Local git copies of forge projects (src-tauri/src/git.rs): download a
// project's repository to a folder or link a clone already on disk, then, in
// the viewer, a branch menu for a new branch, the visual diff of the local
// changes against main, and commit and push.
//
// Links are kept in settings.localCopies: {repository key (lower case): folder};
// a key is "owner/repo" on GitHub, "gitlab:group/project" on GitLab (repoKey,
// ../forge/index.js). git_info says which forge a copy belongs to (remoteOf).

import { $, escapeHtml, settings, saveSettings, toast, tokenFor } from "../app/ui.js";
import { forgeNames, parseRepoKey, remoteOf } from "../forge/index.js";
import { ensureFreshToken, folderPrefix, invoke, listen, pickFolder } from "./tauri.js";
import { mountBranchMenu } from "../app/branch-menu.js";
import { mountHistoryMenu } from "../app/history-menu.js";
import { setDiffButton } from "../app/diff-button.js";


// ---- links between forge projects and folders --------------------------------

const key = (rk) => rk.toLowerCase();

/** The arguments the git commands take for a forge repository. */
const remoteArgs = (r) => ({ host: r.forge.host, owner: r.owner, repo: r.repo });

/** git_info, with the forge repository it belongs to as `remote` (remoteOf; null: none). */
export async function gitInfo(path) {
  const info = await invoke("git_info", { path });
  return { ...info, remote: remoteOf(info) };
}

/** The folder linked to a repository (its key, see repoKey), if any. */
export function localCopy(rk) {
  return settings().localCopies?.[key(rk)] ?? null;
}

/** Link (or with null, unlink) the folder holding a repository's clone. */
export function setLocalCopy(rk, path) {
  const s = settings();
  const copies = { ...(s.localCopies ?? {}) };
  if (path) copies[key(rk)] = path;
  else delete copies[key(rk)];
  saveSettings({ ...s, localCopies: copies });
}

export const unlinkLocalCopy = (rk) => setLocalCopy(rk, null);

/** The viewer URL of a project inside a linked folder, optionally on a tab (sch, pcb, 3d, bom). */
export function localViewUrl(folder, project, tab = null) {
  return `index.html#${new URLSearchParams({ folder, ...(project && { project }), ...(tab && { tab }) })}`;
}

/**
 * Download a forge repository (its key) into a folder the user picks (as
 * `<folder>/<repo>`) and link it. Resolves with the new folder, or null if cancelled.
 */
export async function cloneProject(rk) {
  const r = parseRepoKey(rk);
  const parent = await pickFolder(`Download ${r.nwo} into…`);
  if (!parent) return null;
  const token = await ensureFreshToken(r.forge);
  const dlg = progressDialog(`Downloading ${r.nwo}`, `Connecting to ${r.forge.name}…`);
  const stop = await listen("git-progress", ({ payload: p }) => {
    const mb = (p.bytes / 1048576).toFixed(1);
    dlg.set(p.total ? `${p.received} of ${p.total} objects · ${mb} MB` : `${mb} MB`, p.total ? p.received / p.total : null);
  });
  try {
    const folder = await invoke("git_clone", { ...remoteArgs(r), parent, token });
    setLocalCopy(rk, folder);
    toast(`Downloaded to ${folder}`);
    return folder;
  } finally {
    stop();
    dlg.close();
  }
}

/** Link a folder that is already a clone of a forge repository (its key). Resolves with its top folder, or null. */
export async function linkProject(rk) {
  const { nwo, forge: f } = parseRepoKey(rk);
  const picked = await pickFolder(`Choose your clone of ${nwo}`);
  if (!picked) return null;
  let info;
  try {
    info = await gitInfo(picked);
  } catch {
    throw new Error(`${picked} isn't a git clone. Download the project instead, or choose the folder you cloned it into.`);
  }
  if (!info.remote || key(info.remote.key) !== key(rk)) {
    const what = info.remote ? `a clone of ${info.remote.nwo} on ${info.remote.forge.name}` : `not linked to ${forgeNames()}`;
    throw new Error(`${info.root} is ${what}, not ${nwo} on ${f.name}.`);
  }
  setLocalCopy(rk, info.root);
  toast(`Linked ${nwo} to ${info.root}`);
  return info.root;
}

// ---- sync state (the gallery's sync icon) ----------------------------------------------

const syncChecks = new Map(); // repository key (lower case) + "\n" + folder → Promise<{color, title}>
const syncKnown = new Map(); // the same, once settled, so a re-rendered card shows it at once
const syncKey = (rk, folder) => `${key(rk)}\n${folder}`;

/** The last sync state found for a repository's copy, or null if not checked yet. */
export const knownSync = (rk, folder = localCopy(rk)) => syncKnown.get(syncKey(rk, folder)) ?? null;

/** Check the linked copies again on the next syncState() (after Refresh, a commit, linking). */
export function forgetSync(rk = null) {
  if (!rk) return syncChecks.clear();
  for (const k of syncChecks.keys()) if (k.startsWith(`${key(rk)}\n`)) syncChecks.delete(k);
}

/**
 * How a repository's local copy compares with its forge, as the gallery's sync
 * icon: grey (no local copy), green (nothing uncommitted, branch identical on
 * the forge) or yellow (uncommitted changes, commits to push, or newer commits
 * there). `rk` is the repository's key; `folder` is the copy: the linked one by
 * default, or a local project's.
 * @returns {Promise<{color: "grey"|"green"|"yellow", title: string}>}
 */
export function syncState(rk, folder = localCopy(rk)) {
  if (!folder) return Promise.resolve({ color: "grey", title: "Not on this computer: Download or Link it from the ⋯ menu" });
  const k = syncKey(rk, folder);
  if (!syncChecks.has(k)) {
    const check = (async () => {
      const r = parseRepoKey(rk);
      const F = r.forge.name;
      let st = null;
      try {
        st = await invoke("git_remote_state", { path: folder, ...remoteArgs(r), token: await ensureFreshToken(r.forge) });
      } catch {
        // the folder was moved or deleted
      }
      if (!st) return { color: "grey", title: `The linked folder can't be read: ${folder}` };
      const offline = st.error ? ` (${F} not reachable, as of the last fetch: ${st.error})` : "";
      if (!st.changes && st.relation === "same") return { color: "green", title: `In sync with ${F} on ${st.branch}${offline}\n${folder}` };
      const notes = [];
      if (st.changes) notes.push(`${st.changes} uncommitted file${st.changes > 1 ? "s" : ""}`);
      const why = {
        ahead: "commits not pushed yet",
        behind: `${F} has newer commits (Pull… in the branch menu brings them in)`,
        diverged: `both ${F} and this copy have new commits (Pull… in the branch menu)`,
        unpushed: `the branch ${st.branch} isn't on ${F}`,
        unknown: st.branch ? `${F} not reachable${st.error ? `: ${st.error}` : ""}` : "not on a branch",
      }[st.relation];
      if (why) notes.push(why);
      return { color: "yellow", title: `Local copy differs from ${F}: ${notes.join(", ")}\n${folder}` };
    })();
    syncChecks.set(k, check);
    check.then((r) => syncKnown.set(k, r));
  }
  return syncChecks.get(k);
}

// ---- the diff page's local mode -----------------------------------------------------

/**
 * What diff.js needs to compare a working copy (or a branch or commit) with
 * main (or another), given to it by desktop.js (shared app code doesn't call Tauri itself).
 */
export function localGitApi() {
  return {
    async changes(root, base, head) {
      // Bring main up to date first, best effort: offline, the last fetched main is used.
      const info = await gitInfo(root);
      if (info.remote) {
        const token = await ensureFreshToken(info.remote.forge);
        await invoke("git_fetch", { path: root, ...remoteArgs(info.remote), token }).catch((e) => console.warn("fetch:", e));
      }
      return invoke("git_local_changes", { path: root, base: base || null, head: head || null });
    },
    /** For the pickers: the branches (local, then the forge's) and a branch's commits. */
    branches: async (root) => {
      const [list, info] = await Promise.all([invoke("git_branches", { path: root }), gitInfo(root).catch(() => null)]);
      return list.map((b) => ({ ...b, forge: info?.remote?.forge.name ?? null })); // where `remote` branches are
    },
    commits: async (root, rev, offset, count) => (await invoke("git_log", { path: root, limit: offset + count, rev })).slice(offset),
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
 * local git copy, is open: its branches to switch to, plus new branch and
 * commit and push; the history menu, the branch's commits; and the Visual diff
 * button's link. Nothing (the button greyed out) if the folder isn't a git copy.
 * @param {string} folder
 * @param {{viewing: () => string|null, show: (sha: string|null) => Promise<void>}} history
 *   the commit shown (null: the working files), and how to show another (desktop.js)
 * @returns {{refresh: () => Promise<void>}}
 */
export function mountGitMenu(folder, history) {
  const removeOurs = () => {
    for (const id of ["#branch-menu", "#history-menu"]) if ($(id)?.dataset.kind === "local") $(id).remove();
  };
  async function refresh() {
    let info = null;
    try {
      info = await gitInfo(folder);
    } catch {
      // not a git copy
    }
    if (window.kivi?.source?.path !== folder) return; // another project was opened meanwhile
    // Its forge repository's issues are pinned in the viewer, like on forge projects.
    const r = info?.remote;
    window.kivi?.setLocalIssues?.(r ? { folder, forge: r.forge.id, owner: r.owner, repo: r.repo, prefix: folderPrefix(folder, info.root), commit: history.viewing() ?? info.head ?? null } : null);
    if (!info?.root) {
      setDiffButton({ title: "Visual diff needs a git repository: add the folder with + → Local project… to make it one" });
      return removeOurs();
    }
    const n = info.changes;
    // The working files against main, or the commit shown against its parent.
    const shown = history.viewing();
    setDiffButton({
      href: `diff.html#${new URLSearchParams({ local: info.root, ...(shown && { base: `${shown}^`, head: shown }) })}`,
      title: shown ? `Visual diff of commit ${shown.slice(0, 7)}` : `Visual diff of the working files${n ? ` (${n} changed)` : ""} against main; pick other branches or commits there`,
    });
    const ahead = info.ahead ? `, ${info.ahead} commit${info.ahead > 1 ? "s" : ""} to push` : "";
    // Greyed out (saying why) when there's nothing to do. Without a forge, commits stay on this computer.
    const item = (act, label, why) => `<button type="button" data-act="${act}"${why ? ` aria-disabled="true" title="${escapeHtml(why)}"` : ""}>${label}</button>`;
    const commitItem = item("commit", "Commit…", n ? "" : "No uncommitted changes");
    const pushItem = !r
      ? `<span class="muted branch-note">Not linked to ${escapeHtml(forgeNames())}: no push or pull</span>`
      : item("push", info.ahead ? `Push ${info.ahead} commit${info.ahead > 1 ? "s" : ""}…` : "Push…", !info.head ? "Nothing committed yet" : info.ahead === 0 ? "Everything is pushed" : "");
    // The count is as last fetched, so "nothing to pull" is never certain: only a branch the forge doesn't have is greyed out.
    const pullItem = !r
      ? ""
      : item("pull", info.behind ? `Pull ${info.behind} commit${info.behind > 1 ? "s" : ""}…` : "Pull…", info.head && info.behind == null ? `${info.branch ?? "This branch"} isn't on ${r.forge.name} yet: Push… creates it` : "");
    mountBranchMenu({
      kind: "local",
      branch: info.branch,
      count: n,
      title: `${info.root}\n${n} changed file${n === 1 ? "" : "s"}${ahead}`,
      itemsHtml: `<button type="button" data-act="branch">New branch…</button>
        ${commitItem}${pushItem}${pullItem}`,
      onAct: async (act) => {
        try {
          if (act === "branch") await newBranchDialog(info);
          if (act === "commit") await commitDialog(info);
          if (act === "push" && (await pushDialog(info)) === "pull") await pullDialog(info);
          if (act === "pull") await pullDialog(info);
        } finally {
          refresh();
        }
      },
      listBranches: async () => {
        // The forge's branches as they are now, best effort (offline: as last fetched).
        if (r) await invoke("git_fetch", { path: info.root, ...remoteArgs(r), token: await ensureFreshToken(r.forge) }).catch(() => {});
        const list = await invoke("git_branches", { path: info.root });
        return list.map((b) => ({ name: b.name, current: b.current, note: b.remote ? `on ${r?.forge.name ?? "the remote"}` : "" }));
      },
      // The files change on disk, so live reload shows the other branch
      // (and an earlier commit makes way for them).
      switchTo: async (name) => {
        await invoke("git_switch_branch", { path: info.root, name });
        toast(`Switched to ${name}`);
        if (history.viewing()) await history.show(null);
        refresh();
      },
    });
    mountHistoryMenu({
      kind: "local",
      viewing: history.viewing(),
      latest: "Working files",
      latestNote: n ? `${n} changed` : "",
      branch: info.branch,
      listCommits: async (offset, count) => (await invoke("git_log", { path: info.root, limit: offset + count })).slice(offset),
      show: history.show,
    });
  }
  refresh();
  return { refresh };
}

// ---- dialogs -------------------------------------------------------------------------------

/** A modal dialog (removed when closed); Escape stays with it. */
export function dialog(html) {
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
      <p class="muted settings-hint">${
        info.head
          ? `From the current commit on <b>${escapeHtml(info.branch ?? "HEAD")}</b>. Uncommitted changes come along.`
          : `Nothing is committed yet: the first commit starts this branch, in place of <b>${escapeHtml(info.branch ?? "main")}</b>.`
      }</p>
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

/**
 * The commit author when the copy has no git identity: the account on the
 * copy's forge, with its private e-mail (a placeholder without a forge or sign-in).
 */
async function fallbackAuthor(info) {
  const f = info.remote?.forge;
  if (!f) return { name: "KiVi user", email: "kivi@localhost" };
  return f.gitAuthor(tokenFor(f) ? await ensureFreshToken(f) : null);
}

/** Commit chosen files with a message, on this computer (Push… sends them to the forge). */
async function commitDialog(info) {
  const files = await invoke("git_status", { path: info.root });
  const icon = { added: "+", removed: "−", modified: "~", conflicted: "!" };
  return new Promise((resolve) => {
    const dlg = dialog(`<form method="dialog" class="settings git-commit">
      <h2>Commit</h2>
      <p class="muted settings-hint">On <b>${escapeHtml(info.branch ?? "HEAD")}</b>, on this computer${
        info.remote ? `: <b>Push…</b> in the branch menu sends it to ${escapeHtml(info.remote.forge.name)}.` : ` only: the folder isn't linked to ${escapeHtml(forgeNames())}.`
      }</p>
      ${
        files.length
          ? `<label class="check"><input type="checkbox" id="git-all" checked> All ${files.length} changed files</label>
             <ul class="git-files">${files
               .map((f, i) => `<li><label class="check"><input type="checkbox" data-file="${i}" checked><span class="st st-${f.status === "removed" ? "removed" : f.status === "added" ? "added" : "modified"}">${icon[f.status] ?? "~"}</span><span class="mono">${escapeHtml(f.path)}</span></label></li>`)
               .join("")}</ul>
             <label class="field-label" for="git-message">Message</label>
             <textarea id="git-message" class="input" rows="3" required placeholder="What changed, e.g. Swap R12 for a 0603"></textarea>`
          : `<p>No uncommitted changes.</p>`
      }
      <p class="git-result muted" hidden></p>
      <div class="row end gap"><button value="cancel" class="btn" formnovalidate>Close</button>${files.length ? `<button value="commit" class="btn primary">Commit</button>` : ""}</div>
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
    dlg.querySelector("form").addEventListener("submit", async (e) => {
      if (e.submitter?.value === "cancel") return;
      e.preventDefault(); // stay open to show the result
      buttons.forEach((b) => (b.disabled = true));
      try {
        const chosen = files.filter((_, i) => boxes[i].checked).map((f) => f.path);
        if (!chosen.length) throw new Error("Choose at least one file");
        const message = dlg.querySelector("#git-message").value;
        const author = await fallbackAuthor(info);
        await invoke("git_commit", { path: info.root, files: chosen, message, name: author.name, email: author.email });
        boxes.forEach((b) => (b.disabled = true));
        dlg.querySelector("button[value=commit]")?.remove();
        result.hidden = false;
        result.classList.remove("git-error");
        result.textContent = info.remote ? "Committed. Push when you're ready." : "Committed.";
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

/** Push the checked-out branch to the same branch on the forge, then offer a pull (merge) request. */
async function pushDialog(info) {
  const r = info.remote, f = r.forge, F = f.name;
  if (!tokenFor(f)) {
    window.dispatchEvent(new CustomEvent("kivi:signin", { detail: { forge: f.id } }));
    throw new Error(`Sign in to ${F} to push`);
  }
  const onMain = info.branch === "main" || info.branch === "master";
  const n = info.ahead;
  const what = n == null ? `The branch isn't on ${F} yet: pushing creates it.` : `${n} commit${n > 1 ? "s" : ""} not on ${F} yet.`;
  return new Promise((resolve) => {
    const dlg = dialog(`<form method="dialog" class="settings git-commit">
      <h2>Push</h2>
      <p class="muted settings-hint">To <b>${escapeHtml(info.branch ?? "?")}</b> on ${escapeHtml(`${f.host}/${r.nwo}`)}.</p>
      ${onMain ? `<p class="git-warn">You're on <b>${escapeHtml(info.branch)}</b>: pushing changes it for everyone, and protected branches refuse it. Create a branch first to open a ${f.words.pr} instead.</p>` : ""}
      <p>${what}${info.changes ? ` ${info.changes} uncommitted file${info.changes > 1 ? "s" : ""} stay${info.changes > 1 ? "" : "s"} on this computer: commit ${info.changes > 1 ? "them" : "it"} first to include ${info.changes > 1 ? "them" : "it"}.` : ""}</p>
      <p class="git-result muted" hidden></p>
      <div class="row end gap"><button value="cancel" class="btn" formnovalidate>Close</button><button value="push" class="btn primary">Push</button></div>
    </form>`);
    const result = dlg.querySelector(".git-result");
    const buttons = [...dlg.querySelectorAll("button")];
    dlg.querySelector("form").addEventListener("submit", async (e) => {
      if (e.submitter?.value === "cancel" || e.submitter?.value === "pull") return; // closes; Pull… opens next
      e.preventDefault(); // stay open to show the result
      buttons.forEach((b) => (b.disabled = true));
      try {
        result.hidden = false;
        result.classList.remove("git-error");
        result.textContent = `Pushing to ${F}…`;
        const token = await ensureFreshToken(f);
        const branch = await invoke("git_push", { path: info.root, ...remoteArgs(r), token });
        const compare = f.web.compare(r.nwo, branch);
        result.innerHTML = `Pushed <b>${escapeHtml(branch)}</b> to ${escapeHtml(F)}. ${onMain ? "" : `<a href="${escapeHtml(compare)}" target="_blank" rel="noopener">Open a ${f.words.pr}</a>`}`;
        dlg.querySelector("button[value=push]")?.remove();
      } catch (err) {
        const msg = String(err.message ?? err);
        result.textContent = msg;
        result.classList.add("git-error");
        // The forge has commits this copy doesn't: bring them in from here.
        if (/Pull…/.test(msg) && !dlg.querySelector("button[value=pull]")) {
          dlg.querySelector("button[value=push]").insertAdjacentHTML("beforebegin", `<button value="pull" class="btn">Pull…</button>`);
          buttons.push(dlg.querySelector("button[value=pull]"));
        }
      } finally {
        buttons.forEach((b) => (b.disabled = false));
      }
    });
    dlg.addEventListener("close", () => resolve(dlg.returnValue));
  });
}

/**
 * Bring the forge's commits on the checked-out branch into the copy, right away
 * (nothing is overwritten or lost; see git_pull in git.rs), and say what
 * happened. When both sides changed the same files, offer to move this copy's
 * commits to a new branch so the old one can match the forge's.
 */
async function pullDialog(info) {
  const branch = info.branch ?? "this branch";
  const r = info.remote, f = r.forge, F = escapeHtml(f.name);
  const dlg = dialog(`<form method="dialog" class="settings git-commit">
    <h2>Pull</h2>
    <p class="muted settings-hint">${F}'s commits on <b>${escapeHtml(branch)}</b> from ${escapeHtml(`${f.host}/${r.nwo}`)}.</p>
    <div class="git-pull-body"><progress class="git-progress"></progress><p class="muted">Bringing in ${F}'s commits…</p></div>
    <div class="row end gap"><button value="cancel" class="btn" formnovalidate>Close</button></div>
  </form>`);
  const body = dlg.querySelector(".git-pull-body");
  const files = (list) => `<ul class="git-files">${list.slice(0, 12).map((f) => `<li class="mono">${escapeHtml(f)}</li>`).join("")}${list.length > 12 ? `<li class="muted">and ${list.length - 12} more</li>` : ""}</ul>`;
  const commits = (n) => `${n} commit${n > 1 ? "s" : ""}`;
  const closed = new Promise((resolve) => dlg.addEventListener("close", resolve));
  try {
    const author = await fallbackAuthor(info);
    const res = await invoke("git_pull", { path: info.root, ...remoteArgs(r), token: await ensureFreshToken(f), name: author.name, email: author.email });
    if (res.outcome === "up_to_date") body.innerHTML = `<p class="git-result"><b>${escapeHtml(branch)}</b> is up to date with ${F}.</p>`;
    else if (res.outcome === "fast_forward") body.innerHTML = `<p class="git-result">Brought in ${commits(res.commits)} from ${F}${res.files.length ? `, changing:` : "."}</p>${res.files.length ? files(res.files) : ""}`;
    else if (res.outcome === "merged")
      body.innerHTML = `<p class="git-result">Brought in ${commits(res.commits)} from ${F}. Your commits changed other files, so both were combined in a merge commit: <b>Push…</b> sends it to ${F}.</p>${files(res.files)}`;
    else {
      // Diverged on the same files: nothing was changed.
      body.innerHTML = `<p class="git-warn">${F} (${commits(res.commits)}) and this copy both changed:</p>${files(res.files)}
        <p class="git-result">KiCad files can't be merged safely, so nothing was changed. Move your commits to a new branch: push it and open a ${f.words.pr}, and <b>${escapeHtml(branch)}</b> then matches ${F}. Uncommitted edits come along.</p>
        <label class="field-label" for="git-move-name">New branch for your commits</label>
        <input id="git-move-name" class="input mono" spellcheck="false" value="${escapeHtml(`${branch}-mine`)}">
        <p class="git-result git-move-result" hidden></p>`;
      dlg.querySelector("button[value=cancel]").insertAdjacentHTML("afterend", `<button value="move" class="btn primary">Move my commits</button>`);
      dlg.querySelector("form").addEventListener("submit", async (e) => {
        if (e.submitter?.value !== "move") return;
        e.preventDefault();
        const out = dlg.querySelector(".git-move-result");
        out.hidden = false;
        try {
          const name = await invoke("git_move_commits", { path: info.root, name: dlg.querySelector("#git-move-name").value });
          out.classList.remove("git-error");
          out.innerHTML = `Your work is on <b>${escapeHtml(name)}</b> (checked out) and <b>${escapeHtml(branch)}</b> matches ${F}. <b>Push…</b> sends <b>${escapeHtml(name)}</b> to ${F} for a ${f.words.pr}.`;
          dlg.querySelector("button[value=move]").remove();
          dlg.querySelector("#git-move-name").disabled = true;
        } catch (err) {
          out.textContent = String(err.message ?? err);
          out.classList.add("git-error");
        }
      });
    }
  } catch (err) {
    body.innerHTML = `<p class="git-result git-error">${escapeHtml(String(err.message ?? err))}</p>`;
  }
  return closed;
}
