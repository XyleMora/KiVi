//! Local git copies of forge projects (GitHub, GitLab): clone, link check,
//! status, new branch, local changes for the visual diff, commit, push and pull.
//! libgit2 is built in (git2, "vendored-libgit2"), so no Git installation is
//! needed; HTTPS goes through git_http.rs. A forge is always reached at
//! https://<host>/<owner>/<repo>.git with the sign-in token, whatever URL the
//! clone's own remote has (an ssh:// remote of an existing clone included), and
//! only hosts in FORGE_HOSTS are: a token never goes anywhere else.
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

/// The forges KiVi signs in to, by host, with the user name their tokens go under over HTTPS.
const FORGE_HOSTS: &[(&str, &str)] = &[("github.com", "x-access-token"), ("gitlab.com", "oauth2")];

/// A repository on a forge: `owner` is a GitLab namespace with any subgroups ("group/sub").
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ForgeRepo {
    pub host: String,
    pub owner: String,
    pub repo: String,
}

impl ForgeRepo {
    /// From a command's arguments; refuses hosts KiVi doesn't sign in to and odd paths.
    fn new(host: &str, owner: &str, repo: &str) -> Result<ForgeRepo, String> {
        let host = host.to_ascii_lowercase();
        if !FORGE_HOSTS.iter().any(|(h, _)| *h == host) {
            return Err(format!("{host} isn't a forge KiVi knows"));
        }
        let ok = |s: &str| !s.is_empty() && s.split('/').all(|p| !p.is_empty() && p != "." && p != ".." && !p.contains(['@', ':', '?', '#', '\\']));
        if !ok(owner) || !ok(repo) || repo.contains('/') || (host == "github.com" && owner.contains('/')) {
            return Err(format!("not a repository: {owner}/{repo}"));
        }
        Ok(ForgeRepo { host, owner: owner.to_string(), repo: repo.to_string() })
    }

    fn https_url(&self) -> String {
        format!("https://{}/{}/{}.git", self.host, self.owner, self.repo)
    }

    /// The URL libgit2 talks to: the token rides in the user part, which
    /// git_http.rs turns into an Authorization header.
    fn auth_url(&self, token: &Option<String>) -> String {
        let user = FORGE_HOSTS.iter().find(|(h, _)| *h == self.host).map_or("x-access-token", |(_, u)| u);
        match token.as_deref().filter(|t| !t.is_empty()) {
            Some(t) => format!("https://{user}:{t}@{}/{}/{}.git", self.host, self.owner, self.repo),
            None => self.https_url(),
        }
    }

    /// The forge's name for messages ("GitHub", "GitLab").
    fn forge_name(&self) -> &'static str {
        if self.host == "gitlab.com" { "GitLab" } else { "GitHub" }
    }

    fn same(&self, other: &ForgeRepo) -> bool {
        self.host == other.host && self.owner.eq_ignore_ascii_case(&other.owner) && self.repo.eq_ignore_ascii_case(&other.repo)
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

/// The forge repository a remote URL points at (https, ssh:// or scp-like
/// `git@host:path`), if its host is a forge KiVi knows.
pub(crate) fn forge_repo(url: &str) -> Option<ForgeRepo> {
    let (rest, scp) = match ["https://", "http://", "ssh://"].iter().find_map(|p| url.strip_prefix(p)) {
        Some(r) => (r, false),
        None => (url, true),
    };
    let (authority, path) = if scp { rest.split_once(':')? } else { rest.split_once('/')? };
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h); // user@host
    let host = host.split_once(':').map_or(host, |(h, _)| h); // host:port
    let path = path.trim_start_matches('/').trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, repo) = path.rsplit_once('/')?;
    ForgeRepo::new(host, owner, repo).ok()
}

/// The forge's name a URL points at, for messages ("the remote" for any other URL or a path).
fn forge_label(url: &str) -> &'static str {
    forge_repo(url).map_or("the remote", |f| f.forge_name())
}

fn open(path: &str) -> Result<Repository, String> {
    Repository::discover(path).map_err(|e| format!("{path}: not a git repository ({})", e.message()))
}

fn workdir(repo: &Repository) -> Result<PathBuf, String> {
    repo.workdir().map(Path::to_path_buf).ok_or_else(|| "a bare repository has no files to show".to_string())
}

/// Name of the remote pointing at `target`, if any (any URL form).
fn remote_for(repo: &Repository, target: &ForgeRepo) -> Option<String> {
    let remotes = repo.remotes().ok()?;
    let found = remotes.iter().flatten().find(|r| {
        repo.find_remote(r).ok().and_then(|rem| rem.url().and_then(forge_repo)).is_some_and(|f| f.same(target))
    });
    found.map(str::to_string)
}

/// The first remote that points at a forge KiVi knows, with its repository.
fn forge_remote(repo: &Repository) -> Option<(String, ForgeRepo)> {
    let remotes = repo.remotes().ok()?;
    let names: Vec<String> = remotes.iter().flatten().map(str::to_string).collect();
    // origin first, as git itself would.
    let mut ordered: Vec<&String> = names.iter().filter(|n| *n == "origin").collect();
    ordered.extend(names.iter().filter(|n| *n != "origin"));
    ordered.into_iter().find_map(|r| Some((r.clone(), repo.find_remote(r).ok()?.url().and_then(forge_repo)?)))
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
    /// The forge repository the copy belongs to (its first forge remote): host, owner (a GitLab
    /// namespace may hold "/"), name.
    host: Option<String>,
    owner: Option<String>,
    repo: Option<String>,
    /// The remote pointing at the forge ("origin" for clones made by KiVi).
    remote: Option<String>,
    /// Checked-out branch (before the first commit, the one it will start); None when detached.
    branch: Option<String>,
    head: Option<String>,
    /// Changed, added and deleted files, untracked ones included.
    changes: usize,
    /// Commits on the branch that the forge doesn't have yet; None if never pushed.
    ahead: Option<usize>,
    /// Commits on the forge's branch that this copy doesn't have, as last fetched; None if never pushed.
    behind: Option<usize>,
}

fn info(repo: &Repository) -> Result<RepoInfo, String> {
    let root = workdir(repo)?;
    let gh = forge_remote(repo);
    let branch = current_branch(repo);
    let head = repo.head().ok().and_then(|h| h.target());
    // Against the branch's upstream (set by a push), else the same branch on the remote.
    let remote = gh.as_ref().map_or("origin", |g| g.0.as_str());
    let pushed = branch.as_deref().and_then(|b| {
        let upstream = repo.find_branch(b, BranchType::Local).ok()?.upstream().ok().and_then(|u| u.get().target());
        upstream.or_else(|| repo.refname_to_id(&format!("refs/remotes/{remote}/{b}")).ok())
    });
    let counts = head.zip(pushed).and_then(|(local, up)| repo.graph_ahead_behind(local, up).ok());
    Ok(RepoInfo {
        root: root.to_string_lossy().into_owned(),
        host: gh.as_ref().map(|g| g.1.host.clone()),
        owner: gh.as_ref().map(|g| g.1.owner.clone()),
        repo: gh.as_ref().map(|g| g.1.repo.clone()),
        remote: gh.map(|g| g.0),
        branch,
        head: head.map(|h| h.to_string()),
        changes: status(repo)?.len(),
        ahead: counts.map(|c| c.0),
        behind: counts.map(|c| c.1),
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

/// Clone <host>/<owner>/<repo> into `<parent>/<repo>`, reporting "git-progress"
/// events; returns the new folder.
#[tauri::command]
pub async fn git_clone(host: String, owner: String, repo: String, parent: String, token: Option<String>, app: AppHandle) -> Result<String, String> {
    blocking(move || {
        git_http::register();
        let target = ForgeRepo::new(&host, &owner, &repo)?;
        let dest = Path::new(&parent).join(&repo);
        if dest.exists() && std::fs::read_dir(&dest).map(|mut d| d.next().is_some()).unwrap_or(true) {
            return Err(format!("{} already exists and isn't empty: choose another folder, or link that copy instead", dest.display()));
        }
        let made = !dest.exists();
        let result = clone_from(&target.auth_url(&token), &dest, |p| {
            let _ = app.emit("git-progress", p);
        });
        match result {
            Ok(r) => {
                // The token was only for the download; the saved remote is the plain URL.
                r.remote_set_url("origin", &target.https_url()).map_err(|e| e.message().to_string())?;
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
    /// Only on the forge so far (a remote-tracking branch without a local one).
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
    let remote = forge_remote(repo).map(|g| g.0).unwrap_or_else(|| "origin".into());
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

/// Local branches, then the forge's the copy doesn't have yet (as last fetched).
#[tauri::command]
pub async fn git_branches(path: String) -> Result<Vec<BranchInfo>, String> {
    blocking(move || branches(&open(&path)?)).await
}

fn switch_branch(repo: &Repository, name: &str) -> Result<String, String> {
    if current_branch(repo).as_deref() == Some(name) {
        return Ok(name.to_string());
    }
    let remote = forge_remote(repo).map(|g| g.0).unwrap_or_else(|| "origin".into());
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
            format!("uncommitted changes would be overwritten by \"{name}\": commit them first (Commit…), or switch with git")
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

/// Switch the copy to another branch (creating a local one for a branch only on the forge).
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
    /// The other side when it isn't the working files: a branch or a short SHA, and its commit.
    head_ref: Option<String>,
    head_sha: Option<String>,
    files: Vec<FileChange>,
}

/// The main branch to compare with: `base` if given, else the remote's default
/// (origin/HEAD), else main or master, on the remote or locally.
/// What to compare the working files with: a branch's tip (then from the merge
/// base, like a pull request: the bool is true), or a commit itself (a SHA or
/// any revision git understands, compared with directly). Without `base`: main.
fn base_tip(repo: &Repository, base: Option<&str>) -> Result<(String, Oid, bool), String> {
    let remote = forge_remote(repo).map(|g| g.0).unwrap_or_else(|| "origin".into());
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

/// A branch (this copy's, else the forge's as last fetched) or any revision git
/// understands, as a label and its commit: the "after" side of a comparison, or
/// where a log starts.
fn rev_tip(repo: &Repository, rev: &str) -> Result<(String, Oid), String> {
    let remote = forge_remote(repo).map(|g| g.0).unwrap_or_else(|| "origin".into());
    for r in [format!("refs/heads/{rev}"), format!("refs/remotes/{remote}/{rev}")] {
        if let Ok(id) = repo.refname_to_id(&r) {
            return Ok((rev.to_string(), id));
        }
    }
    let id = repo.revparse_single(rev).and_then(|o| o.peel_to_commit()).map_err(|_| format!("{rev}: no such branch or commit"))?.id();
    Ok((id.to_string()[..7].to_string(), id))
}

fn local_changes(repo: &Repository, base: Option<&str>, head: Option<&str>) -> Result<LocalChanges, String> {
    let root = workdir(repo)?;
    let (base_ref, tip, from_merge_base) = base_tip(repo, base)?;
    let after = head.filter(|h| !h.is_empty()).map(|h| rev_tip(repo, h)).transpose()?;
    let head_id = after.as_ref().map(|a| a.1).or_else(|| repo.head().ok().and_then(|h| h.target()));
    let base_sha = if from_merge_base { head_id.and_then(|h| repo.merge_base(h, tip).ok()).unwrap_or(tip) } else { tip };
    let tree = repo.find_commit(base_sha).and_then(|c| c.tree()).map_err(|e| e.message().to_string())?;
    let mut opts = DiffOptions::new();
    let mut diff = match &after {
        // Two commits.
        Some((_, id)) => {
            let head_tree = repo.find_commit(*id).and_then(|c| c.tree()).map_err(|e| e.message().to_string())?;
            repo.diff_tree_to_tree(Some(&tree), Some(&head_tree), Some(&mut opts))
        }
        // A commit and the working files, untracked ones included.
        None => {
            opts.include_untracked(true).recurse_untracked_dirs(true).show_untracked_content(true);
            repo.diff_tree_to_workdir_with_index(Some(&tree), Some(&mut opts))
        }
    }
    .map_err(|e| e.message().to_string())?;
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
    Ok(LocalChanges {
        root: root.to_string_lossy().into_owned(),
        branch: current_branch(repo),
        base_ref,
        base_sha: base_sha.to_string(),
        head_ref: after.as_ref().map(|a| a.0.clone()),
        head_sha: after.map(|a| a.1.to_string()),
        files,
    })
}

/// The working copy (uncommitted edits and the branch's commits), or `head` (a
/// branch or commit), against the point where it left main (or `base`, a
/// branch), what a pull request would show; or against `base` itself when it's a commit.
#[tauri::command]
pub async fn git_local_changes(path: String, base: Option<String>, head: Option<String>) -> Result<LocalChanges, String> {
    blocking(move || local_changes(&open(&path)?, base.as_deref(), head.as_deref())).await
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
    /// How the checked-out branch relates to the same branch on the forge:
    /// same | ahead (commits to push) | behind (the forge is newer) | diverged |
    /// unpushed (not on the forge) | unknown (the forge not reachable; see `error`).
    relation: String,
    /// Why the forge couldn't be asked (offline, not signed in…).
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
            // Offline: what the copy last saw of the forge (its remote-tracking branch).
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

/// Whether the copy matches its branch on the forge (the gallery's sync icon).
#[tauri::command]
pub async fn git_remote_state(path: String, host: String, owner: String, repo: String, token: Option<String>) -> Result<RemoteState, String> {
    blocking(move || {
        git_http::register();
        let target = ForgeRepo::new(&host, &owner, &repo)?;
        let r = open(&path)?;
        let remote = remote_for(&r, &target).unwrap_or_else(|| "origin".into());
        let mut state = remote_state(&r, &target.auth_url(&token), &remote)?;
        state.error = state.error.map(|e| clean(e, &token));
        Ok(state)
    })
    .await
}

// ---- fetch, commit, push ------------------------------------------------------

fn fetch_from(repo: &Repository, url: &str, remote: &str) -> Result<(), git2::Error> {
    let mut anon = repo.remote_anonymous(url)?;
    anon.fetch(&[format!("+refs/heads/*:refs/remotes/{remote}/*")], None, None)?;
    // Like `git fetch --prune`: branches deleted on the forge leave the branch menu.
    // The list the forge sent stays readable after the fetch disconnects.
    let theirs: Vec<String> = anon.list()?.iter().filter_map(|h| h.name().strip_prefix("refs/heads/").map(String::from)).collect();
    let prefix = format!("refs/remotes/{remote}/");
    for mut r in repo.references_glob(&format!("{prefix}*"))?.flatten() {
        let gone = r.name().and_then(|n| n.strip_prefix(&prefix)).is_some_and(|b| b != "HEAD" && !theirs.iter().any(|t| t == b));
        if gone {
            r.delete()?;
        }
    }
    Ok(())
}

/// Update the remote branches from the forge (so "main" in the visual diff is current).
#[tauri::command]
pub async fn git_fetch(path: String, host: String, owner: String, repo: String, token: Option<String>) -> Result<(), String> {
    blocking(move || {
        git_http::register();
        let target = ForgeRepo::new(&host, &owner, &repo)?;
        let r = open(&path)?;
        let remote = remote_for(&r, &target).unwrap_or_else(|| "origin".into());
        fetch_from(&r, &target.auth_url(&token), &remote).map_err(|e| clean(e.message(), &token))
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
    // The user's own git identity when they have one, else their forge account.
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
    let forge = forge_label(url);
    let rejected_msg = |why: &str| {
        format!("{forge} rejected the push ({why}): the branch there has commits this copy doesn't (Pull… brings them in), or it's protected (push to a new branch instead)")
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

/// Push the current branch to the same branch on the forge; returns its name.
#[tauri::command]
pub async fn git_push(path: String, host: String, owner: String, repo: String, token: Option<String>) -> Result<String, String> {
    blocking(move || {
        git_http::register();
        let target = ForgeRepo::new(&host, &owner, &repo)?;
        let r = open(&path)?;
        let remote = remote_for(&r, &target).unwrap_or_else(|| "origin".into());
        push_to(&r, &target.auth_url(&token), &remote).map_err(|e| clean(e, &token))
    })
    .await
}

// ---- pull -----------------------------------------------------------------------

#[derive(Serialize, Debug)]
pub struct PullResult {
    /// up_to_date | fast_forward (took the forge's commits) | merged (both had
    /// commits on different files: a merge commit) | diverged (both changed
    /// the same files: nothing done, see `files`).
    outcome: String,
    /// Commits that came from the forge (or are waiting there, when diverged).
    commits: usize,
    /// fast_forward / merged: files the forge's commits changed; diverged: files
    /// changed on both sides.
    files: Vec<String>,
}

/// Paths that differ between two trees (both sides of a rename).
fn changed_paths(repo: &Repository, from: Oid, to: Oid) -> Result<Vec<String>, String> {
    let tree = |id: Oid| repo.find_commit(id).and_then(|c| c.tree()).map_err(|e| e.message().to_string());
    let diff = repo.diff_tree_to_tree(Some(&tree(from)?), Some(&tree(to)?), None).map_err(|e| e.message().to_string())?;
    let mut out: Vec<String> = Vec::new();
    for d in diff.deltas() {
        for f in [d.old_file(), d.new_file()] {
            if let Some(p) = f.path().map(|p| p.to_string_lossy().replace('\\', "/")) {
                if !out.contains(&p) {
                    out.push(p);
                }
            }
        }
    }
    Ok(out)
}

/// Check out `tree` like `git switch` does: uncommitted edits stay unless
/// `tree` changes the same files, then nothing is touched.
fn checkout_safely(repo: &Repository, tree: &git2::Tree) -> Result<(), String> {
    let mut co = CheckoutBuilder::new();
    co.safe();
    repo.checkout_tree(tree.as_object(), Some(&mut co)).map_err(|e| {
        if e.code() == git2::ErrorCode::Conflict {
            "uncommitted changes to files the pulled commits also changed would be overwritten: commit them first (Commit…), then pull again".to_string()
        } else {
            e.message().to_string()
        }
    })
}

/// Bring the forge's commits on the current branch into the copy. KiCad files
/// don't merge reliably as text, so a file changed on both sides is never
/// merged: the result is "diverged" and the copy stays as it was.
fn pull_from(repo: &Repository, url: &str, remote: &str, fallback: (&str, &str)) -> Result<PullResult, String> {
    let forge = forge_label(url);
    let branch = current_branch(repo).ok_or("not on a branch: switch to one first")?;
    fetch_from(repo, url, remote).map_err(|e| e.message().to_string())?;
    let theirs = repo
        .refname_to_id(&format!("refs/remotes/{remote}/{branch}"))
        .map_err(|_| format!("\"{branch}\" isn't on {forge} yet, so there's nothing to pull (Push… creates it)"))?;
    let local_ref = format!("refs/heads/{branch}");
    let theirs_commit = repo.find_commit(theirs).map_err(|e| e.message().to_string())?;
    let theirs_tree = theirs_commit.tree().map_err(|e| e.message().to_string())?;
    let result = |outcome: &str, commits: usize, files: Vec<String>| PullResult { outcome: outcome.into(), commits, files };

    let Some(ours) = repo.head().ok().and_then(|h| h.target()) else {
        // Nothing committed here yet: start from the forge's branch.
        checkout_safely(repo, &theirs_tree)?;
        repo.reference(&local_ref, theirs, true, "pull").map_err(|e| e.message().to_string())?;
        let n = repo.revwalk().and_then(|mut w| w.push(theirs).map(|_| w.count())).unwrap_or(0);
        return Ok(result("fast_forward", n, Vec::new()));
    };
    let (ahead, behind) = repo.graph_ahead_behind(ours, theirs).map_err(|e| e.message().to_string())?;
    if behind == 0 {
        return Ok(result("up_to_date", 0, Vec::new()));
    }
    // No common commit: a folder linked to a repository that already had its own history.
    let base = repo
        .merge_base(ours, theirs)
        .map_err(|_| format!("this copy's history and {forge}'s \"{branch}\" have nothing in common (the folder was linked to a repository that already had commits), so KiVi can't combine them: push to a new branch instead"))?;
    let incoming = changed_paths(repo, base, theirs)?;
    if ahead == 0 {
        checkout_safely(repo, &theirs_tree)?;
        repo.reference(&local_ref, theirs, true, "pull: fast-forward").map_err(|e| e.message().to_string())?;
        if let Ok(mut b) = repo.find_branch(&branch, BranchType::Local) {
            let _ = b.set_upstream(Some(&format!("{remote}/{branch}")));
        }
        return Ok(result("fast_forward", behind, incoming));
    }
    // Both sides have commits: combine them only when no file changed on both.
    let mine = changed_paths(repo, base, ours)?;
    let both: Vec<String> = incoming.iter().filter(|p| mine.contains(p)).cloned().collect();
    if !both.is_empty() {
        return Ok(result("diverged", behind, both));
    }
    let ours_commit = repo.find_commit(ours).map_err(|e| e.message().to_string())?;
    let mut index = repo.merge_commits(&ours_commit, &theirs_commit, None).map_err(|e| e.message().to_string())?;
    if index.has_conflicts() {
        return Ok(result("diverged", behind, mine)); // not expected with disjoint files
    }
    let tree = repo.find_tree(index.write_tree_to(repo).map_err(|e| e.message().to_string())?).map_err(|e| e.message().to_string())?;
    checkout_safely(repo, &tree)?;
    let sig = repo.signature().or_else(|_| Signature::now(fallback.0, fallback.1)).map_err(|e| e.message().to_string())?;
    repo.commit(Some("HEAD"), &sig, &sig, &format!("Merge {forge}'s {branch} into {branch}"), &tree, &[&ours_commit, &theirs_commit])
        .map_err(|e| e.message().to_string())?;
    Ok(result("merged", behind, incoming))
}

/// Pull the forge's commits on the current branch (fast-forward, or a merge
/// commit when both sides changed different files). `name`/`email` sign a
/// merge commit when the copy has no git identity.
#[tauri::command]
pub async fn git_pull(path: String, host: String, owner: String, repo: String, token: Option<String>, name: String, email: String) -> Result<PullResult, String> {
    blocking(move || {
        git_http::register();
        let target = ForgeRepo::new(&host, &owner, &repo)?;
        let r = open(&path)?;
        let remote = remote_for(&r, &target).unwrap_or_else(|| "origin".into());
        pull_from(&r, &target.auth_url(&token), &remote, (&name, &email)).map_err(|e| clean(e, &token))
    })
    .await
}

/// After a diverged pull: keep this copy's commits (and uncommitted edits) on
/// a new branch, checked out, and set the old branch to the forge's. Nothing is
/// lost and no files change; the new branch can be pushed for a pull request.
fn move_commits(repo: &Repository, name: &str) -> Result<String, String> {
    let branch = current_branch(repo).ok_or("not on a branch")?;
    let (remote, forge) = forge_remote(repo).map_or(("origin".to_string(), "the remote"), |g| (g.0, g.1.forge_name()));
    let theirs = repo
        .refname_to_id(&format!("refs/remotes/{remote}/{branch}"))
        .map_err(|_| format!("\"{branch}\" isn't on {forge}"))?;
    create_branch(repo, name)?;
    repo.reference(&format!("refs/heads/{branch}"), theirs, true, &format!("match {forge}")).map_err(|e| e.message().to_string())?;
    Ok(name.to_string())
}

#[tauri::command]
pub async fn git_move_commits(path: String, name: String) -> Result<String, String> {
    blocking(move || move_commits(&open(&path)?, name.trim())).await
}

#[derive(Serialize, Debug)]
pub struct CommitInfo {
    sha: String,
    summary: String,
    author: String,
    /// Seconds since 1970.
    time: i64,
}

fn log(repo: &Repository, limit: usize, rev: Option<&str>) -> Result<Vec<CommitInfo>, String> {
    let start = match rev.filter(|r| !r.is_empty()) {
        Some(r) => Some(rev_tip(repo, r)?.1),
        None => repo.head().ok().and_then(|h| h.target()),
    };
    let Some(head) = start else { return Ok(Vec::new()) }; // nothing committed yet
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

/// The latest commits on the checked-out branch, or on `rev` (a branch or commit), newest first
/// (the viewer's history, the visual diff's pickers).
#[tauri::command]
pub async fn git_log(path: String, limit: usize, rev: Option<String>) -> Result<Vec<CommitInfo>, String> {
    blocking(move || log(&open(&path)?, limit, rev.as_deref())).await
}

// ---- linking a local project to a forge -------------------------------------------

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

/// Point the folder's git repository at a forge repository, making the folder
/// a repository first (on main) if it isn't in one. The remote is "origin", or
/// the forge's name ("github", "gitlab") when origin already points elsewhere.
/// Nothing is fetched or pushed: the first push happens from the branch menu.
fn link_remote(path: &Path, target: &ForgeRepo) -> Result<Repository, String> {
    let repo = open_or_init(path)?;
    if remote_for(&repo, target).is_some() {
        return Ok(repo); // already linked there
    }
    if let Some((_, f)) = forge_remote(&repo) {
        return Err(format!("already linked to {}/{} on {}", f.owner, f.repo, f.forge_name()));
    }
    let name = target.forge_name().to_ascii_lowercase();
    let remote = if repo.find_remote("origin").is_ok() { name.as_str() } else { "origin" };
    repo.remote(remote, &target.https_url()).map_err(|e| e.message().to_string())?;
    Ok(repo)
}

/// Link a local project folder to a forge repository (see link_remote); returns git_info.
#[tauri::command]
pub async fn git_link_remote(path: String, host: String, owner: String, repo: String) -> Result<RepoInfo, String> {
    blocking(move || {
        let target = ForgeRepo::new(&host, &owner, &repo)?;
        info(&link_remote(Path::new(&path), &target)?)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forge_urls_in_any_form() {
        let gh = |o: &str, r: &str| Some(ForgeRepo { host: "github.com".into(), owner: o.into(), repo: r.into() });
        let gl = |o: &str, r: &str| Some(ForgeRepo { host: "gitlab.com".into(), owner: o.into(), repo: r.into() });
        for url in [
            "https://github.com/XyleMora/KiVi.git",
            "https://github.com/XyleMora/KiVi",
            "https://user@github.com/XyleMora/KiVi.git",
            "https://GitHub.com/XyleMora/KiVi/",
            "git@github.com:XyleMora/KiVi.git",
            "ssh://git@github.com/XyleMora/KiVi.git",
            "ssh://git@github.com:22/XyleMora/KiVi.git",
        ] {
            assert_eq!(forge_repo(url), gh("XyleMora", "KiVi"), "{url}");
        }
        // GitLab namespaces may hold subgroups.
        assert_eq!(forge_repo("https://gitlab.com/XyleMora/KiVi.git"), gl("XyleMora", "KiVi"));
        assert_eq!(forge_repo("git@gitlab.com:hw/boards/cm5.git"), gl("hw/boards", "cm5"));
        assert_eq!(forge_repo("https://oauth2:x@gitlab.com/hw/boards/cm5"), gl("hw/boards", "cm5"));
        assert_eq!(forge_repo("https://github.com/a/b/c.git"), None); // GitHub has no subgroups
        assert_eq!(forge_repo("https://github.com/XyleMora"), None);
        assert_eq!(forge_repo("https://example.com/XyleMora/KiVi.git"), None);
        assert_eq!(forge_repo("/home/me/bare.git"), None);
    }

    #[test]
    fn tokens_go_only_to_known_forges() {
        let tok = Some("t0k".to_string());
        assert_eq!(ForgeRepo::new("github.com", "o", "r").unwrap().auth_url(&tok), "https://x-access-token:t0k@github.com/o/r.git");
        assert_eq!(ForgeRepo::new("gitlab.com", "g/s", "r").unwrap().auth_url(&tok), "https://oauth2:t0k@gitlab.com/g/s/r.git");
        assert_eq!(ForgeRepo::new("gitlab.com", "g", "r").unwrap().auth_url(&None), "https://gitlab.com/g/r.git");
        assert!(ForgeRepo::new("evil.example", "o", "r").is_err());
        assert!(ForgeRepo::new("github.com", "o/x", "r").is_err());
        assert!(ForgeRepo::new("gitlab.com", "../o", "r").is_err());
        assert!(ForgeRepo::new("gitlab.com", "o", "r@evil.example").is_err());
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
        let lc = local_changes(&repo, Some("main"), None).unwrap();
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
        let lc = local_changes(&repo, None, None).unwrap();
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
        assert!(local_changes(&repo, None, None).unwrap().files.is_empty());
        // The gallery's sync check asks GitHub for its branch tips without downloading.
        let st = remote_state(&repo, "https://github.com/octocat/Hello-World.git", "origin").unwrap();
        assert_eq!((st.relation.as_str(), st.changes, st.error.is_none()), ("same", 0, true), "{st:?}");
        // Pruning reads GitHub's branch list through this transport too: a stale branch goes, the rest stay.
        let tip = repo.head().unwrap().target().unwrap();
        repo.reference("refs/remotes/origin/deleted-upstream", tip, true, "test").unwrap();
        fetch_from(&repo, "https://github.com/octocat/Hello-World.git", "origin").unwrap();
        assert!(repo.find_reference("refs/remotes/origin/deleted-upstream").is_err());
        assert!(repo.find_reference("refs/remotes/origin/master").is_ok());
        // A wrong token is refused with an explanation, not a raw error.
        let err = fetch_from(&repo, "https://x-access-token:wrong@github.com/octocat/Hello-World.git", "origin");
        assert!(err.is_ok() || err.unwrap_err().message().contains("GitHub"));
        std::fs::remove_dir_all(dest).unwrap();
    }

    /// The same against real gitlab.com, a project in a subgroup; needs the network:
    /// cargo test --lib -- --ignored clone_gitlab_over_https
    #[test]
    #[ignore]
    fn clone_gitlab_over_https() {
        git_http::register();
        let target = ForgeRepo::new("gitlab.com", "gitlab-examples/maven", "simple-maven-example").unwrap();
        let dest = std::env::temp_dir().join(format!("kivi-gitlab-https-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dest);
        let repo = clone_from(&target.auth_url(&None), &dest, |_| {}).unwrap();
        assert!(dest.join("README.md").exists());
        assert_eq!(forge_remote(&repo).map(|r| r.1), Some(target.clone()), "the clone's remote is recognised as GitLab");
        let st = remote_state(&repo, &target.https_url(), "origin").unwrap();
        assert_eq!((st.relation.as_str(), st.error.is_none()), ("same", true), "{st:?}");
        fetch_from(&repo, &target.https_url(), "origin").unwrap();
        // A wrong token: GitLab answers 401 for a public project's push only, so pushing explains it.
        let err = push_to(&repo, &target.auth_url(&Some("wrong".into())), "origin").unwrap_err();
        assert!(err.contains("GitLab"), "{err}");
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
    fn fetch_forgets_branches_deleted_on_github() {
        let (base, bare, repo) = fixture("prune");
        let url = bare.to_str().unwrap().to_string();
        let other = clone_from(&url, &base.join("other"), |_| {}).unwrap();
        create_branch(&other, "gone").unwrap();
        push_to(&other, &url, "origin").unwrap();
        fetch_from(&repo, &url, "origin").unwrap();
        let names = |r: &Repository| branches(r).unwrap().into_iter().map(|b| b.name).collect::<Vec<_>>();
        assert_eq!(names(&repo), vec!["main".to_string(), "gone".to_string()]);

        Repository::open_bare(&bare).unwrap().find_reference("refs/heads/gone").unwrap().delete().unwrap();
        fetch_from(&repo, &url, "origin").unwrap();
        assert_eq!(names(&repo), vec!["main".to_string()]);
        assert!(repo.find_reference("refs/remotes/origin/main").is_ok(), "branches still on GitHub stay");
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

    /// Someone else's commit on main, pushed to the hub.
    fn push_theirs(base: &Path, url: &str, file: &str, text: &str) -> Oid {
        let other = clone_from(url, &base.join(format!("other-{}", file.replace('/', "-"))), |_| {}).unwrap();
        write(&workdir(&other).unwrap(), file, text);
        commit(&other, &[file.into()], "theirs", ("O", "o@example.com")).unwrap();
        push_to(&other, url, "origin").unwrap();
        let id = other.head().unwrap().target().unwrap();
        id
    }

    fn read_file(repo: &Repository, file: &str) -> String {
        std::fs::read_to_string(workdir(repo).unwrap().join(file)).unwrap()
    }

    const SIG: (&str, &str) = ("T", "t@example.com");

    #[test]
    fn pull_fast_forwards_and_keeps_unrelated_edits() {
        let (base, bare, repo) = fixture("pull-ff");
        let url = bare.to_str().unwrap().to_string();
        let theirs = push_theirs(&base, &url, "board/board.kicad_sch", "(kicad_sch theirs)");
        write(&workdir(&repo).unwrap(), "board/board.kicad_pcb", "(kicad_pcb my edit)"); // uncommitted, another file
        let r = pull_from(&repo, &url, "origin", SIG).unwrap();
        assert_eq!((r.outcome.as_str(), r.commits), ("fast_forward", 1));
        assert_eq!(r.files, vec!["board/board.kicad_sch".to_string()]);
        assert_eq!(repo.head().unwrap().target().unwrap(), theirs);
        assert_eq!(read_file(&repo, "board/board.kicad_sch"), "(kicad_sch theirs)");
        assert_eq!(read_file(&repo, "board/board.kicad_pcb"), "(kicad_pcb my edit)");
        assert_eq!(info(&repo).unwrap().behind, Some(0));
        // Nothing new the second time.
        assert_eq!(pull_from(&repo, &url, "origin", SIG).unwrap().outcome, "up_to_date");
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn pull_never_overwrites_uncommitted_edits() {
        let (base, bare, repo) = fixture("pull-dirty");
        let url = bare.to_str().unwrap().to_string();
        let before = repo.head().unwrap().target().unwrap();
        push_theirs(&base, &url, "board/board.kicad_sch", "(kicad_sch theirs)");
        write(&workdir(&repo).unwrap(), "board/board.kicad_sch", "(kicad_sch my edit)");
        let err = pull_from(&repo, &url, "origin", SIG).unwrap_err();
        assert!(err.contains("commit them first"), "{err}");
        assert_eq!(repo.head().unwrap().target().unwrap(), before);
        assert_eq!(read_file(&repo, "board/board.kicad_sch"), "(kicad_sch my edit)");
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn pull_merges_commits_on_different_files_then_pushes() {
        let (base, bare, repo) = fixture("pull-merge");
        let url = bare.to_str().unwrap().to_string();
        let theirs = push_theirs(&base, &url, "board/board.kicad_sch", "(kicad_sch theirs)");
        write(&workdir(&repo).unwrap(), "board/board.kicad_pcb", "(kicad_pcb mine)");
        commit(&repo, &["board/board.kicad_pcb".into()], "mine", SIG).unwrap();
        let ours = repo.head().unwrap().target().unwrap();
        let r = pull_from(&repo, &url, "origin", SIG).unwrap();
        assert_eq!((r.outcome.as_str(), r.commits), ("merged", 1));
        let merge = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(merge.parent_ids().collect::<Vec<_>>(), vec![ours, theirs]);
        assert_eq!(read_file(&repo, "board/board.kicad_sch"), "(kicad_sch theirs)");
        assert_eq!(read_file(&repo, "board/board.kicad_pcb"), "(kicad_pcb mine)");
        assert!(status(&repo).unwrap().is_empty(), "{:?}", status(&repo).unwrap());
        assert_eq!(push_to(&repo, &url, "origin").unwrap(), "main"); // the push that was refused before
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn pull_leaves_files_changed_on_both_sides_and_moves_commits_aside() {
        let (base, bare, repo) = fixture("pull-diverged");
        let url = bare.to_str().unwrap().to_string();
        let theirs = push_theirs(&base, &url, "board/board.kicad_sch", "(kicad_sch theirs)");
        write(&workdir(&repo).unwrap(), "board/board.kicad_sch", "(kicad_sch mine)");
        commit(&repo, &["board/board.kicad_sch".into()], "mine", SIG).unwrap();
        let ours = repo.head().unwrap().target().unwrap();
        write(&workdir(&repo).unwrap(), "notes.txt", "uncommitted"); // comes along too
        let r = pull_from(&repo, &url, "origin", SIG).unwrap();
        assert_eq!(r.outcome, "diverged");
        assert_eq!(r.files, vec!["board/board.kicad_sch".to_string()]);
        assert_eq!(repo.head().unwrap().target().unwrap(), ours, "nothing changes");
        assert_eq!(read_file(&repo, "board/board.kicad_sch"), "(kicad_sch mine)");
        // My work goes to its own branch; main matches GitHub.
        assert_eq!(move_commits(&repo, "main-mine").unwrap(), "main-mine");
        assert_eq!(current_branch(&repo).as_deref(), Some("main-mine"));
        assert_eq!(repo.head().unwrap().target().unwrap(), ours);
        assert_eq!(repo.refname_to_id("refs/heads/main").unwrap(), theirs);
        assert_eq!(read_file(&repo, "board/board.kicad_sch"), "(kicad_sch mine)");
        assert_eq!(read_file(&repo, "notes.txt"), "uncommitted");
        assert_eq!(push_to(&repo, &url, "origin").unwrap(), "main-mine");
        assert!(move_commits(&repo, "bad name").is_err());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn pull_explains_unrelated_histories() {
        let (base, bare, _repo) = fixture("pull-unrelated");
        let url = bare.to_str().unwrap().to_string();
        // A folder with its own first commit, linked to a repository that already had one.
        let own = Repository::init(base.join("own")).unwrap();
        write(&workdir(&own).unwrap(), "x.kicad_sch", "(kicad_sch own)");
        commit(&own, &["x.kicad_sch".into()], "own", SIG).unwrap();
        let head = own.head().unwrap().target().unwrap();
        own.reference("refs/heads/main", head, true, "main").unwrap();
        own.set_head("refs/heads/main").unwrap();
        let err = pull_from(&own, &url, "origin", SIG).unwrap_err();
        assert!(err.contains("nothing in common"), "{err}");
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn pull_explains_a_branch_github_doesnt_have() {
        let (base, bare, repo) = fixture("pull-new");
        let url = bare.to_str().unwrap().to_string();
        create_branch(&repo, "feature/new").unwrap();
        let err = pull_from(&repo, &url, "origin", SIG).unwrap_err();
        assert!(err.contains("isn't on the remote yet"), "{err}");
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

        let gh = |o: &str, r: &str| ForgeRepo::new("github.com", o, r).unwrap();
        let repo = link_remote(&folder, &gh("me", "board")).unwrap();
        let i = info(&repo).unwrap();
        assert_eq!((i.owner.as_deref(), i.repo.as_deref(), i.remote.as_deref()), (Some("me"), Some("board"), Some("origin")));
        assert_eq!((i.branch.as_deref(), i.changes), (Some("main"), 3)); // nothing committed yet (.gitignore too)
        assert!(link_remote(&folder, &gh("me", "board")).is_ok(), "linking again is fine");
        assert!(link_remote(&folder, &gh("me", "other")).err().unwrap().contains("already linked to me/board on GitHub"));

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

        // A repository whose origin is on no forge gets a second remote, named after the forge.
        let other = base.join("other");
        write(&other, "x.kicad_pro", "{}");
        Repository::init(&other).unwrap().remote("origin", "https://example.com/me/x.git").unwrap();
        let i = info(&link_remote(&other, &gh("me", "x")).unwrap()).unwrap();
        assert_eq!(i.remote.as_deref(), Some("github"));

        // GitLab, with a subgroup: origin when free; one forge remote per copy.
        let lab = base.join("lab");
        write(&lab, "y.kicad_pro", "{}");
        let i = info(&link_remote(&lab, &ForgeRepo::new("gitlab.com", "hw/boards", "y").unwrap()).unwrap()).unwrap();
        assert_eq!((i.host.as_deref(), i.owner.as_deref(), i.repo.as_deref(), i.remote.as_deref()), (Some("gitlab.com"), Some("hw/boards"), Some("y"), Some("origin")));
        assert!(link_remote(&lab, &gh("me", "y")).err().unwrap().contains("already linked to hw/boards/y on GitLab"));
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

        let commits = log(&repo, 10, None).unwrap();
        assert_eq!(commits.iter().map(|c| c.summary.as_str()).collect::<Vec<_>>(), vec!["second", "first"]);
        assert_eq!(commits[0].sha, second);

        // Against main (no base): the branch's commit and the edit.
        let lc = local_changes(&repo, None, None).unwrap();
        assert_eq!((lc.base_ref.as_str(), lc.files.len()), ("origin/main", 2));
        // Against the latest commit itself: only the uncommitted edit.
        let lc = local_changes(&repo, Some(&second), None).unwrap();
        assert_eq!((lc.base_sha.as_str(), lc.base_ref.as_str()), (second.as_str(), &second[..7]));
        assert_eq!(lc.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["board/board.kicad_pcb"]);
        // A short SHA works too; a name that is neither is refused.
        assert_eq!(local_changes(&repo, Some(&first.to_string()[..8]), None).unwrap().files.len(), 2);
        assert!(local_changes(&repo, Some("no-such-thing"), None).err().unwrap().contains("no such branch or commit"));

        // Two commits, or a branch against GitHub's main: the working files stay out.
        let lc = local_changes(&repo, Some(&first.to_string()), Some(&second)).unwrap();
        assert_eq!((lc.head_ref.as_deref(), lc.head_sha.as_deref()), (Some(&second[..7]), Some(second.as_str())));
        assert_eq!(lc.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["board/board.kicad_sch"]);
        let lc = local_changes(&repo, Some("main"), Some("main")).unwrap();
        assert_eq!((lc.base_ref.as_str(), lc.head_ref.as_deref(), lc.files.len()), ("origin/main", Some("main"), 1));
        assert!(local_changes(&repo, None, Some("nope")).is_err());
        // The log of another branch or commit.
        let at = |r: &str| log(&repo, 10, Some(r)).unwrap().into_iter().map(|c| c.summary).collect::<Vec<_>>();
        assert_eq!(at("origin/main"), vec!["first"]);
        assert_eq!(at("main"), vec!["second", "first"]);
        std::fs::remove_dir_all(base).unwrap();
    }
}
