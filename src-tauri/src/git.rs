//! Local git copies of GitHub projects: clone, link check, status, new branch,
//! local changes for the visual diff, commit and push. libgit2 is built in
//! (git2, "vendored-libgit2"), so no Git installation is needed; HTTPS goes
//! through git_http.rs. GitHub is always reached at
//! https://github.com/<owner>/<repo>.git with the sign-in token, whatever URL
//! the clone's own remote has (an ssh:// remote of an existing clone included).
//!
//! Every command runs on a blocking thread: network and disk work would
//! otherwise stall the window.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use git2::{
    build::{CheckoutBuilder, RepoBuilder}, BranchType, Delta, DiffFindOptions, DiffOptions, Direction, FetchOptions, ObjectType, Oid, PushOptions, RemoteCallbacks,
    Repository, Signature, Status, StatusOptions, TreeWalkMode, TreeWalkResult,
};
use serde::Serialize;
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter};

use crate::git_http;

/// Run `f` on a blocking thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn https_url(owner: &str, repo: &str) -> String {
    format!("https://github.com/{owner}/{repo}.git")
}

/// The URL libgit2 talks to: the token rides in the user part, which
/// git_http.rs turns into an Authorization header.
fn auth_url(owner: &str, repo: &str, token: &Option<String>) -> String {
    match token.as_deref().filter(|t| !t.is_empty()) {
        Some(t) => format!("https://x-access-token:{t}@github.com/{owner}/{repo}.git"),
        None => https_url(owner, repo),
    }
}

/// An error message without the token, should libgit2 quote the URL.
fn clean(e: impl std::fmt::Display, token: &Option<String>) -> String {
    let msg = e.to_string();
    match token.as_deref().filter(|t| !t.is_empty()) {
        Some(t) => msg.replace(t, "***"),
        None => msg,
    }
}

/// owner and repository of a GitHub remote URL (https or ssh form).
pub(crate) fn github_nwo(url: &str) -> Option<(String, String)> {
    let rest = ["https://", "http://", "ssh://git@", "git@"]
        .iter()
        .find_map(|p| url.strip_prefix(p))?;
    let rest = rest.rsplit_once('@').map_or(rest, |(_, host)| host); // https://user@github.com/…
    let rest = rest.strip_prefix("github.com/").or_else(|| rest.strip_prefix("github.com:"))?;
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let (owner, repo) = rest.split_once('/')?;
    (!owner.is_empty() && !repo.is_empty() && !repo.contains('/')).then(|| (owner.to_string(), repo.to_string()))
}

fn open(path: &str) -> Result<Repository, String> {
    Repository::discover(path).map_err(|e| format!("{path}: not a git repository ({})", e.message()))
}

fn workdir(repo: &Repository) -> Result<PathBuf, String> {
    repo.workdir().map(Path::to_path_buf).ok_or_else(|| "a bare repository has no files to show".to_string())
}

/// Name of the remote pointing at github.com/<owner>/<repo>, if any (any URL form).
fn remote_for(repo: &Repository, owner: &str, name: &str) -> Option<String> {
    let remotes = repo.remotes().ok()?;
    let found = remotes.iter().flatten().find(|r| {
        repo.find_remote(r)
            .ok()
            .and_then(|rem| rem.url().and_then(github_nwo))
            .is_some_and(|(o, n)| o.eq_ignore_ascii_case(owner) && n.eq_ignore_ascii_case(name))
    });
    found.map(str::to_string)
}

/// The first remote that points at GitHub, with its owner/repo.
fn github_remote(repo: &Repository) -> Option<(String, String, String)> {
    let remotes = repo.remotes().ok()?;
    let names: Vec<String> = remotes.iter().flatten().map(str::to_string).collect();
    // origin first, as git itself would.
    let mut ordered: Vec<&String> = names.iter().filter(|n| *n == "origin").collect();
    ordered.extend(names.iter().filter(|n| *n != "origin"));
    ordered.into_iter().find_map(|r| {
        let (o, n) = repo.find_remote(r).ok()?.url().and_then(github_nwo)?;
        Some((r.clone(), o, n))
    })
}

fn current_branch(repo: &Repository) -> Option<String> {
    match repo.head() {
        Ok(head) => head.is_branch().then(|| head.shorthand().map(str::to_string)).flatten(),
        // Before the first commit HEAD names a branch that doesn't exist yet (main for a new repository).
        Err(_) => repo.find_reference("HEAD").ok()?.symbolic_target()?.strip_prefix("refs/heads/").map(str::to_string),
    }
}

// ---- information --------------------------------------------------------------

#[derive(Serialize)]
pub struct RepoInfo {
    /// The working copy's top folder.
    root: String,
    owner: Option<String>,
    repo: Option<String>,
    /// The remote pointing at GitHub ("origin" for clones made by KiVi).
    remote: Option<String>,
    /// Checked-out branch (before the first commit, the one it will start); None when detached.
    branch: Option<String>,
    head: Option<String>,
    /// Changed, added and deleted files, untracked ones included.
    changes: usize,
    /// Commits on the branch that GitHub doesn't have yet; None if never pushed.
    ahead: Option<usize>,
}

fn info(repo: &Repository) -> Result<RepoInfo, String> {
    let root = workdir(repo)?;
    let gh = github_remote(repo);
    let branch = current_branch(repo);
    let head = repo.head().ok().and_then(|h| h.target());
    // Against the branch's upstream (set by a push), else the same branch on the remote.
    let remote = gh.as_ref().map_or("origin", |g| g.0.as_str());
    let pushed = branch.as_deref().and_then(|b| {
        let upstream = repo.find_branch(b, BranchType::Local).ok()?.upstream().ok().and_then(|u| u.get().target());
        upstream.or_else(|| repo.refname_to_id(&format!("refs/remotes/{remote}/{b}")).ok())
    });
    let ahead = head.zip(pushed).and_then(|(local, up)| repo.graph_ahead_behind(local, up).ok()).map(|(a, _)| a);
    Ok(RepoInfo {
        root: root.to_string_lossy().into_owned(),
        owner: gh.as_ref().map(|g| g.1.clone()),
        repo: gh.as_ref().map(|g| g.2.clone()),
        remote: gh.map(|g| g.0),
        branch,
        head: head.map(|h| h.to_string()),
        changes: status(repo)?.len(),
        ahead,
    })
}

/// What KiVi knows about the git copy containing `path` (an error if it isn't one).
#[tauri::command]
pub async fn git_info(path: String) -> Result<RepoInfo, String> {
    blocking(move || info(&open(&path)?)).await
}

#[derive(Serialize, Debug, PartialEq)]
pub struct FileChange {
    path: String,
    /// The path in the base version (differs for renames).
    previous: String,
    /// added | modified | removed | renamed | conflicted
    status: String,
}

fn status(repo: &Repository) -> Result<Vec<FileChange>, String> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true).exclude_submodules(true);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.message().to_string())?;
    let mut out: Vec<FileChange> = statuses
        .iter()
        .filter_map(|e| {
            let s = e.status();
            let path = e.path()?.to_string();
            let kind = if s.is_conflicted() {
                "conflicted"
            } else if s.intersects(Status::WT_NEW | Status::INDEX_NEW) {
                "added"
            } else if s.intersects(Status::WT_DELETED | Status::INDEX_DELETED) {
                "removed"
            } else if s.intersects(Status::WT_MODIFIED | Status::INDEX_MODIFIED | Status::WT_TYPECHANGE | Status::INDEX_TYPECHANGE | Status::WT_RENAMED | Status::INDEX_RENAMED) {
                "modified"
            } else {
                return None; // ignored, unchanged
            };
            Some(FileChange { previous: path.clone(), path, status: kind.to_string() })
        })
        .collect();
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Uncommitted changes against the last commit (for the commit dialog).
#[tauri::command]
pub async fn git_status(path: String) -> Result<Vec<FileChange>, String> {
    blocking(move || status(&open(&path)?)).await
}

// ---- clone ----------------------------------------------------------------------

#[derive(Serialize, Clone)]
struct CloneProgress {
    received: usize,
    total: usize,
    bytes: usize,
}

fn clone_from(url: &str, dest: &Path, mut progress: impl FnMut(CloneProgress)) -> Result<Repository, git2::Error> {
    let mut cb = RemoteCallbacks::new();
    let mut last = Instant::now() - Duration::from_secs(1);
    cb.transfer_progress(move |p| {
        if last.elapsed() >= Duration::from_millis(200) || p.received_objects() == p.total_objects() {
            last = Instant::now();
            progress(CloneProgress { received: p.received_objects(), total: p.total_objects(), bytes: p.received_bytes() });
        }
        true
    });
    let mut fo = FetchOptions::new();
    fo.remote_callbacks(cb);
    RepoBuilder::new().fetch_options(fo).clone(url, dest)
}

/// Clone github.com/<owner>/<repo> into `<parent>/<repo>`, reporting "git-progress"
/// events; returns the new folder.
#[tauri::command]
pub async fn git_clone(owner: String, repo: String, parent: String, token: Option<String>, app: AppHandle) -> Result<String, String> {
    blocking(move || {
        git_http::register();
        let dest = Path::new(&parent).join(&repo);
        if dest.exists() && std::fs::read_dir(&dest).map(|mut d| d.next().is_some()).unwrap_or(true) {
            return Err(format!("{} already exists and isn't empty: choose another folder, or link that copy instead", dest.display()));
        }
        let made = !dest.exists();
        let result = clone_from(&auth_url(&owner, &repo, &token), &dest, |p| {
            let _ = app.emit("git-progress", p);
        });
        match result {
            Ok(r) => {
                // The token was only for the download; the saved remote is the plain URL.
                r.remote_set_url("origin", &https_url(&owner, &repo)).map_err(|e| e.message().to_string())?;
                Ok(dest.to_string_lossy().into_owned())
            }
            Err(e) => {
                if made {
                    let _ = std::fs::remove_dir_all(&dest); // don't leave half a clone behind
                }
                Err(clean(e.message(), &token))
            }
        }
    })
    .await
}

// ---- branches -----------------------------------------------------------------

fn create_branch(repo: &Repository, name: &str) -> Result<String, String> {
    if !git2::Branch::name_is_valid(name).unwrap_or(false) {
        return Err(format!("\"{name}\" isn't a valid branch name"));
    }
    if repo.find_branch(name, BranchType::Local).is_ok() {
        return Err(format!("a branch \"{name}\" already exists"));
    }
    let Ok(head) = repo.head().and_then(|h| h.peel_to_commit()) else {
        // Nothing committed yet: the first commit starts the new branch instead.
        repo.set_head(&format!("refs/heads/{name}")).map_err(|e| e.message().to_string())?;
        return Ok(name.to_string());
    };
    repo.branch(name, &head, false).map_err(|e| e.message().to_string())?;
    // Same commit, so the files stay as they are, uncommitted edits included.
    repo.set_head(&format!("refs/heads/{name}")).map_err(|e| e.message().to_string())?;
    Ok(name.to_string())
}

/// Create a branch at the current commit and switch to it (uncommitted edits move along).
#[tauri::command]
pub async fn git_create_branch(path: String, name: String) -> Result<String, String> {
    blocking(move || create_branch(&open(&path)?, name.trim())).await
}

#[derive(Serialize, Debug, PartialEq)]
pub struct BranchInfo {
    name: String,
    current: bool,
    /// Only on GitHub so far (a remote-tracking branch without a local one).
    remote: bool,
}

fn branches(repo: &Repository) -> Result<Vec<BranchInfo>, String> {
    let current = current_branch(repo);
    let mut out: Vec<BranchInfo> = Vec::new();
    for b in repo.branches(Some(BranchType::Local)).map_err(|e| e.message().to_string())?.flatten() {
        if let Ok(Some(name)) = b.0.name() {
            out.push(BranchInfo { current: current.as_deref() == Some(name), name: name.to_string(), remote: false });
        }
    }
    if let Some(name) = current.as_deref().filter(|n| !out.iter().any(|x| x.name == *n)) {
        out.push(BranchInfo { name: name.to_string(), current: true, remote: false }); // no commit on it yet
    }
    let remote = github_remote(repo).map(|g| g.0).unwrap_or_else(|| "origin".into());
    let prefix = format!("{remote}/");
    for b in repo.branches(Some(BranchType::Remote)).map_err(|e| e.message().to_string())?.flatten() {
        if let Ok(Some(full)) = b.0.name() {
            if let Some(name) = full.strip_prefix(&prefix) {
                if name != "HEAD" && !out.iter().any(|x| x.name == name) {
                    out.push(BranchInfo { name: name.to_string(), current: false, remote: true });
                }
            }
        }
    }
    out.sort_by(|a, b| b.current.cmp(&a.current).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

/// Local branches, then the GitHub ones the copy doesn't have yet (as last fetched).
#[tauri::command]
pub async fn git_branches(path: String) -> Result<Vec<BranchInfo>, String> {
    blocking(move || branches(&open(&path)?)).await
}

fn switch_branch(repo: &Repository, name: &str) -> Result<String, String> {
    if current_branch(repo).as_deref() == Some(name) {
        return Ok(name.to_string());
    }
    let remote = github_remote(repo).map(|g| g.0).unwrap_or_else(|| "origin".into());
    let local = repo.find_branch(name, BranchType::Local).ok();
    let target = match &local {
        Some(b) => b.get().peel_to_commit(),
        None => repo
            .find_branch(&format!("{remote}/{name}"), BranchType::Remote)
            .map_err(|_| format!("there's no branch \"{name}\""))?
            .get()
            .peel_to_commit(),
    }
    .map_err(|e| e.message().to_string())?;
    // Like `git switch`: uncommitted edits come along, unless the other branch
    // changes the same files, then nothing happens. Checked out before any
    // branch is created, so a refused switch leaves no trace.
    let tree = target.tree().map_err(|e| e.message().to_string())?;
    let mut co = CheckoutBuilder::new();
    co.safe();
    repo.checkout_tree(tree.as_object(), Some(&mut co)).map_err(|e| {
        if e.code() == git2::ErrorCode::Conflict {
            format!("uncommitted changes would be overwritten by \"{name}\": commit them first (Commit and push…), or switch with git")
        } else {
            e.message().to_string()
        }
    })?;
    if local.is_none() {
        let mut b = repo.branch(name, &target, false).map_err(|e| e.message().to_string())?;
        let _ = b.set_upstream(Some(&format!("{remote}/{name}")));
    }
    repo.set_head(&format!("refs/heads/{name}")).map_err(|e| e.message().to_string())?;
    Ok(name.to_string())
}

/// Switch the copy to another branch (creating a local one for a GitHub-only branch).
#[tauri::command]
pub async fn git_switch_branch(path: String, name: String) -> Result<String, String> {
    blocking(move || switch_branch(&open(&path)?, name.trim())).await
}

// ---- local changes for the visual diff ---------------------------------------

#[derive(Serialize)]
pub struct LocalChanges {
    root: String,
    branch: Option<String>,
    /// What the changes are compared with, e.g. "origin/main".
    base_ref: String,
    /// The commit where the branch left it (the merge base).
    base_sha: String,
    files: Vec<FileChange>,
}

/// The main branch to compare with: `base` if given, else the remote's default
/// (origin/HEAD), else main or master, on the remote or locally.
/// What to compare the working files with: a branch's tip (then from the merge
/// base, like a pull request: the bool is true), or a commit itself (a SHA or
/// any revision git understands, compared with directly). Without `base`: main.
fn base_tip(repo: &Repository, base: Option<&str>) -> Result<(String, Oid, bool), String> {
    let remote = github_remote(repo).map(|g| g.0).unwrap_or_else(|| "origin".into());
    let mut candidates = Vec::new();
    if let Some(b) = base.filter(|b| !b.is_empty()) {
        candidates.push(format!("refs/remotes/{remote}/{b}"));
        candidates.push(format!("refs/heads/{b}"));
        let branch = candidates.iter().any(|r| repo.refname_to_id(r).is_ok());
        if !branch {
            let commit = repo.revparse_single(b).and_then(|o| o.peel_to_commit()).map_err(|_| format!("{b}: no such branch or commit"))?;
            let id = commit.id();
            return Ok((id.to_string()[..7].to_string(), id, false));
        }
    }
    if let Some(t) = repo.find_reference(&format!("refs/remotes/{remote}/HEAD")).ok().and_then(|r| r.symbolic_target().map(str::to_string)) {
        candidates.push(t);
    }
    for b in ["main", "master"] {
        candidates.push(format!("refs/remotes/{remote}/{b}"));
        candidates.push(format!("refs/heads/{b}"));
    }
    candidates
        .iter()
        .find_map(|r| repo.refname_to_id(r).ok().map(|id| (r.trim_start_matches("refs/remotes/").trim_start_matches("refs/heads/").to_string(), id, true)))
        .ok_or_else(|| "no main branch to compare with".to_string())
}

fn local_changes(repo: &Repository, base: Option<&str>) -> Result<LocalChanges, String> {
    let root = workdir(repo)?;
    let (base_ref, tip, from_merge_base) = base_tip(repo, base)?;
    let head = repo.head().ok().and_then(|h| h.target());
    let base_sha = if from_merge_base { head.and_then(|h| repo.merge_base(h, tip).ok()).unwrap_or(tip) } else { tip };
    let tree = repo.find_commit(base_sha).and_then(|c| c.tree()).map_err(|e| e.message().to_string())?;
    let mut opts = DiffOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true).show_untracked_content(true);
    let mut diff = repo.diff_tree_to_workdir_with_index(Some(&tree), Some(&mut opts)).map_err(|e| e.message().to_string())?;
    let mut find = DiffFindOptions::new();
    find.renames(true).for_untracked(true);
    diff.find_similar(Some(&mut find)).map_err(|e| e.message().to_string())?;
    let path_of = |f: git2::DiffFile| f.path().map(|p| p.to_string_lossy().replace('\\', "/"));
    let mut files: Vec<FileChange> = diff
        .deltas()
        .filter_map(|d| {
            let status = match d.status() {
                Delta::Added | Delta::Untracked | Delta::Copied => "added",
                Delta::Deleted => "removed",
                Delta::Modified | Delta::Typechange => "modified",
                Delta::Renamed => "renamed",
                Delta::Conflicted => "conflicted",
                _ => return None,
            };
            let new = path_of(d.new_file());
            let old = path_of(d.old_file());
            let path = if status == "removed" { old.clone()? } else { new.clone()? };
            Some(FileChange { previous: old.unwrap_or_else(|| path.clone()), path, status: status.to_string() })
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(LocalChanges { root: root.to_string_lossy().into_owned(), branch: current_branch(repo), base_ref, base_sha: base_sha.to_string(), files })
}

/// The working copy (uncommitted edits and the branch's commits) against the
/// point where the branch left main (or `base`, a branch), what a pull request
/// would show; or against `base` itself when it's a commit.
#[tauri::command]
pub async fn git_local_changes(path: String, base: Option<String>) -> Result<LocalChanges, String> {
    blocking(move || local_changes(&open(&path)?, base.as_deref())).await
}

/// A file in the working copy (`rev` empty) or at a commit; only inside the copy.
fn read(repo: &Repository, rev: &str, file: &str) -> Result<Vec<u8>, String> {
    if rev.is_empty() {
        let root = std::fs::canonicalize(workdir(repo)?).map_err(|e| e.to_string())?;
        let full = std::fs::canonicalize(root.join(file)).map_err(|e| format!("{file}: {e}"))?;
        if !full.starts_with(&root) || full.starts_with(root.join(".git")) {
            return Err(format!("{file}: outside the working copy"));
        }
        return std::fs::read(&full).map_err(|e| format!("{file}: {e}"));
    }
    let tree = repo.revparse_single(rev).and_then(|o| o.peel_to_tree()).map_err(|e| format!("{rev}: {}", e.message()))?;
    let entry = tree.get_path(Path::new(file)).map_err(|_| format!("{file}: not in {rev}"))?;
    let blob = entry.to_object(repo).and_then(|o| o.peel_to_blob()).map_err(|e| e.message().to_string())?;
    Ok(blob.content().to_vec())
}

#[tauri::command]
pub async fn git_read(path: String, rev: String, file: String) -> Result<Response, String> {
    blocking(move || read(&open(&path)?, &rev, &file).map(Response::new)).await
}

fn list(repo: &Repository, rev: &str) -> Result<Vec<String>, String> {
    if rev.is_empty() {
        return Ok(crate::list(&workdir(repo)?));
    }
    let tree = repo.revparse_single(rev).and_then(|o| o.peel_to_tree()).map_err(|e| format!("{rev}: {}", e.message()))?;
    let mut out = Vec::new();
    tree.walk(TreeWalkMode::PreOrder, |dir, entry| {
        if entry.kind() == Some(ObjectType::Blob) {
            if let Some(name) = entry.name() {
                out.push(format!("{dir}{name}"));
            }
        }
        TreeWalkResult::Ok
    })
    .map_err(|e| e.message().to_string())?;
    Ok(out)
}

/// Files of the working copy (`rev` empty) or of a commit.
#[tauri::command]
pub async fn git_list(path: String, rev: String) -> Result<Vec<String>, String> {
    blocking(move || list(&open(&path)?, &rev)).await
}

// ---- sync state for the project gallery -------------------------------------------

#[derive(Serialize, Debug)]
pub struct RemoteState {
    branch: Option<String>,
    /// Uncommitted changes (files).
    changes: usize,
    /// How the checked-out branch relates to the same branch on GitHub:
    /// same | ahead (commits to push) | behind (GitHub is newer) | diverged |
    /// unpushed (not on GitHub) | unknown (GitHub not reachable; see `error`).
    relation: String,
    /// Why GitHub couldn't be asked (offline, not signed in…).
    error: Option<String>,
}

/// The branch tips on the remote, like `git ls-remote` (no download).
fn remote_heads(repo: &Repository, url: &str) -> Result<Vec<(String, Oid)>, git2::Error> {
    let mut anon = repo.remote_anonymous(url)?;
    anon.connect(Direction::Fetch)?;
    let heads = anon.list()?.iter().map(|h| (h.name().to_string(), h.oid())).collect();
    anon.disconnect()?;
    Ok(heads)
}

fn remote_state(repo: &Repository, url: &str, remote: &str) -> Result<RemoteState, String> {
    let branch = current_branch(repo);
    let changes = status(repo)?.len();
    let head = repo.head().ok().and_then(|h| h.target());
    let (theirs, error) = match (&branch, remote_heads(repo, url)) {
        (Some(b), Ok(heads)) => (Some(heads.into_iter().find(|(n, _)| *n == format!("refs/heads/{b}")).map(|(_, id)| id)), None),
        (_, Err(e)) => {
            // Offline: what the copy last saw of GitHub (its remote-tracking branch).
            let seen = branch.as_ref().and_then(|b| repo.refname_to_id(&format!("refs/remotes/{remote}/{b}")).ok());
            (seen.map(Some), Some(e.message().to_string()))
        }
        (None, Ok(_)) => (None, None),
    };
    let relation = match (head, theirs) {
        (_, None) => "unknown",
        (_, Some(None)) => "unpushed",
        (Some(ours), Some(Some(t))) if ours == t => "same",
        (Some(ours), Some(Some(t))) => {
            if repo.find_commit(t).is_err() {
                "behind" // GitHub has commits this copy hasn't even fetched
            } else if repo.graph_descendant_of(ours, t).unwrap_or(false) {
                "ahead"
            } else if repo.graph_descendant_of(t, ours).unwrap_or(false) {
                "behind"
            } else {
                "diverged"
            }
        }
        (None, Some(Some(_))) => "behind",
    };
    Ok(RemoteState { branch, changes, relation: relation.to_string(), error })
}

/// Whether the copy matches its branch on GitHub (the gallery's sync icon).
#[tauri::command]
pub async fn git_remote_state(path: String, owner: String, repo: String, token: Option<String>) -> Result<RemoteState, String> {
    blocking(move || {
        git_http::register();
        let r = open(&path)?;
        let remote = remote_for(&r, &owner, &repo).unwrap_or_else(|| "origin".into());
        let mut state = remote_state(&r, &auth_url(&owner, &repo, &token), &remote)?;
        state.error = state.error.map(|e| clean(e, &token));
        Ok(state)
    })
    .await
}

// ---- fetch, commit, push ------------------------------------------------------

fn fetch_from(repo: &Repository, url: &str, remote: &str) -> Result<(), git2::Error> {
    let mut anon = repo.remote_anonymous(url)?;
    anon.fetch(&[format!("+refs/heads/*:refs/remotes/{remote}/*")], None, None)
}

/// Update the remote branches from GitHub (so "main" in the visual diff is current).
#[tauri::command]
pub async fn git_fetch(path: String, owner: String, repo: String, token: Option<String>) -> Result<(), String> {
    blocking(move || {
        git_http::register();
        let r = open(&path)?;
        let remote = remote_for(&r, &owner, &repo).unwrap_or_else(|| "origin".into());
        fetch_from(&r, &auth_url(&owner, &repo, &token), &remote).map_err(|e| clean(e.message(), &token))
    })
    .await
}

fn commit(repo: &Repository, files: &[String], message: &str, fallback: (&str, &str)) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("a commit needs a message".into());
    }
    if files.is_empty() {
        return Err("no files chosen".into());
    }
    let root = workdir(repo)?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    for f in files {
        let rel = Path::new(f);
        let res = if root.join(rel).exists() { index.add_path(rel) } else { index.remove_path(rel) };
        res.map_err(|e| format!("{f}: {}", e.message()))?;
    }
    index.write().map_err(|e| e.message().to_string())?;
    let tree = repo.find_tree(index.write_tree().map_err(|e| e.message().to_string())?).map_err(|e| e.message().to_string())?;
    // The user's own git identity when they have one, else their GitHub account.
    let sig = repo.signature().or_else(|_| Signature::now(fallback.0, fallback.1)).map_err(|e| e.message().to_string())?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let id = repo.commit(Some("HEAD"), &sig, &sig, message.trim(), &tree, &parents).map_err(|e| e.message().to_string())?;
    Ok(id.to_string())
}

/// Commit the chosen files (paths relative to the copy; deleted ones are removed).
/// `name`/`email` are used when the copy has no git identity configured.
#[tauri::command]
pub async fn git_commit(path: String, files: Vec<String>, message: String, name: String, email: String) -> Result<String, String> {
    blocking(move || commit(&open(&path)?, &files, &message, (&name, &email))).await
}

fn push_to(repo: &Repository, url: &str, remote: &str) -> Result<String, String> {
    let branch = current_branch(repo).ok_or("not on a branch: create one first")?;
    let head = repo.head().ok().and_then(|h| h.target()).ok_or("nothing committed yet")?;
    let rejected_msg = |why: &str| {
        format!("GitHub rejected the push ({why}): the branch there has commits this copy doesn't, or is protected; push to a new branch instead")
    };
    let mut rejected: Option<String> = None;
    {
        let mut cb = RemoteCallbacks::new();
        cb.push_update_reference(|_, status| {
            if let Some(why) = status {
                rejected = Some(why.to_string());
            }
            Ok(())
        });
        let mut opts = PushOptions::new();
        opts.remote_callbacks(cb);
        let mut anon = repo.remote_anonymous(url).map_err(|e| e.message().to_string())?;
        // libgit2 refuses a non-fast-forward itself, before asking the server.
        anon.push(&[format!("refs/heads/{branch}:refs/heads/{branch}")], Some(&mut opts)).map_err(|e| {
            if e.code() == git2::ErrorCode::NotFastForward {
                rejected_msg("not a fast-forward")
            } else {
                e.message().to_string()
            }
        })?;
    }
    if let Some(why) = rejected {
        return Err(rejected_msg(&why));
    }
    // What a named remote would have recorded: the remote branch, and the upstream.
    repo.reference(&format!("refs/remotes/{remote}/{branch}"), head, true, "push").map_err(|e| e.message().to_string())?;
    if repo.find_remote(remote).is_ok() {
        if let Ok(mut b) = repo.find_branch(&branch, BranchType::Local) {
            let _ = b.set_upstream(Some(&format!("{remote}/{branch}")));
        }
    }
    Ok(branch)
}

/// Push the current branch to the same branch on GitHub; returns its name.
#[tauri::command]
pub async fn git_push(path: String, owner: String, repo: String, token: Option<String>) -> Result<String, String> {
    blocking(move || {
        git_http::register();
        let r = open(&path)?;
        let remote = remote_for(&r, &owner, &repo).unwrap_or_else(|| "origin".into());
        push_to(&r, &auth_url(&owner, &repo, &token), &remote).map_err(|e| clean(e, &token))
    })
    .await
}

#[derive(Serialize, Debug)]
pub struct CommitInfo {
    sha: String,
    summary: String,
    author: String,
    /// Seconds since 1970.
    time: i64,
}

fn log(repo: &Repository, limit: usize) -> Result<Vec<CommitInfo>, String> {
    let Some(head) = repo.head().ok().and_then(|h| h.target()) else { return Ok(Vec::new()) }; // nothing committed yet
    let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
    walk.push(head).map_err(|e| e.message().to_string())?;
    walk.set_sorting(git2::Sort::TIME).map_err(|e| e.message().to_string())?;
    Ok(walk
        .flatten()
        .take(limit)
        .filter_map(|id| repo.find_commit(id).ok())
        .map(|c| CommitInfo {
            sha: c.id().to_string(),
            summary: c.summary().unwrap_or("").to_string(),
            author: c.author().name().unwrap_or("").to_string(),
            time: c.time().seconds(),
        })
        .collect())
}

/// The latest commits on the checked-out branch, newest first (the visual diff's "Compare with").
#[tauri::command]
pub async fn git_log(path: String, limit: usize) -> Result<Vec<CommitInfo>, String> {
    blocking(move || log(&open(&path)?, limit)).await
}

// ---- linking a local project to GitHub -------------------------------------------

/// The git repository holding `path`, or a new one there (on main) if there is none.
/// A new one gets a .gitignore leaving out KiCad's working files (IGNORED).
fn open_or_init(path: &Path) -> Result<Repository, String> {
    Repository::discover(path).or_else(|_| {
        let mut opts = git2::RepositoryInitOptions::new();
        opts.initial_head("main");
        let repo = Repository::init_opts(path, &opts).map_err(|e| e.message().to_string())?;
        ignore_kicad_files(path).map_err(|e| format!(".gitignore: {e}"))?;
        Ok(repo)
    })
}

/// What KiCad writes next to a project that doesn't belong in git (as in GitHub's
/// KiCad template). Not `*.kicad_prl`: per-user view state that some commit on purpose.
const IGNORED: &[&str] = &[
    ".history/",              // local history
    "~*.lck",                 // locks of the files open in KiCad
    "*-backups/",             // automatic backups
    "_autosave-*",            // autosaves
    "\\#auto_saved_files\\#", // the list of autosaves
    "fp-info-cache",          // footprint library cache
    "*.bak",                  // older backups
    "*.kicad_pcb-bak",
    "*.kicad_sch-bak",
];

/// Add IGNORED to the folder's .gitignore: made if missing, else only the lines it lacks are added.
fn ignore_kicad_files(folder: &Path) -> std::io::Result<()> {
    let file = folder.join(".gitignore");
    let text = std::fs::read_to_string(&file).unwrap_or_default();
    let missing: Vec<&str> = IGNORED.iter().copied().filter(|p| !text.lines().any(|l| l.trim() == *p)).collect();
    if missing.is_empty() {
        return Ok(());
    }
    let sep = if text.is_empty() || text.ends_with('\n') { "" } else { "\n" };
    std::fs::write(&file, format!("{text}{sep}# KiCad's working files\n{}\n", missing.join("\n")))
}

/// Make a local project folder a git repository unless it's already in one; returns git_info.
#[tauri::command]
pub async fn git_init(path: String) -> Result<RepoInfo, String> {
    blocking(move || info(&open_or_init(Path::new(&path))?)).await
}

/// Point the folder's git repository at github.com/<owner>/<repo>, making the
/// folder a repository first (on main) if it isn't in one. The remote is
/// "origin", or "github" when origin already points elsewhere. Nothing is
/// fetched or pushed: the first push happens from the branch menu.
fn link_github(path: &Path, owner: &str, name: &str) -> Result<Repository, String> {
    let repo = open_or_init(path)?;
    if remote_for(&repo, owner, name).is_some() {
        return Ok(repo); // already linked there
    }
    if let Some((_, o, n)) = github_remote(&repo) {
        return Err(format!("already linked to {o}/{n} on GitHub"));
    }
    let remote = if repo.find_remote("origin").is_ok() { "github" } else { "origin" };
    repo.remote(remote, &https_url(owner, name)).map_err(|e| e.message().to_string())?;
    Ok(repo)
}

/// Link a local project folder to a GitHub repository (see link_github); returns git_info.
#[tauri::command]
pub async fn git_link_github(path: String, owner: String, repo: String) -> Result<RepoInfo, String> {
    blocking(move || info(&link_github(Path::new(&path), &owner, &repo)?)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_urls_in_any_form() {
        let want = Some(("XyleMora".to_string(), "KiVi".to_string()));
        for url in [
            "https://github.com/XyleMora/KiVi.git",
            "https://github.com/XyleMora/KiVi",
            "https://user@github.com/XyleMora/KiVi.git",
            "git@github.com:XyleMora/KiVi.git",
            "ssh://git@github.com/XyleMora/KiVi.git",
        ] {
            assert_eq!(github_nwo(url), want, "{url}");
        }
        assert_eq!(github_nwo("https://gitlab.com/XyleMora/KiVi.git"), None);
        assert_eq!(github_nwo("https://github.com/XyleMora"), None);
    }

    fn write(dir: &Path, file: &str, text: &str) {
        let p = dir.join(file);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    /// A "GitHub" bare repository with main holding two files, cloned into `work`.
    fn fixture(name: &str) -> (PathBuf, PathBuf, Repository) {
        let base = std::env::temp_dir().join(format!("kivi-git-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let bare = base.join("hub.git");
        Repository::init_bare(&bare).unwrap();
        let seed = base.join("seed");
        let r = Repository::init(&seed).unwrap();
        write(&seed, "board/board.kicad_pcb", "(kicad_pcb v1)");
        write(&seed, "board/board.kicad_sch", "(kicad_sch v1)");
        commit(&r, &["board/board.kicad_pcb".into(), "board/board.kicad_sch".into()], "first", ("Test", "test@example.com")).unwrap();
        // Name the branch main whatever init.defaultBranch says, and publish it.
        let head = r.head().unwrap().target().unwrap();
        r.reference("refs/heads/main", head, true, "main").unwrap();
        r.set_head("refs/heads/main").unwrap();
        r.remote("origin", bare.to_str().unwrap()).unwrap();
        r.find_remote("origin").unwrap().push(&["refs/heads/main:refs/heads/main"], None).unwrap();
        Repository::open_bare(&bare).unwrap().set_head("refs/heads/main").unwrap();
        let work = base.join("work");
        let clone = clone_from(bare.to_str().unwrap(), &work, |_| {}).unwrap();
        (base, bare, clone)
    }

    #[test]
    fn branch_change_diff_commit_push() {
        let (base, bare, repo) = fixture("flow");
        let url = bare.to_str().unwrap().to_string();
        let work = workdir(&repo).unwrap();
        assert_eq!(current_branch(&repo).as_deref(), Some("main"));
        assert!(status(&repo).unwrap().is_empty());

        // New branch keeps the files; then edit one, add one, delete one.
        create_branch(&repo, "feature/led").unwrap();
        assert!(create_branch(&repo, "feature/led").is_err());
        assert!(create_branch(&repo, "bad name").is_err());
        assert_eq!(current_branch(&repo).as_deref(), Some("feature/led"));
        write(&work, "board/board.kicad_sch", "(kicad_sch v2)");
        write(&work, "board/extra.kicad_sch", "(kicad_sch extra)");
        std::fs::remove_file(work.join("board/board.kicad_pcb")).unwrap();
        let st: Vec<(String, String)> = status(&repo).unwrap().into_iter().map(|c| (c.path, c.status)).collect();
        assert_eq!(
            st,
            vec![
                ("board/board.kicad_pcb".into(), "removed".into()),
                ("board/board.kicad_sch".into(), "modified".into()),
                ("board/extra.kicad_sch".into(), "added".into()),
            ]
        );

        // The visual diff compares with where the branch left main.
        let lc = local_changes(&repo, Some("main")).unwrap();
        assert_eq!(lc.base_ref, "origin/main");
        assert_eq!(lc.files.len(), 3);
        assert_eq!(read(&repo, &lc.base_sha, "board/board.kicad_sch").unwrap(), b"(kicad_sch v1)");
        assert_eq!(read(&repo, "", "board/board.kicad_sch").unwrap(), b"(kicad_sch v2)");
        assert!(read(&repo, "", "../hub.git/HEAD").is_err());
        assert!(list(&repo, &lc.base_sha).unwrap().contains(&"board/board.kicad_pcb".to_string()));

        // Commit two of the three, then push the branch.
        commit(&repo, &["board/board.kicad_sch".into(), "board/board.kicad_pcb".into()], "Change the schematic", ("Test", "test@example.com")).unwrap();
        assert_eq!(status(&repo).unwrap().len(), 1, "the unchosen file stays uncommitted");
        assert_eq!(info(&repo).unwrap().ahead, None, "not pushed yet");
        assert_eq!(push_to(&repo, &url, "origin").unwrap(), "feature/led");
        let hub = Repository::open_bare(&bare).unwrap();
        assert_eq!(hub.refname_to_id("refs/heads/feature/led").unwrap(), repo.head().unwrap().target().unwrap());
        assert_eq!(info(&repo).unwrap().ahead, Some(0));

        // Committed changes still count against main, the uncommitted file too.
        let lc = local_changes(&repo, None).unwrap();
        assert_eq!(lc.files.len(), 3);

        // fetch_from brings in others' work on main.
        fetch_from(&repo, &url, "origin").unwrap();

        // Sync state: pushed but one file still uncommitted → same branch tip, 1 change.
        let st = remote_state(&repo, &url, "origin").unwrap();
        assert_eq!((st.relation.as_str(), st.changes), ("same", 1));
        commit(&repo, &["board/extra.kicad_sch".into()], "Add a sheet", ("Test", "test@example.com")).unwrap();
        assert_eq!(remote_state(&repo, &url, "origin").unwrap().relation, "ahead");
        create_branch(&repo, "local/only").unwrap();
        assert_eq!(remote_state(&repo, &url, "origin").unwrap().relation, "unpushed");
        let offline = remote_state(&repo, "/nonexistent/hub.git", "origin").unwrap();
        assert!(offline.error.is_some() && offline.relation == "unknown");
        std::fs::remove_dir_all(base).unwrap();
    }

    /// The HTTPS transport (git_http.rs) against real GitHub; needs the network:
    /// cargo test --lib -- --ignored clone_over_https
    #[test]
    #[ignore]
    fn clone_over_https() {
        git_http::register();
        let dest = std::env::temp_dir().join(format!("kivi-git-https-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dest);
        let mut events = 0;
        let repo = clone_from("https://github.com/octocat/Hello-World.git", &dest, |_| events += 1).unwrap();
        assert!(dest.join("README").exists());
        assert!(events > 0, "progress was reported");
        assert!(local_changes(&repo, None).unwrap().files.is_empty());
        // The gallery's sync check asks GitHub for its branch tips without downloading.
        let st = remote_state(&repo, "https://github.com/octocat/Hello-World.git", "origin").unwrap();
        assert_eq!((st.relation.as_str(), st.changes, st.error.is_none()), ("same", 0, true), "{st:?}");
        // A wrong token is refused with an explanation, not a raw error.
        let err = fetch_from(&repo, "https://x-access-token:wrong@github.com/octocat/Hello-World.git", "origin");
        assert!(err.is_ok() || err.unwrap_err().message().contains("GitHub"));
        std::fs::remove_dir_all(dest).unwrap();
    }

    #[test]
    fn switching_branches_keeps_or_protects_edits() {
        let (base, bare, repo) = fixture("switch");
        let url = bare.to_str().unwrap().to_string();
        let work = workdir(&repo).unwrap();
        // A branch on "GitHub" that this copy only knows as origin/other.
        let other = clone_from(&url, &base.join("other"), |_| {}).unwrap();
        create_branch(&other, "other").unwrap();
        write(&workdir(&other).unwrap(), "board/board.kicad_sch", "(kicad_sch other)");
        commit(&other, &["board/board.kicad_sch".into()], "other", ("O", "o@example.com")).unwrap();
        push_to(&other, &url, "origin").unwrap();
        fetch_from(&repo, &url, "origin").unwrap();
        let names = |r: &Repository| branches(r).unwrap().into_iter().map(|b| (b.name, b.current, b.remote)).collect::<Vec<_>>();
        assert_eq!(names(&repo), vec![("main".into(), true, false), ("other".into(), false, true)]);

        // An edit to a file both branches share unchanged: it comes along.
        write(&work, "board/board.kicad_pcb", "(kicad_pcb mine)");
        switch_branch(&repo, "other").unwrap();
        assert_eq!(current_branch(&repo).as_deref(), Some("other"));
        assert_eq!(std::fs::read_to_string(work.join("board/board.kicad_sch")).unwrap(), "(kicad_sch other)");
        assert_eq!(std::fs::read_to_string(work.join("board/board.kicad_pcb")).unwrap(), "(kicad_pcb mine)");
        assert_eq!(names(&repo)[0], ("other".into(), true, false), "a local branch now");

        // An edit to a file the other branch changes: refused, nothing moves.
        write(&work, "board/board.kicad_sch", "(kicad_sch edited)");
        let err = switch_branch(&repo, "main").unwrap_err();
        assert!(err.contains("overwritten"), "{err}");
        assert_eq!(current_branch(&repo).as_deref(), Some("other"));
        assert_eq!(std::fs::read_to_string(work.join("board/board.kicad_sch")).unwrap(), "(kicad_sch edited)");
        assert!(switch_branch(&repo, "nope").is_err());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn push_refuses_a_branch_that_moved_on() {
        let (base, bare, repo) = fixture("reject");
        let url = bare.to_str().unwrap().to_string();
        // Someone else pushes to main first.
        let other = clone_from(&url, &base.join("other"), |_| {}).unwrap();
        write(&workdir(&other).unwrap(), "board/board.kicad_sch", "(kicad_sch theirs)");
        commit(&other, &["board/board.kicad_sch".into()], "theirs", ("O", "o@example.com")).unwrap();
        push_to(&other, &url, "origin").unwrap();
        // Ours, on the old main, is rejected with an explanation.
        write(&workdir(&repo).unwrap(), "board/board.kicad_sch", "(kicad_sch ours)");
        commit(&repo, &["board/board.kicad_sch".into()], "ours", ("T", "t@example.com")).unwrap();
        let err = push_to(&repo, &url, "origin").unwrap_err();
        assert!(err.contains("rejected") || err.contains("fast-forward"), "{err}");
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn link_a_plain_folder_then_commit_and_push() {
        let base = std::env::temp_dir().join(format!("kivi-git-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let hub = base.join("hub.git");
        Repository::init_bare(&hub).unwrap(); // an empty repository, as just made on GitHub
        let folder = base.join("my board");
        write(&folder, "board.kicad_pro", "{}");
        write(&folder, "board.kicad_pcb", "(kicad_pcb)");

        let repo = link_github(&folder, "me", "board").unwrap();
        let i = info(&repo).unwrap();
        assert_eq!((i.owner.as_deref(), i.repo.as_deref(), i.remote.as_deref()), (Some("me"), Some("board"), Some("origin")));
        assert_eq!((i.branch.as_deref(), i.changes), (Some("main"), 3)); // nothing committed yet (.gitignore too)
        assert!(link_github(&folder, "me", "board").is_ok(), "linking again is fine");
        assert!(link_github(&folder, "me", "other").err().unwrap().contains("already linked to me/board"));

        commit(&repo, &["board.kicad_pro".into(), "board.kicad_pcb".into()], "first", ("T", "t@example.com")).unwrap();
        assert_eq!(push_to(&repo, hub.to_str().unwrap(), "origin").unwrap(), "main");
        assert!(Repository::open_bare(&hub).unwrap().find_reference("refs/heads/main").is_ok());

        // A folder inside a repository isn't made one of its own.
        let inner = folder.join("sub");
        std::fs::create_dir_all(&inner).unwrap();
        assert_eq!(workdir(&open_or_init(&inner).unwrap()).unwrap(), workdir(&repo).unwrap());
        assert!(!inner.join(".git").exists());

        // An existing .gitignore is kept, with only the missing lines added, once.
        let kept = base.join("kept");
        write(&kept, ".gitignore", "build/\n*.bak");
        open_or_init(&kept).unwrap();
        ignore_kicad_files(&kept).unwrap();
        let text = std::fs::read_to_string(kept.join(".gitignore")).unwrap();
        assert!(text.starts_with("build/\n*.bak\n# KiCad's working files\n.history/\n"), "{text}");
        assert_eq!(text.lines().filter(|l| *l == "*.bak").count(), 1);
        assert_eq!(text.lines().count(), 2 + 1 + IGNORED.len() - 1);

        // A repository whose origin isn't GitHub gets a second remote.
        let other = base.join("other");
        write(&other, "x.kicad_pro", "{}");
        Repository::init(&other).unwrap().remote("origin", "https://gitlab.com/me/x.git").unwrap();
        let i = info(&link_github(&other, "me", "x").unwrap()).unwrap();
        assert_eq!(i.remote.as_deref(), Some("github"));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn branch_and_commit_without_github() {
        let base = std::env::temp_dir().join(format!("kivi-git-plain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        write(&base, "board.kicad_pro", "{}");
        for f in [".history/board.kicad_pro", "~board.kicad_pro.lck", "~board.kicad_pcb.lck", "board-backups/b.zip", "_autosave-board.kicad_pcb", "#auto_saved_files#", "fp-info-cache", "board.kicad_pcb-bak", "board.kicad_prl"] {
            write(&base, f, "x");
        }
        let repo = open_or_init(&base).unwrap();
        // A new repository leaves KiCad's working files out, but not the project's local settings.
        let ignore = std::fs::read_to_string(base.join(".gitignore")).unwrap();
        assert!(ignore.starts_with("# KiCad's working files\n.history/\n~*.lck\n"), "{ignore}");
        let changed = status(&repo).unwrap().into_iter().map(|f| f.path).collect::<Vec<_>>();
        assert_eq!(changed, vec![".gitignore", "board.kicad_prl", "board.kicad_pro"]);
        // Before the first commit: the branch to be is shown, and a new branch replaces it.
        assert_eq!(info(&repo).unwrap().branch.as_deref(), Some("main"));
        assert_eq!(create_branch(&repo, "first/try").unwrap(), "first/try");
        let names = |r: &Repository| branches(r).unwrap().into_iter().map(|b| (b.name, b.current)).collect::<Vec<_>>();
        assert_eq!(names(&repo), vec![("first/try".to_string(), true)]);
        commit(&repo, &[".gitignore".into(), "board.kicad_prl".into(), "board.kicad_pro".into()], "first", ("T", "t@example.com")).unwrap();
        assert!(repo.find_branch("first/try", BranchType::Local).is_ok());
        // Then branching works as usual, with no remote at all.
        write(&base, "board.kicad_pro", "{\"a\": 1}");
        create_branch(&repo, "fix/led").unwrap();
        commit(&repo, &["board.kicad_pro".into()], "led", ("T", "t@example.com")).unwrap();
        let i = info(&repo).unwrap();
        assert_eq!((i.branch.as_deref(), i.owner, i.changes, i.ahead), (Some("fix/led"), None, 0, None));
        assert_eq!(names(&repo), vec![("fix/led".to_string(), true), ("first/try".to_string(), false)]);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn local_changes_against_a_commit_or_a_branch() {
        let (base, _bare, repo) = fixture("against");
        let work = workdir(&repo).unwrap();
        let first = repo.head().unwrap().target().unwrap();
        write(&work, "board/board.kicad_sch", "(kicad_sch v2)");
        let second = commit(&repo, &["board/board.kicad_sch".into()], "second", ("T", "t@example.com")).unwrap();
        write(&work, "board/board.kicad_pcb", "(kicad_pcb v2)"); // uncommitted

        let commits = log(&repo, 10).unwrap();
        assert_eq!(commits.iter().map(|c| c.summary.as_str()).collect::<Vec<_>>(), vec!["second", "first"]);
        assert_eq!(commits[0].sha, second);

        // Against main (no base): the branch's commit and the edit.
        let lc = local_changes(&repo, None).unwrap();
        assert_eq!((lc.base_ref.as_str(), lc.files.len()), ("origin/main", 2));
        // Against the latest commit itself: only the uncommitted edit.
        let lc = local_changes(&repo, Some(&second)).unwrap();
        assert_eq!((lc.base_sha.as_str(), lc.base_ref.as_str()), (second.as_str(), &second[..7]));
        assert_eq!(lc.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["board/board.kicad_pcb"]);
        // A short SHA works too; a name that is neither is refused.
        assert_eq!(local_changes(&repo, Some(&first.to_string()[..8])).unwrap().files.len(), 2);
        assert!(local_changes(&repo, Some("no-such-thing")).err().unwrap().contains("no such branch or commit"));
        std::fs::remove_dir_all(base).unwrap();
    }
}
