// The GitLab adapter (gitlab.com): the same forge interface as ./github.js
// (described in ./index.js), over GitLab's REST API v4. gitlab.com answers the
// API with CORS headers for any origin, so pages call it directly; its raw
// file URLs (/-/raw/…) don't, so files are read through the API too.
//
// GitLab's words: merge requests (!12) for pull requests, discussions for
// review threads, notes for comments. A project is "group/sub/project": owner
// is everything before the last "/" (nested groups).
//
// No DOM and no Tauri: this runs under gjs (tests/gitlab.js) and in pages.

import { COMPARED, SOURCE_FILES } from "../project.js";
import { ISSUE_LABEL, LABEL_COLOUR, LABEL_DESCRIPTION, closingNumbers, comment, encodeBody, issueThread } from "../review.js";

const HOST = "gitlab.com";
const WEB = `https://${HOST}`;
const API = `${WEB}/api/v4`;
const FULL_SHA = /^[0-9a-f]{40}$/i;
const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");
/** A project in a URL path: its full path, encoded ("group%2Fsub%2Fproject"). */
const pid = (nwo) => encodeURIComponent(nwo);
const nwoOf = (owner, repo) => `${owner}/${repo}`;

// ---- requests ------------------------------------------------------------------------

/**
 * One API request (`path` below /api/v4, or a full URL from a Link header).
 * `writeHint` (what a refused write needs) gives the review panel's
 * explanations, as on GitHub. Resolves with {data, next}: the JSON reply and
 * the next page's URL, if any.
 */
async function call(path, { token = null, method = "GET", body, fetch: fetchFn = null, writeHint = null } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const doFetch = fetchFn ?? ((...a) => globalThis.fetch(...a));
  const r = await doFetch(path.startsWith("https://") ? path : `${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 204) return { data: null, next: null };
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw gitlabError(r.status, data, writeHint, r.headers);
  return { data, next: nextLink(r.headers?.get?.("link")) };
}

const request = async (path, o) => (await call(path, o)).data;

/** The rel="next" URL of a Link header. */
function nextLink(link) {
  return /<([^>]+)>;\s*rel="next"/.exec(link ?? "")?.[1] ?? null;
}

/** "error" of every shape GitLab uses: a string, a list, or {field: [reasons]}. */
function describe(m) {
  if (!m) return null;
  if (typeof m === "string") return m;
  if (Array.isArray(m)) return m.map(describe).join("; ");
  if (typeof m === "object") return Object.entries(m).map(([k, v]) => `${k} ${describe(v)}`).join("; ");
  return String(m);
}

function gitlabError(status, data, what, headers = null) {
  let msg = describe(data?.message) ?? describe(data?.error) ?? `HTTP ${status}`;
  if (status === 429) {
    const wait = Number(headers?.get?.("retry-after"));
    const when = wait > 0 ? ` (again in ${wait < 90 ? `${Math.ceil(wait)} s` : `${Math.ceil(wait / 60)} min`})` : "";
    // Signed out, gitlab.com counts every request from this computer's address together.
    msg = `API rate limit reached${when} — signing in to GitLab gives a much higher limit`;
  }
  else if (status === 401) msg = what ? "GitLab ended the sign-in; sign in again" : msg;
  else if (what && (status === 403 || status === 404)) msg += ` — your account needs access to ${what} (Reporter for issues, Developer for merge requests)`;
  const err = new Error(`GitLab ${status}: ${msg}`);
  err.status = status;
  return err;
}

/** Every page of a listing, following Link headers (at most `max` pages of 100). */
async function pages(path, token, { max = 10, fetch = null } = {}) {
  const out = [];
  let url = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  for (let page = 0; url && page < max; page++) {
    const { data, next } = await call(url, { token, fetch });
    out.push(...data);
    url = next;
    out.truncated = !!url;
  }
  return out;
}

// ---- shapes --------------------------------------------------------------------------

/** @returns {import("./index.js").RepoInfo} */
const repoInfo = (p) => ({
  nwo: p.path_with_namespace,
  defaultBranch: p.default_branch ?? null, // null: an empty project
  pushedAt: p.last_activity_at,
  private: p.visibility ? p.visibility !== "public" : false,
  archived: !!p.archived,
  disabled: false,
  url: p.web_url,
});

/** A diff entry (merge request, commit, comparison) → ChangedFile. */
const changedFile = (d, ref = null) => ({
  path: d.new_path,
  previous: d.old_path ?? d.new_path,
  status: d.new_file ? "added" : d.deleted_file ? "removed" : d.renamed_file ? "renamed" : "modified",
  patch: d.diff || null, // empty when GitLab left out a large diff
  ref,
});

const commitEntry = (c) => ({
  sha: c.id,
  summary: c.title ?? c.message?.split("\n")[0] ?? "",
  author: c.author_name ?? "",
  time: Date.parse(c.authored_date ?? c.created_at) / 1000,
});

/** The project of an issue or merge request: its web URL is <project>/-/issues/N. */
const nwoOfWebUrl = (url) => (/^https?:\/\/[^/]+\/(.+?)\/-\/(?:issues|merge_requests)\//.exec(url ?? "")?.[1] ?? "");

/** A merge request or issue → SearchItem. */
const searchItem = (it) => ({
  nwo: nwoOfWebUrl(it.web_url),
  number: it.iid,
  title: it.title,
  body: it.description ?? "",
  draft: !!(it.draft ?? it.work_in_progress),
  author: it.author?.username ?? "ghost",
  avatar: it.author?.avatar_url ?? null,
  updatedAt: it.updated_at,
  comments: it.user_notes_count ?? 0,
  url: it.web_url,
});

// ---- specs ---------------------------------------------------------------------------

/**
 * Parse gitlab.com URLs and shorthands:
 *   group/project, group/sub/project@ref, group/project@ref:path,
 *   https://gitlab.com/group/sub/project[/-/tree|blob/<ref>/<path>]
 * Refs containing "/" are resolved later against the API (`rest`).
 */
function parseSpec(spec) {
  spec = spec.trim();
  let m = /^(?:https?:\/\/)?(?:www\.)?gitlab\.com\/(.+?)(?:\.git)?(?:\/-\/(tree|blob)\/(.+?))?\/?(?:[?#].*)?$/.exec(spec);
  if (m) {
    const parts = m[1].split("/").filter(Boolean);
    if (parts.length < 2 || parts.includes("-")) return null;
    return { owner: parts.slice(0, -1).join("/"), repo: parts.at(-1), rest: m[3] ? decodeURIComponent(m[3]) : null, kind: m[2] ?? null };
  }
  m = /^((?:[\w.-]+\/)+)([\w.-]+)(?:@([^:]+))?(?::(.*))?$/.exec(spec);
  if (m) return { owner: m[1].slice(0, -1), repo: m[2], ref: m[3] ?? null, path: m[4] ?? "", rest: null };
  return null;
}

// ---- files of a repository -------------------------------------------------------------

/** Every file below `dir` at `rev` (the tree API, 100 entries per request). */
async function treeFiles(nwo, rev, dir, token) {
  const q = `ref=${encodeURIComponent(rev)}&recursive=true&pagination=keyset${dir ? `&path=${encodeURIComponent(dir)}` : ""}`;
  // 300 pages = 30,000 entries; a bigger repository is listed in part (`truncated`), like GitHub's.
  const all = await pages(`/projects/${pid(nwo)}/repository/tree?${q}`, token, { max: 300 });
  const files = all.filter((e) => e.type === "blob");
  files.truncated = all.truncated;
  return files;
}

/** A project at a branch or commit, read through the API. */
export class GitLabSource {
  constructor({ owner, repo, ref, path = "", token = null, sha = null }) {
    this.kind = "gitlab";
    this.forge = gitlab;
    this.owner = owner;
    this.repo = repo;
    this.ref = ref;
    this.sha = sha;
    this.path = path; // sub-directory or file the user pointed at
    this.token = token;
    this.label = `${owner}/${repo}@${ref}${path ? `:${path}` : ""}`;
    this._list = null;
  }

  get nwo() {
    return nwoOf(this.owner, this.repo);
  }

  /** Directory the listing is restricted to ("" = whole repository). */
  get dir() {
    const p = this.path.replace(/\/+$/, "");
    return SOURCE_FILES.test(p) ? p.slice(0, Math.max(0, p.lastIndexOf("/"))) : p;
  }

  async list() {
    if (!this._list) {
      const rev = this.sha ?? this.ref;
      // A folder that isn't in this commit is a 404.
      let files = await treeFiles(this.nwo, rev, this.dir, this.token).catch((e) => (this.dir && e.status === 404 ? [] : Promise.reject(e)));
      if (!files.length && this.dir) {
        // The folder isn't in this commit (moved, or a mangled link): list the whole repository instead.
        console.warn(`${this.dir} not found in ${this.ref}; listing the whole repository`);
        this.path = "";
        this.label = `${this.nwo}@${this.ref}`;
        files = await treeFiles(this.nwo, rev, "", this.token);
      }
      this.truncated = !!files.truncated;
      this._list = files.map((e) => e.path).filter((p) => SOURCE_FILES.test(p));
    }
    return this._list;
  }

  has(path) {
    return !!this._list?.includes(path);
  }

  /** The file through the API (`lfs=true`: files kept in Git LFS come as their content). */
  rawUrl(path) {
    return `${API}/projects/${pid(this.nwo)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(this.sha ?? this.ref)}&lfs=true`;
  }

  async fetchFile(path) {
    const r = await fetch(this.rawUrl(path), this.token ? { headers: { Authorization: `Bearer ${this.token}` } } : undefined);
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r;
  }

  async readText(path) {
    return (await this.fetchFile(path)).text();
  }

  async readBinary(path) {
    return new Uint8Array(await (await this.fetchFile(path)).arrayBuffer());
  }

  url(path) {
    return this.token ? null : this.rawUrl(path);
  }
}

/** Build a source from a spec, resolving the default branch and ambiguous refs. */
async function open(spec, token = null) {
  const p = typeof spec === "string" ? parseSpec(spec) : spec;
  if (!p) throw new Error("Not a GitLab project URL");
  const nwo = nwoOf(p.owner, p.repo);
  let ref = p.ref, path = p.path ?? "";
  if (p.rest) {
    // "<ref>/<path>": the shortest ref that exists.
    const parts = p.rest.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const cand = parts.slice(0, i).join("/");
      try {
        const c = await request(`/projects/${pid(nwo)}/repository/commits/${encodeURIComponent(cand)}`, { token });
        return new GitLabSource({ owner: p.owner, repo: p.repo, ref: cand, path: parts.slice(i).join("/"), token, sha: c.id });
      } catch (e) {
        if (e.status && e.status !== 404) throw e;
      }
    }
    throw new Error(`Could not resolve branch/commit in "${p.rest}"`);
  }
  if (!ref || ref === "HEAD") ref = (await request(`/projects/${pid(nwo)}`, { token }).catch((e) => (ref ? null : Promise.reject(e))))?.default_branch ?? ref;
  return new GitLabSource({ owner: p.owner, repo: p.repo, ref, path, token });
}

// ---- comparisons -----------------------------------------------------------------------

/** The commits around a merge request: base (the merge base), start (the target's tip) and head. */
async function diffRefs(nwo, iid, token, fetch = null) {
  const mr = await request(`/projects/${pid(nwo)}/merge_requests/${iid}`, { token, fetch });
  if (!mr.diff_refs) throw new Error(`GitLab hasn't worked out merge request !${iid}'s changes yet; try again in a moment`);
  return { mr, refs: mr.diff_refs };
}

/**
 * Resolve what to compare (the same specs as GitHub's compare):
 *   {owner, repo, pr: 42}                   merge request (base = its merge base)
 *   {owner, repo, commit: "<sha>"}          commit against its first parent
 *   {owner, repo, base: "main", head: "x"}  from where head left base (a full-SHA base: as it is);
 *                                           no base = the default branch
 * @returns {Promise<import("./index.js").Comparison>}
 */
async function compare(spec, token = null) {
  const { owner, repo } = spec;
  const nwo = nwoOf(owner, repo);
  const proj = `/projects/${pid(nwo)}`;
  let base, head, files, title, url;
  if (spec.pr) {
    const pr = await pullRequest(owner, repo, spec.pr, token);
    head = { owner: pr.head.owner, repo: pr.head.repo, sha: pr.head.sha, ref: pr.head.ref };
    base = { owner, repo, sha: pr.base.sha, ref: pr.base.ref };
    files = await pullFiles(owner, repo, spec.pr, token);
    title = `!${pr.number} ${pr.title}`;
    url = pr.url;
  } else if (spec.commit) {
    const c = await request(`${proj}/repository/commits/${encodeURIComponent(spec.commit)}`, { token });
    head = { owner, repo, sha: c.id, ref: c.id.slice(0, 7) };
    const parent = c.parent_ids?.[0];
    base = { owner, repo, sha: parent ?? null, ref: parent ? parent.slice(0, 7) : "(none)" };
    files = (await pages(`${proj}/repository/commits/${c.id}/diff?`, token, { max: 30 })).map((d) => changedFile(d));
    title = c.title;
    url = c.web_url;
  } else {
    const baseRef = spec.base || (await request(proj, { token })).default_branch;
    // The same branch on both sides (e.g. the viewer's Visual diff on the default branch): its latest commit.
    if (baseRef === spec.head) return compare({ owner, repo, commit: spec.head }, token);
    const short = (r) => (FULL_SHA.test(r) ? r.slice(0, 7) : r);
    // A full SHA is compared as it is ("straight"); a branch from where the head left it, like a merge request.
    const straight = FULL_SHA.test(baseRef);
    const [cmp, mb] = await Promise.all([
      request(`${proj}/repository/compare?from=${encodeURIComponent(baseRef)}&to=${encodeURIComponent(spec.head)}&straight=${straight}`, { token }),
      straight ? null : request(`${proj}/repository/merge_base?refs[]=${encodeURIComponent(baseRef)}&refs[]=${encodeURIComponent(spec.head)}`, { token }),
    ]);
    const headSha = cmp.commit?.id ?? (FULL_SHA.test(spec.head) ? spec.head : (await request(`${proj}/repository/commits/${encodeURIComponent(spec.head)}`, { token })).id);
    base = { owner, repo, sha: straight ? baseRef : mb.id, ref: short(baseRef) };
    head = { owner, repo, sha: headSha, ref: short(spec.head) };
    files = (cmp.diffs ?? []).map((d) => changedFile(d));
    title = `${base.ref} → ${head.ref}`;
    url = cmp.web_url ?? `${WEB}/${nwo}/-/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(spec.head)}`;
  }
  files = files.filter((f) => COMPARED(f.path) || COMPARED(f.previous)).map((f) => ({ path: f.path, previous: f.previous, status: f.status }));
  return { base, head, files, title, url };
}

// ---- projects, branches, commits, merge requests ---------------------------------------

async function repoOf(nwo, token = null) {
  return repoInfo(await request(`/projects/${pid(nwo)}`, { token }));
}

/**
 * Projects for the gallery: signed in, every project the user is a member of
 * (Reporter or above, not archived; the user's choice); then the watched ones.
 * `hidden` are lower-case paths left out.
 * @returns {Promise<import("./index.js").RepoInfo[]>}
 */
async function listRepos(token, { watched = [], hidden = new Set() } = {}) {
  const repos = new Map();
  const add = (r) => r && !hidden.has(r.nwo.toLowerCase()) && repos.set(r.nwo, r);
  if (token) for (const p of await pages("/projects?membership=true&min_access_level=20&archived=false&order_by=last_activity_at", token)) add(repoInfo(p));
  for (const nwo of watched) if (!repos.has(nwo) && !hidden.has(nwo.toLowerCase())) add(await repoOf(nwo, token).catch(() => null));
  return [...repos.values()];
}

/** Every file of a branch: [{path, sha, size}] (sizes aren't listed: null), plus whether the listing was cut short. */
async function tree(nwo, ref, token = null) {
  if (!ref) return { files: [], truncated: false }; // an empty project has no default branch
  let files;
  try {
    files = await treeFiles(nwo, ref, "", token);
  } catch (e) {
    if (e.status !== 404) throw e; // 404: an empty repository
    return { files: [], truncated: false };
  }
  return { files: files.map((e) => ({ path: e.path, sha: e.id, size: null })), truncated: !!files.truncated };
}

async function branches(owner, repo, token = null) {
  return (await pages(`/projects/${pid(nwoOf(owner, repo))}/repository/branches`, token, { max: 5 })).map((b) => ({ name: b.name }));
}

/** `count` commits of `ref` from `offset` (a multiple of `count`), newest first. */
async function commits(owner, repo, ref, offset, count, token = null) {
  const page = Math.floor(offset / count) + 1;
  const batch = await request(`/projects/${pid(nwoOf(owner, repo))}/repository/commits?ref_name=${encodeURIComponent(ref)}&per_page=${count}&page=${page}`, { token });
  return batch.map(commitEntry);
}

/**
 * A merge request. Its head commit is read in this project even when it comes
 * from a fork: GitLab keeps a merge request's commits in the target project.
 * @returns {Promise<import("./index.js").PullRequest>}
 */
async function pullRequest(owner, repo, number, token = null) {
  const { mr, refs } = await diffRefs(nwoOf(owner, repo), number, token);
  return {
    owner, repo,
    number: mr.iid,
    title: mr.title,
    body: mr.description ?? "",
    url: mr.web_url,
    base: { owner, repo, sha: refs.base_sha, ref: mr.target_branch },
    head: { owner, repo, sha: refs.head_sha, ref: mr.source_branch, label: mr.source_project_id !== mr.target_project_id ? `fork:${mr.source_branch}` : mr.source_branch },
  };
}

/** The files a merge request changes, read at its head (`ref`). */
async function pullFiles(owner, repo, number, token = null, { max = 30 } = {}) {
  const nwo = nwoOf(owner, repo);
  const [{ refs }, diffs] = await Promise.all([diffRefs(nwo, number, token), pages(`/projects/${pid(nwo)}/merge_requests/${number}/diffs?`, token, { max })]);
  return diffs.map((d) => changedFile(d, refs.head_sha));
}

// ---- lists for the home page ---------------------------------------------------------

/** Each project's own list (`what` = merge_requests | issues), merged. */
async function perProject(repos, what, query, token) {
  const out = [];
  for (const nwo of repos) out.push(...(await request(`/projects/${pid(nwo)}/${what}?${query}`, { token }).catch((e) => (e.status === 404 ? [] : Promise.reject(e)))));
  return out;
}

/**
 * Open merge requests, most recently updated first: `{reviewRequested: true}`
 * (waiting for the user's review), `{author: "me"}`, or `{repos: [path…]}`.
 * @returns {Promise<import("./index.js").SearchItem[]>}
 */
async function searchPullRequests(filter, token = null) {
  const q = "state=opened&order_by=updated_at&per_page=30";
  if (filter.repos) return (await perProject(filter.repos, "merge_requests", q, token)).map(searchItem);
  if (filter.reviewRequested) {
    const me = await user(token);
    return (await request(`/merge_requests?${q}&scope=all&reviewer_username=${encodeURIComponent(me.login)}`, { token })).map(searchItem);
  }
  return (await request(`/merge_requests?${q}&scope=created_by_me`, { token })).map(searchItem);
}

/**
 * Open issues labelled `label`: `{label, assignee: "me"}`, `{label, author: "me"}`
 * or `{label, repos: [path…]}`.
 * @returns {Promise<import("./index.js").SearchItem[]>}
 */
async function searchIssues(filter, token = null) {
  const q = `state=opened&labels=${encodeURIComponent(filter.label)}&order_by=updated_at&per_page=50`;
  if (filter.repos) return (await perProject(filter.repos, "issues", q, token)).map(searchItem);
  return (await request(`/issues?${q}&scope=${filter.assignee ? "assigned_to_me" : "created_by_me"}`, { token })).map(searchItem);
}

// ---- the signed-in user -----------------------------------------------------------------

/** @returns {Promise<{login: string, name: string|null, id: number, avatar: string, url: string}>} */
async function user(token, fetch = null) {
  const me = await request("/user", { token, fetch });
  return { login: me.username, name: me.name ?? null, id: me.id, avatar: me.avatar_url, url: me.web_url };
}

/** The commit author when a copy has no git identity: the account, with its private commit e-mail. */
async function gitAuthor(token) {
  const placeholder = { name: "KiVi user", email: `kivi@users.noreply.${HOST}` };
  if (!token) return placeholder;
  try {
    const me = await user(token);
    return { name: me.name || me.login, email: `${me.id}-${me.login}@users.noreply.${HOST}` };
  } catch {
    return placeholder;
  }
}

/** An avatar image at `px` pixels (Gravatar takes s=, GitLab's own width=). */
function avatar(url, px) {
  if (!url) return "";
  if (/gravatar\.com/.test(url)) return /[?&]s=\d+/.test(url) ? url.replace(/([?&]s=)\d+/, `$1${px}`) : `${url}${url.includes("?") ? "&" : "?"}s=${px}`;
  return `${url}${url.includes("?") ? "&" : "?"}width=${px}`;
}

// ---- review comments on merge requests ----------------------------------------------------
//
// A KiVi comment is a file-level diff discussion (position_type "file") on the
// .kicad_sch / .kicad_pcb file, so it shows (and can be replied to and
// resolved) on GitLab itself; what it points at travels in the body's marker
// (../review.js). Discussions come with their resolved state over REST. GitLab
// shows discussions and notes only to signed-in users (401 otherwise, public
// projects too), so signed out there are none (`readsNeedSignIn`).

/** A merge request's review threads (the ReviewThreads interface of ./index.js). */
export class GitLabReviews {
  /** @param {{owner: string, repo: string, pr: number, token?: string|null, fetch?: Function}} o */
  constructor({ owner, repo, pr, token = null, fetch: fetchFn = null }) {
    this.owner = owner;
    this.repo = repo;
    this.pr = pr;
    this.token = token;
    this.fetch = fetchFn;
    this.threads = [];
    this.viewer = null;
    this.viewerId = null;
    this.writeWhat = "merge requests";
  }

  get nwo() {
    return nwoOf(this.owner, this.repo);
  }

  get proj() {
    return `/projects/${pid(this.nwo)}`;
  }

  get canWrite() {
    return !!this.token;
  }

  /** Signed out, GitLab answers 401 for comments: the panel asks for a sign-in to read them. */
  get readsNeedSignIn() {
    return !this.token;
  }

  request(method, path, body) {
    return request(path, { method, body, token: this.token, fetch: this.fetch, writeHint: this.writeWhat });
  }

  async all(path) {
    return pages(path, this.token, { max: 30, fetch: this.fetch });
  }

  /** Who is signed in (for "mine"), once. */
  async whoAmI() {
    if (this.token && this.viewerId == null) {
      const me = await user(this.token, this.fetch);
      this.viewer = me.login;
      this.viewerId = me.id;
    }
  }

  note(n, url) {
    return comment(n.id, n.body, n.author?.username, n.author?.avatar_url, n.created_at, `${url}#note_${n.id}`, this.viewerId != null && n.author?.id === this.viewerId);
  }

  async load() {
    if (!this.token) return (this.threads = []);
    await this.whoAmI();
    const [mr, discussions] = await Promise.all([
      this.request("GET", `${this.proj}/merge_requests/${this.pr}`),
      this.all(`${this.proj}/merge_requests/${this.pr}/discussions?`),
    ]);
    const signedIn = !!this.token;
    this.threads = [];
    for (const d of discussions) {
      const notes = (d.notes ?? []).filter((n) => !n.system);
      const first = notes[0];
      // Review threads are the ones on a file; general conversation isn't pinned anywhere.
      if (!first?.position) continue;
      const comments = notes.map((n) => this.note(n, mr.web_url));
      const resolvable = !!first.resolvable;
      const resolved = resolvable ? !!first.resolved : null;
      this.threads.push({
        id: d.id,
        rootId: first.id,
        path: first.position.new_path ?? first.position.old_path,
        line: first.position.new_line ?? first.position.old_line ?? null,
        isResolved: resolved,
        isOutdated: !!(mr.diff_refs && first.position.head_sha && first.position.head_sha !== mr.diff_refs.head_sha && first.position.position_type !== "file"),
        resolvedBy: first.resolved_by?.username ?? null,
        canResolve: signedIn && resolvable && !resolved,
        canUnresolve: signedIn && resolvable && !!resolved,
        canReply: signedIn && !mr.discussion_locked,
        anchor: comments[0].anchor,
        comments,
      });
    }
    return this.threads;
  }

  /** Start a thread on `path`: a file-level discussion at the merge request's current commits. */
  async create({ path, anchor, text }) {
    const { refs } = await diffRefs(this.nwo, this.pr, this.token, this.fetch);
    const d = await this.request("POST", `${this.proj}/merge_requests/${this.pr}/discussions`, {
      body: encodeBody(text, anchor),
      position: { position_type: "file", base_sha: refs.base_sha, start_sha: refs.start_sha, head_sha: refs.head_sha, new_path: path, old_path: path },
    });
    return { ...d, id: d.notes?.[0]?.id ?? d.id };
  }

  /**
   * Repository paths the merge request changes: only these take review
   * comments (the others become issues, as on GitHub).
   * @returns {Promise<Set<string>>}
   */
  async changedFiles() {
    return new Set((await this.all(`${this.proj}/merge_requests/${this.pr}/diffs?`)).map((d) => d.new_path));
  }

  async reply(t, text) {
    return this.request("POST", `${this.proj}/merge_requests/${this.pr}/discussions/${t.id}/notes`, { body: text.trim() });
  }

  async setResolved(t, resolved) {
    const d = await this.request("PUT", `${this.proj}/merge_requests/${this.pr}/discussions/${t.id}?resolved=${resolved}`);
    t.isResolved = !!d.notes?.find((n) => n.resolvable)?.resolved;
    return t;
  }

  async remove(noteId) {
    await this.request("DELETE", `${this.proj}/merge_requests/${this.pr}/notes/${noteId}`);
  }

  /**
   * Issues of this project the merge request closes when merged: GitLab's own
   * list (closing patterns in the description and commits), else the
   * description's keywords.
   * @returns {Promise<Set<number>>}
   */
  async closingIssues() {
    try {
      const [issues, proj] = await Promise.all([this.request("GET", `${this.proj}/merge_requests/${this.pr}/closes_issues`), this.request("GET", this.proj)]);
      return new Set(issues.filter((i) => i.project_id === proj.id).map((i) => i.iid));
    } catch {
      const mr = await this.request("GET", `${this.proj}/merge_requests/${this.pr}`);
      return closingNumbers(mr.description);
    }
  }

  /** Make the merge request close issue `n` when merged: "Closes #n" at the end of its description. */
  async addClosingIssue(n) {
    const mr = await this.request("GET", `${this.proj}/merge_requests/${this.pr}`); // the description as it is now
    const body = String(mr.description ?? "").trimEnd();
    if (closingNumbers(body).has(n)) return;
    await this.request("PUT", `${this.proj}/merge_requests/${this.pr}`, { description: `${body ? `${body}\n\n` : ""}${gitlab.words.closes(n)}` });
  }
}

// ---- change requests (issues labelled "kivi") ------------------------------------------
//
// Issues come in one listing (signed out too); each one's notes when it's
// opened (`repliesPending`, `loadReplies`), signed in only.

/** A project's KiVi issues as threads (the ReviewThreads interface of ./index.js, plus `loadReplies`). */
export class GitLabIssues extends GitLabReviews {
  /** @param {{owner: string, repo: string, token?: string|null, fetch?: Function}} o */
  constructor(o) {
    super({ ...o, pr: null });
    this.writeWhat = "issues";
    this.noteIssue = new Map(); // note id → issue number, for deleting
  }

  async load() {
    await this.whoAmI();
    const signedIn = !!this.token;
    const issues = await this.all(`${this.proj}/issues?labels=${encodeURIComponent(ISSUE_LABEL)}&state=all&order_by=created_at&sort=asc`);
    this.threads = issues.map((it) => {
      // The issue itself can't be deleted from here, so it's never "mine" to delete.
      const root = comment(it.iid, it.description, it.author?.username, it.author?.avatar_url, it.created_at, it.web_url, false);
      // GitLab tells its permissions only by refusing: signed in, closing and replying are offered.
      const t = issueThread(it.id, it.iid, it.title, it.state === "closed", root, [], { canUpdate: signedIn, locked: !!it.discussion_locked, signedIn });
      const n = it.user_notes_count ?? 0;
      t.repliesPending = n > 0 && signedIn;
      if (n && !signedIn) t.repliesError = `GitLab shows its ${n} comment${n > 1 ? "s" : ""} only when you're signed in`;
      return t;
    });
    return this.threads;
  }

  /** An issue's comments (its notes, less GitLab's own "changed the label" kind). */
  async loadReplies(t) {
    await this.whoAmI();
    const notes = await this.all(`${this.proj}/issues/${t.rootId}/notes?sort=asc&order_by=created_at`);
    const url = t.comments[0].url;
    const replies = notes.filter((n) => !n.system).map((n) => (this.noteIssue.set(n.id, t.rootId), this.note(n, url)));
    t.comments = [t.comments[0], ...replies];
    t.repliesPending = false;
    return t;
  }

  /**
   * Open an issue on `path` (repository path) at `commit`, labelled "kivi".
   * @returns {Promise<{id: number, labelled: boolean, url: string}>}
   */
  async create({ path, commitId, anchor, text, title }) {
    await this.ensureLabel();
    const issue = await this.request("POST", `${this.proj}/issues`, {
      title: title.trim(),
      description: encodeBody(text.trim() || "_No description._", { ...anchor, file: path, ...(commitId && { commit: commitId }) }),
      labels: ISSUE_LABEL,
    });
    return { id: issue.iid, labelled: (issue.labels ?? []).includes(ISSUE_LABEL), url: issue.web_url };
  }

  /** Create the label once per project (409 = it exists; 403 = no access, GitLab then creates it plain, or not). */
  async ensureLabel() {
    try {
      await this.request("POST", `${this.proj}/labels`, { name: ISSUE_LABEL, color: `#${LABEL_COLOUR}`, description: LABEL_DESCRIPTION });
    } catch (e) {
      if (e.status !== 409 && e.status !== 403 && e.status !== 404) throw e;
    }
  }

  async reply(t, text) {
    const n = await this.request("POST", `${this.proj}/issues/${t.rootId}/notes`, { body: text.trim() });
    this.noteIssue.set(n.id, t.rootId);
    return n;
  }

  /** Resolved = closed; unresolving reopens it. */
  async setResolved(t, resolved) {
    const issue = await this.request("PUT", `${this.proj}/issues/${t.rootId}`, { state_event: resolved ? "close" : "reopen" });
    t.isResolved = issue.state === "closed";
    return t;
  }

  async remove(noteId) {
    const iid = this.noteIssue.get(noteId);
    if (!iid) throw new Error("Reload the comments, then try again");
    await this.request("DELETE", `${this.proj}/issues/${iid}/notes/${noteId}`);
  }
}

// ---- the forge ------------------------------------------------------------------------

/** @type {import("./index.js").Forge} */
export const gitlab = {
  id: "gitlab",
  name: "GitLab",
  host: HOST,
  hashKey: "gl", // index.html#gl=group/project@ref:dir, diff.html#gl=group/project&pr=…
  words: {
    pr: "merge request",
    prs: "merge requests",
    prShort: "MR",
    prRef: (n) => `!${n}`,
    closes: (n) => `Closes #${n}`,
  },

  parseSpec,
  ownsUrl: (url) => /^https?:\/\/(www\.)?gitlab\.com\//i.test(url),

  open,
  source: (o) => new GitLabSource(o),
  repo: repoOf,
  listRepos,
  tree,
  branches,
  commits,
  compare,
  pullRequest,
  pullFiles,
  searchPullRequests,
  searchIssues,

  reviews: (o) => new GitLabReviews(o),
  issues: (o) => new GitLabIssues(o),

  user,
  gitAuthor,
  avatar,

  /**
   * Signing in: an OAuth application on gitlab.com with the device grant
   * (GitLab 17.9+). Tokens last 2 hours; the refresh token changes on every use.
   */
  auth: {
    deviceUrl: `${WEB}/oauth/authorize_device`,
    tokenUrl: `${WEB}/oauth/token`,
    scope: "api write_repository",
    appName: "OAuth application",
    idLabel: "Application ID",
    idPlaceholder: "Application ID",
    clientIdKey: "gitlabClientId",
    buildEnv: "KIVI_GITLAB_CLIENT_ID",
    registerUrl: `${WEB}/-/user_settings/applications`,
    registerHint: "with the scopes <em>api</em> and <em>write_repository</em> and <em>Confidential</em> unticked",
    unknownClient: (res) => res.error === "invalid_client",
    explain: (res) =>
      res.error === "invalid_scope"
        ? "the OAuth application needs the api and write_repository scopes"
        : res.error === "unauthorized_client"
          ? "the OAuth application can't use the device flow: untick Confidential in its settings"
          : null,
    refreshRejected: (res) => res.error === "invalid_grant",
  },

  /** gitlab.com pages KiVi links to. */
  web: {
    repo: (nwo) => `${WEB}/${nwo}`,
    /** A folder of a branch (no branch: the project's front page). */
    tree: (nwo, branch = null, dir = "") => `${WEB}/${nwo}${branch ? `/-/tree/${encPath(branch)}${dir ? `/${encPath(dir)}` : ""}` : ""}`,
    /** Where a pushed branch's merge request is opened. */
    compare: (nwo, branch) => `${WEB}/${nwo}/-/merge_requests/new?${encodeURIComponent("merge_request[source_branch]")}=${encodeURIComponent(branch)}`,
    newRepo: `${WEB}/projects/new`,
  },
};
