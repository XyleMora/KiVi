// The GitHub adapter: every request KiVi makes to GitHub's REST and GraphQL
// APIs, raw.githubusercontent.com, and every github.com page address it links
// to. The rest of the app reaches GitHub only through the `github` forge
// object below (the interface is described in ./index.js), and gets back
// forge-neutral shapes: RepoInfo, PullRequest, ChangedFile, Comparison,
// SearchItem and the review/issue thread shape of ../review.js.
//
// No DOM and no Tauri: this runs under gjs (tests/review.js) and in pages.

import { COMPARED, SOURCE_FILES } from "../project.js";
import { ISSUE_LABEL, LABEL_COLOUR, LABEL_DESCRIPTION, closingNumbers, comment, encodeBody, issueThread } from "../review.js";

const API = "https://api.github.com";
const WEB = "https://github.com";
const FULL_SHA = /^[0-9a-f]{40}$/i;
const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");

// ---- requests ------------------------------------------------------------------------

/**
 * One GitHub API request. `writeHint` (what a refused write needs access to,
 * e.g. "pull requests") turns 401/403/404/422 into the review panel's
 * explanations; without it errors say "GitHub <status>: <message>".
 * @returns {Promise<any>} the JSON reply (null for 204)
 */
async function request(path, { token = null, method = "GET", body, fetch: fetchFn = null, writeHint = null } = {}) {
  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const doFetch = fetchFn ?? ((...a) => globalThis.fetch(...a));
  const r = await doFetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 204) return null;
  if (r.ok) return r.json();
  const data = await r.json().catch(() => ({}));
  throw writeHint ? githubError(r.status, data, r.headers, writeHint) : readError(r, data);
}

function readError(r, data) {
  const msg = r.status === 403 && r.headers?.get?.("x-ratelimit-remaining") === "0" ? "GitHub API rate limit reached — sign in to GitHub for a higher limit" : data.message || r.statusText;
  const err = new Error(`GitHub ${r.status}: ${msg}`);
  err.status = r.status;
  return err;
}

/**
 * One entry of a 422's `errors`: a string, or {resource, field, code} with a
 * `message` only for code "custom", so the others are spelt out
 * ("PullRequestReviewComment path invalid") instead of "[object Object]".
 * A message that doesn't name its field ("could not be resolved") gets it.
 */
function validationError(e) {
  if (typeof e !== "object" || e === null) return String(e);
  if (e.message) return e.field && !e.message.includes(e.field) ? `${e.field} ${e.message}` : e.message;
  return [e.resource, e.field, e.code].filter(Boolean).join(" ") || JSON.stringify(e);
}

function githubError(status, data, headers, what) {
  let msg = data?.message || `HTTP ${status}`;
  if (status === 403 && headers?.get?.("x-ratelimit-remaining") === "0") msg = "API rate limit reached — sign in to GitHub for a higher limit";
  else if (status === 401) msg = "GitHub ended the sign-in; sign in again";
  else if (status === 403 || status === 404) msg += ` — the token needs write access to ${what}`;
  else if (status === 422 && data?.errors?.length) msg += `: ${data.errors.map(validationError).join("; ")}`;
  const err = new Error(`GitHub ${status}: ${msg}`);
  err.status = status;
  return err;
}

/** All pages of a listing of 100 per page (capped at `max` pages); `key` picks the list out of an object reply. */
async function pages(path, token, { key = null, max = 10 } = {}) {
  const out = [];
  for (let page = 1; page <= max; page++) {
    const res = await request(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, { token });
    const items = key ? res[key] : res;
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

// ---- shapes --------------------------------------------------------------------------

/** @returns {import("./index.js").RepoInfo} */
const repoInfo = (r) => ({
  nwo: r.full_name,
  defaultBranch: r.default_branch,
  pushedAt: r.pushed_at,
  private: !!r.private,
  archived: !!r.archived,
  disabled: !!r.disabled,
  url: r.html_url,
});

/** @returns {import("./index.js").ChangedFile} */
const changedFile = (f) => ({
  path: f.filename,
  previous: f.previous_filename ?? f.filename,
  status: f.status,
  patch: f.patch ?? null,
  // The commit the file was listed at (the pull request's head), for reading it.
  ref: /[?&]ref=([^&]+)/.exec(f.contents_url ?? "")?.[1] ?? null,
});

const commitEntry = (c) => ({
  sha: c.sha,
  summary: c.commit.message.split("\n")[0],
  author: c.commit.author?.name ?? c.author?.login ?? "",
  time: Date.parse(c.commit.author?.date ?? c.commit.committer?.date) / 1000,
});

/** A search hit (pull request or issue) → SearchItem. */
const searchItem = (it) => ({
  nwo: it.repository_url.split("/").slice(-2).join("/"),
  number: it.number,
  title: it.title,
  body: it.body ?? "",
  draft: !!it.draft,
  author: it.user?.login ?? "ghost",
  avatar: it.user?.avatar_url ?? null,
  updatedAt: it.updated_at,
  comments: it.comments ?? 0,
  url: it.html_url,
});

// ---- specs ---------------------------------------------------------------------------

/**
 * Parse github.com URLs and shorthands:
 *   owner/repo, owner/repo@ref, owner/repo@ref:path,
 *   https://github.com/owner/repo[/tree|blob/<ref>/<path>]
 * Refs containing "/" are resolved later against the API (`rest`).
 */
function parseSpec(spec) {
  spec = spec.trim();
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/(tree|blob)\/(.+?))?\/?(?:[?#].*)?$/.exec(spec);
  if (m) return { owner: m[1], repo: m[2], rest: m[4] ? decodeURIComponent(m[4]) : null, kind: m[3] ?? null };
  m = /^([\w.-]+)\/([\w.-]+)(?:@([^:]+))?(?::(.*))?$/.exec(spec);
  if (m) return { owner: m[1], repo: m[2], ref: m[3] ?? null, path: m[4] ?? "", rest: null };
  return null;
}

// ---- files of a repository -------------------------------------------------------------

/** A repository at a branch or commit, read through the API (signed in) or the raw CDN (public). */
export class GitHubSource {
  constructor({ owner, repo, ref, path = "", token = null, sha = null }) {
    this.kind = "github";
    this.forge = github;
    this.owner = owner;
    this.repo = repo;
    this.ref = ref;
    this.sha = sha;
    this.path = path; // sub-directory or file the user pointed at
    this.token = token;
    this.label = `${owner}/${repo}@${ref}${path ? `:${path}` : ""}`;
    this._list = null;
  }

  /** Directory the listing is restricted to ("" = whole repository). */
  get dir() {
    const p = this.path.replace(/\/+$/, "");
    return SOURCE_FILES.test(p) ? p.slice(0, Math.max(0, p.lastIndexOf("/"))) : p;
  }

  async list() {
    if (!this._list) {
      // "<ref>:<dir>" lists just a sub-tree, which keeps huge repositories manageable.
      const dir = this.dir;
      const rev = encodeURIComponent(this.sha ?? this.ref) + (dir ? ":" + encPath(dir) : "");
      let tree;
      try {
        tree = await request(`/repos/${this.owner}/${this.repo}/git/trees/${rev}?recursive=1`, { token: this.token });
      } catch (e) {
        // The folder isn't in this commit (moved, or a mangled link): list the whole repository instead.
        if (!(dir && e.status === 404)) throw e;
        tree = await request(`/repos/${this.owner}/${this.repo}/git/trees/${encodeURIComponent(this.sha ?? this.ref)}?recursive=1`, { token: this.token });
        console.warn(`${dir} not found in ${this.ref}; listing the whole repository`);
        this.path = "";
        this.label = `${this.owner}/${this.repo}@${this.ref}`;
      }
      const listed = this.dir;
      this.truncated = !!tree.truncated;
      const paths = tree.tree.filter((e) => e.type === "blob").map((e) => (listed ? `${listed}/${e.path}` : e.path));
      this._list = paths.filter((p) => SOURCE_FILES.test(p));
    }
    return this._list;
  }

  has(path) {
    return !!this._list?.includes(path);
  }

  rawUrl(path) {
    return `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${encodeURIComponent(this.sha ?? this.ref)}/${encPath(path)}`;
  }

  async fetchFile(path) {
    const rev = encodeURIComponent(this.sha ?? this.ref);
    let r;
    if (this.token) {
      // Private with token: contents API with the raw media type.
      r = await fetch(`${API}/repos/${this.owner}/${this.repo}/contents/${encPath(path)}?ref=${rev}`, {
        headers: { Accept: "application/vnd.github.raw", Authorization: `Bearer ${this.token}` },
      });
    } else {
      // Public: raw CDN (no API rate limit).
      r = await fetch(this.rawUrl(path));
    }
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r;
  }

  async readText(path) {
    const text = await (await this.fetchFile(path)).text();
    if (text.startsWith("version https://git-lfs")) throw new Error(`${path} is stored in Git LFS, which is not supported yet`);
    return text;
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
  if (!p) throw new Error("Not a GitHub repository URL");
  let ref = p.ref, path = p.path ?? "";
  if (p.rest) {
    // "<ref>/<path>": the shortest ref that exists (shortest first is cheaper).
    const parts = p.rest.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const cand = parts.slice(0, i).join("/");
      try {
        const c = await request(`/repos/${p.owner}/${p.repo}/commits/${encodeURIComponent(cand)}`, { token });
        return new GitHubSource({ owner: p.owner, repo: p.repo, ref: cand, path: parts.slice(i).join("/"), token, sha: c.sha });
      } catch (e) {
        if (e.status && e.status !== 404 && e.status !== 422) throw e;
      }
    }
    throw new Error(`Could not resolve branch/commit in "${p.rest}"`);
  }
  if (!ref) ref = (await request(`/repos/${p.owner}/${p.repo}`, { token })).default_branch;
  // "HEAD" is the default branch: show its name if the API can tell (it can't
  // for a private repository without a token, which still opens as HEAD).
  else if (ref === "HEAD") ref = (await request(`/repos/${p.owner}/${p.repo}`, { token }).catch(() => null))?.default_branch ?? ref;
  return new GitHubSource({ owner: p.owner, repo: p.repo, ref, path, token });
}

// ---- comparisons -----------------------------------------------------------------------

/** Files that differ between two commits, from their trees (the compare API only measures from the merge base). */
async function treeDiff(token, owner, repo, a, b) {
  const blobs = async (sha) => {
    const t = await request(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`, { token });
    if (t.truncated) throw new Error("Repository too large to compare these two commits directly; pick a branch as the base instead");
    return new Map(t.tree.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));
  };
  const [before, after] = await Promise.all([blobs(a), blobs(b)]);
  const files = [];
  for (const [path, sha] of after) if (before.get(path) !== sha) files.push({ filename: path, status: before.has(path) ? "modified" : "added" });
  for (const path of before.keys()) if (!after.has(path)) files.push({ filename: path, status: "removed" });
  return files;
}

/**
 * Resolve what to compare:
 *   {owner, repo, pr: 42}                   pull request (base = merge base, like GitHub)
 *   {owner, repo, commit: "<sha>"}          commit against its first parent
 *   {owner, repo, base: "main", head: "x"}  any two refs: from where head left a base branch
 *                                           (three-dot, like a pull request); a base commit
 *                                           (full SHA) as it is; no base = the default branch
 * Only KiCad files the visual diff compares are listed.
 * @returns {Promise<import("./index.js").Comparison>}
 */
async function compare(spec, token = null) {
  const { owner, repo } = spec;
  const api = (p) => request(p, { token });
  let base, head, files, title, url;
  if (spec.pr) {
    const pr = await pullRequest(owner, repo, spec.pr, token);
    head = { owner: pr.head.owner, repo: pr.head.repo, sha: pr.head.sha, ref: pr.head.ref };
    // Diff against the merge base so unrelated base-branch changes don't show up.
    const cmp = await api(`/repos/${owner}/${repo}/compare/${pr.base.sha}...${pr.head.sha}`).catch(() => null);
    base = { owner, repo, sha: cmp?.merge_base_commit?.sha ?? pr.base.sha, ref: pr.base.ref };
    files = await pullFiles(owner, repo, spec.pr, token);
    title = `#${pr.number} ${pr.title}`;
    url = pr.url;
  } else if (spec.commit) {
    const c = await api(`/repos/${owner}/${repo}/commits/${encodeURIComponent(spec.commit)}`);
    head = { owner, repo, sha: c.sha, ref: c.sha.slice(0, 7) };
    const parent = c.parents[0]?.sha;
    base = { owner, repo, sha: parent ?? null, ref: parent ? parent.slice(0, 7) : "(none)" };
    files = (c.files ?? []).map(changedFile);
    title = c.commit.message.split("\n")[0];
    url = c.html_url;
  } else {
    const baseRef = spec.base || (await api(`/repos/${owner}/${repo}`)).default_branch;
    // The same branch on both sides (e.g. the viewer's Visual diff on the default branch): its latest commit.
    if (baseRef === spec.head) return compare({ owner, repo, commit: spec.head }, token);
    const cmp = await api(`/repos/${owner}/${repo}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(spec.head)}`);
    const short = (r) => (FULL_SHA.test(r) ? r.slice(0, 7) : r);
    const headSha = cmp.commits.at(-1)?.sha ?? (FULL_SHA.test(spec.head) ? spec.head : (await api(`/repos/${owner}/${repo}/commits/${encodeURIComponent(spec.head)}`)).sha);
    base = { owner, repo, sha: cmp.merge_base_commit.sha, ref: short(baseRef) };
    head = { owner, repo, sha: headSha, ref: short(spec.head) };
    files = (cmp.files ?? []).map(changedFile);
    // A commit that isn't where the head left it (on another branch, or newer): compared as it is.
    if (FULL_SHA.test(baseRef) && cmp.merge_base_commit.sha !== baseRef) {
      base.sha = baseRef;
      files = (await treeDiff(token, owner, repo, baseRef, headSha)).map(changedFile);
    }
    title = `${base.ref} → ${head.ref}`;
    url = cmp.html_url;
  }
  files = files.filter((f) => COMPARED(f.path) || COMPARED(f.previous)).map((f) => ({ path: f.path, previous: f.previous, status: f.status }));
  return { base, head, files, title, url };
}

// ---- repositories, branches, commits, pull requests -----------------------------------

async function repoOf(nwo, token = null) {
  return repoInfo(await request(`/repos/${nwo}`, { token }));
}

/**
 * Repositories for the gallery: signed in, exactly those the GitHub App is
 * installed on (and the user can see); then the watched ones. `hidden` are
 * lower-case names left out.
 * @returns {Promise<import("./index.js").RepoInfo[]>}
 */
async function listRepos(token, { watched = [], hidden = new Set() } = {}) {
  const repos = new Map();
  const add = (r) => r && !r.disabled && !hidden.has(r.nwo.toLowerCase()) && repos.set(r.nwo, r);
  if (token) {
    for (const inst of await pages("/user/installations", token, { key: "installations" }))
      for (const r of await pages(`/user/installations/${inst.id}/repositories`, token, { key: "repositories" })) add(repoInfo(r));
  }
  for (const nwo of watched) if (!repos.has(nwo) && !hidden.has(nwo.toLowerCase())) add(await repoOf(nwo, token).catch(() => null));
  return [...repos.values()];
}

/**
 * Every file of a branch (one request): [{path, sha, size}], plus whether
 * GitHub cut the listing short. An empty repository has no files.
 */
async function tree(nwo, ref, token = null) {
  let t;
  try {
    t = await request(`/repos/${nwo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { token });
  } catch (e) {
    if (e.status !== 409) throw e; // 409: empty repository
    t = { tree: [] };
  }
  return { files: t.tree.filter((e) => e.type === "blob").map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 })), truncated: !!t.truncated };
}

async function branches(owner, repo, token = null) {
  return (await pages(`/repos/${owner}/${repo}/branches`, token, { max: 5 })).map((b) => ({ name: b.name }));
}

/** `count` commits of `ref` from `offset` (a multiple of `count`), newest first. */
async function commits(owner, repo, ref, offset, count, token = null) {
  const page = Math.floor(offset / count) + 1;
  const batch = await request(`/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(ref)}&per_page=${count}&page=${page}`, { token });
  return batch.map(commitEntry);
}

/** @returns {Promise<import("./index.js").PullRequest>} */
async function pullRequest(owner, repo, number, token = null) {
  const pr = await request(`/repos/${owner}/${repo}/pulls/${number}`, { token });
  const fork = pr.head.repo && pr.head.repo.owner.login !== owner;
  return {
    owner, repo,
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    url: pr.html_url,
    base: { owner, repo, sha: pr.base.sha, ref: pr.base.ref },
    // A deleted fork: the base repository still has the head's commits.
    head: {
      owner: pr.head.repo?.owner.login ?? owner,
      repo: pr.head.repo?.name ?? repo,
      sha: pr.head.sha,
      ref: pr.head.ref,
      label: fork ? pr.head.label : pr.head.ref, // fork branches read "owner:branch", as on GitHub
    },
  };
}

/** The files a pull request changes (up to `max` pages of 100). */
async function pullFiles(owner, repo, number, token = null, { max = 30 } = {}) {
  return (await pages(`/repos/${owner}/${repo}/pulls/${number}/files`, token, { max })).map(changedFile);
}

// ---- search (the home page's lists) --------------------------------------------------

const MAX_Q = 250; // GitHub's search rejects queries over 256 characters

/** `base` plus `repo:` qualifiers, split into as few queries as fit. */
function repoQueries(base, repos) {
  const out = [];
  let q = base;
  for (const r of repos) {
    if (q !== base && q.length + r.length + 6 > MAX_Q) {
      out.push(q);
      q = base;
    }
    q += ` repo:${r}`;
  }
  if (q !== base) out.push(q);
  return out;
}

async function search(queries, perPage, token) {
  const out = [];
  // Spelt out rather than URLSearchParams, which gjs (the tests) doesn't have.
  for (const q of queries) out.push(...(await request(`/search/issues?q=${encodeURIComponent(q)}&sort=updated&per_page=${perPage}`, { token })).items);
  return out.map(searchItem);
}

/**
 * Open pull requests, most recently updated first: `{reviewRequested: true}`
 * (waiting for the user's review), `{author: "me"}`, or `{repos: [nwo…]}`.
 * @returns {Promise<import("./index.js").SearchItem[]>}
 */
function searchPullRequests(filter, token = null) {
  if (filter.repos) return search([`is:pr is:open ${filter.repos.map((r) => `repo:${r}`).join(" ")}`], 30, token);
  const who = filter.reviewRequested ? "review-requested:@me" : "author:@me";
  return search([`is:pr is:open archived:false ${who}`], 30, token);
}

/**
 * Open issues labelled `label`: `{label, assignee: "me"}`, `{label, author: "me"}`
 * or `{label, repos: [nwo…]}` (any number of repositories).
 * @returns {Promise<import("./index.js").SearchItem[]>}
 */
function searchIssues(filter, token = null) {
  const base = `is:issue is:open archived:false label:${filter.label}`;
  if (filter.repos) return search(repoQueries(base, filter.repos), 50, token);
  return search([`${base} ${filter.assignee ? "assignee:@me" : "author:@me"}`], 50, token);
}

// ---- the signed-in user -----------------------------------------------------------------

/** @returns {Promise<{login: string, name: string|null, id: number, avatar: string, url: string}>} */
async function user(token) {
  const me = await request("/user", { token });
  return { login: me.login, name: me.name ?? null, id: me.id, avatar: me.avatar_url, url: me.html_url };
}

const NOREPLY = "kivi@users.noreply.github.com";

/** The commit author when a copy has no git identity: the account, with its private e-mail. */
async function gitAuthor(token) {
  if (!token) return { name: "KiVi user", email: NOREPLY };
  try {
    const me = await user(token);
    return { name: me.name || me.login, email: `${me.id}+${me.login}@users.noreply.github.com` };
  } catch {
    return { name: "KiVi user", email: NOREPLY };
  }
}

/** Whether the GitHub App is installed anywhere this user can see; null when GitHub can't tell. */
async function hasAppInstallation(token) {
  try {
    return (await request("/user/installations?per_page=1", { token })).total_count > 0;
  } catch {
    return null;
  }
}

/** An avatar image at `px` pixels. */
const avatar = (url, px) => (url ? `${url}${url.includes("?") ? "&" : "?"}s=${px}` : "");

// ---- review comments on pull requests ----------------------------------------------------
//
// Every KiVi comment is an ordinary file-level review comment on the
// .kicad_sch / .kicad_pcb file, so it shows up (and can be replied to and
// resolved) on GitHub itself; what it points at travels in the body's marker
// (../review.js). Threads are read through GraphQL (the REST API has no
// resolved state); without signing in only public repositories can be read,
// through REST, and resolve state is unknown. Writing always needs a sign-in.

const THREADS_QUERY = `query($owner: String!, $repo: String!, $pr: Int!, $after: String) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path subjectType line
          viewerCanResolve viewerCanUnresolve viewerCanReply
          resolvedBy { login }
          comments(first: 100) {
            nodes { databaseId body createdAt url viewerDidAuthor author { login avatarUrl } }
          }
        }
      }
    }
  }
}`;

const CLOSING_QUERY = `query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) { closingIssuesReferences(first: 50) { nodes { number repository { nameWithOwner } } } }
  }
}`;

/** A pull request's review threads (the ReviewThreads interface of ./index.js). */
export class GitHubReviews {
  /** @param {{owner: string, repo: string, pr: number, token?: string|null, fetch?: Function}} o */
  constructor({ owner, repo, pr, token = null, fetch: fetchFn = null }) {
    this.owner = owner;
    this.repo = repo;
    this.pr = pr;
    this.token = token;
    this.fetch = fetchFn;
    this.threads = [];
    this.viewer = null;
    this.writeWhat = "pull requests"; // what a refused write needs access to
  }

  get canWrite() {
    return !!this.token;
  }

  request(method, path, body) {
    return request(path, { method, body, token: this.token, fetch: this.fetch, writeHint: this.writeWhat });
  }

  async graphql(query, variables) {
    const data = await this.request("POST", "/graphql", { query, variables });
    if (data.errors?.length) {
      const e = data.errors[0];
      const err = new Error(`GitHub: ${e.message}`);
      err.type = e.type;
      throw err;
    }
    return data.data;
  }

  /** Load all threads. */
  async load() {
    this.threads = this.token ? await this.loadGraphql() : await this.loadRest();
    return this.threads;
  }

  async loadGraphql() {
    const out = [];
    let after = null;
    for (let page = 0; page < 40; page++) {
      const d = await this.graphql(THREADS_QUERY, { owner: this.owner, repo: this.repo, pr: this.pr, after });
      this.viewer = d.viewer?.login ?? null;
      const rt = d.repository?.pullRequest?.reviewThreads;
      if (!rt) break;
      for (const n of rt.nodes) {
        const comments = n.comments.nodes.map((c) => comment(c.databaseId, c.body, c.author?.login, c.author?.avatarUrl, c.createdAt, c.url, c.viewerDidAuthor));
        if (!comments.length) continue;
        out.push({
          id: n.id,
          rootId: comments[0].id,
          path: n.path,
          line: n.line,
          isResolved: n.isResolved,
          isOutdated: n.isOutdated,
          resolvedBy: n.resolvedBy?.login ?? null,
          canResolve: n.viewerCanResolve,
          canUnresolve: n.viewerCanUnresolve,
          canReply: n.viewerCanReply,
          anchor: comments[0].anchor,
          comments,
        });
      }
      if (!rt.pageInfo.hasNextPage) break;
      after = rt.pageInfo.endCursor;
    }
    return out;
  }

  /** Read-only fallback: REST comments grouped into threads, resolve state unknown. */
  async loadRest() {
    const all = [];
    for (let page = 1; page <= 30; page++) {
      const batch = await this.request("GET", `/repos/${this.owner}/${this.repo}/pulls/${this.pr}/comments?per_page=100&page=${page}`);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    const roots = new Map();
    for (const c of all) {
      if (c.in_reply_to_id) continue;
      const cm = comment(c.id, c.body, c.user?.login, c.user?.avatar_url, c.created_at, c.html_url, false);
      roots.set(c.id, { id: null, rootId: c.id, path: c.path, line: c.line ?? null, isResolved: null, isOutdated: c.position === null && c.subject_type !== "file", resolvedBy: null, canResolve: false, canUnresolve: false, canReply: false, anchor: cm.anchor, comments: [cm] });
    }
    for (const c of all) {
      if (!c.in_reply_to_id) continue;
      roots.get(c.in_reply_to_id)?.comments.push(comment(c.id, c.body, c.user?.login, c.user?.avatar_url, c.created_at, c.html_url, false));
    }
    return [...roots.values()];
  }

  /** Start a thread on `path` at `commitId` (the head commit the anchor was placed on). */
  async create({ path, commitId, anchor, text }) {
    return this.request("POST", `/repos/${this.owner}/${this.repo}/pulls/${this.pr}/comments`, {
      body: encodeBody(text, anchor),
      commit_id: commitId,
      path,
      subject_type: "file",
    });
  }

  /**
   * Repository paths the pull request changes: GitHub takes review comments
   * only on these ("path could not be resolved" on any other file).
   * @returns {Promise<Set<string>>}
   */
  async changedFiles() {
    const out = new Set();
    for (let page = 1; ; page++) {
      const batch = await this.request("GET", `/repos/${this.owner}/${this.repo}/pulls/${this.pr}/files?per_page=100&page=${page}`);
      for (const f of batch) out.add(f.filename);
      if (batch.length < 100) return out;
    }
  }

  async reply(thread, text) {
    return this.request("POST", `/repos/${this.owner}/${this.repo}/pulls/${this.pr}/comments/${thread.rootId}/replies`, { body: text.trim() });
  }

  async setResolved(thread, resolved) {
    if (!thread.id) throw new Error("Resolving needs a GitHub token");
    const op = resolved ? "resolveReviewThread" : "unresolveReviewThread";
    const d = await this.graphql(`mutation($id: ID!) { ${op}(input: {threadId: $id}) { thread { id isResolved } } }`, { id: thread.id });
    thread.isResolved = d[op].thread.isResolved;
    return thread;
  }

  async remove(commentId) {
    await this.request("DELETE", `/repos/${this.owner}/${this.repo}/pulls/comments/${commentId}`);
  }

  /**
   * Issues of this repository the pull request closes when merged: GitHub's
   * own list signed in (keywords and manual links), else the closing keywords
   * of its description ("Fixes #12").
   * @returns {Promise<Set<number>>}
   */
  async closingIssues() {
    if (this.token) {
      const d = await this.graphql(CLOSING_QUERY, { owner: this.owner, repo: this.repo, pr: this.pr });
      const nwo = `${this.owner}/${this.repo}`.toLowerCase();
      const nodes = d.repository?.pullRequest?.closingIssuesReferences?.nodes ?? [];
      return new Set(nodes.filter((n) => n.repository?.nameWithOwner?.toLowerCase() === nwo).map((n) => n.number));
    }
    const pr = await this.request("GET", `/repos/${this.owner}/${this.repo}/pulls/${this.pr}`);
    return closingNumbers(pr.body);
  }

  /** Make the pull request close issue `n` when merged: "Fixes #n" at the end of its description. */
  async addClosingIssue(n) {
    const pr = await this.request("GET", `/repos/${this.owner}/${this.repo}/pulls/${this.pr}`); // the description as it is now
    const body = String(pr.body ?? "").trimEnd();
    if (closingNumbers(body).has(n)) return;
    await this.request("PATCH", `/repos/${this.owner}/${this.repo}/pulls/${this.pr}`, { body: `${body ? `${body}\n\n` : ""}${github.words.closes(n)}` });
  }
}

// ---- change requests (issues labelled "kivi") ------------------------------------------
//
// Signed in, one GraphQL request reads issues with their comments; signed out,
// REST reads the issues of public repositories and each one's comments when
// it's opened (`repliesPending`, `loadReplies`).

const ISSUES_QUERY = `query($owner: String!, $repo: String!, $label: String!, $after: String) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    issues(first: 50, after: $after, labels: [$label], orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id number title body state createdAt url locked viewerCanUpdate viewerDidAuthor author { login avatarUrl }
        comments(first: 100) {
          nodes { databaseId body createdAt url viewerDidAuthor author { login avatarUrl } }
        }
      }
    }
  }
}`;

/** A repository's KiVi issues as threads (the ReviewThreads interface of ./index.js, plus `loadReplies`). */
export class GitHubIssues extends GitHubReviews {
  /** @param {{owner: string, repo: string, token?: string|null, fetch?: Function}} o */
  constructor(o) {
    super({ ...o, pr: null });
    this.writeWhat = "issues";
  }

  async loadGraphql() {
    const out = [];
    let after = null;
    for (let page = 0; page < 40; page++) {
      const d = await this.graphql(ISSUES_QUERY, { owner: this.owner, repo: this.repo, label: ISSUE_LABEL, after });
      this.viewer = d.viewer?.login ?? null;
      const conn = d.repository?.issues;
      if (!conn) break;
      for (const n of conn.nodes) {
        // The issue itself can't be deleted from here, so it's never "mine" to delete.
        const root = comment(n.number, n.body, n.author?.login, n.author?.avatarUrl, n.createdAt, n.url, false);
        const replies = n.comments.nodes.map((c) => comment(c.databaseId, c.body, c.author?.login, c.author?.avatarUrl, c.createdAt, c.url, c.viewerDidAuthor));
        out.push(issueThread(n.id, n.number, n.title, n.state === "CLOSED", root, replies, { canUpdate: n.viewerCanUpdate, locked: n.locked, signedIn: true }));
      }
      if (!conn.pageInfo.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    return out;
  }

  /** Read-only: the issues (no pull requests) of a public repository; replies come with `loadReplies`. */
  async loadRest() {
    const out = [];
    for (let page = 1; page <= 30; page++) {
      const batch = await this.request("GET", `/repos/${this.owner}/${this.repo}/issues?labels=${ISSUE_LABEL}&state=all&sort=created&direction=asc&per_page=100&page=${page}`);
      for (const it of batch) {
        if (it.pull_request) continue;
        const root = comment(it.number, it.body, it.user?.login, it.user?.avatar_url, it.created_at, it.html_url, false);
        const t = issueThread(null, it.number, it.title, it.state === "closed", root, [], { signedIn: false });
        t.repliesPending = it.comments > 0;
        out.push(t);
      }
      if (batch.length < 100) break;
    }
    return out;
  }

  /** An issue's comments, for threads read through REST (`repliesPending`). */
  async loadReplies(t) {
    const all = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.request("GET", `/repos/${this.owner}/${this.repo}/issues/${t.rootId}/comments?per_page=100&page=${page}`);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    t.comments = [t.comments[0], ...all.map((c) => comment(c.id, c.body, c.user?.login, c.user?.avatar_url, c.created_at, c.html_url, false))];
    t.repliesPending = false;
    return t;
  }

  /**
   * Open an issue on `path` (repository path) at `commit`, labelled "kivi".
   * @returns {Promise<{id: number, labelled: boolean, url: string}>} labelled: GitHub drops the
   *   label for people without write access, and KiVi then can't list the issue
   */
  async create({ path, commitId, anchor, text, title }) {
    await this.ensureLabel();
    const issue = await this.request("POST", `/repos/${this.owner}/${this.repo}/issues`, {
      title: title.trim(),
      body: encodeBody(text.trim() || "_No description._", { ...anchor, file: path, ...(commitId && { commit: commitId }) }),
      labels: [ISSUE_LABEL],
    });
    return { id: issue.number, labelled: (issue.labels ?? []).some((l) => (l.name ?? l) === ISSUE_LABEL), url: issue.html_url };
  }

  /** Create the label once per repository (422 = it exists; 403 = no write access, the label is dropped). */
  async ensureLabel() {
    try {
      await this.request("POST", `/repos/${this.owner}/${this.repo}/labels`, { name: ISSUE_LABEL, color: LABEL_COLOUR, description: LABEL_DESCRIPTION });
    } catch (e) {
      if (e.status !== 422 && e.status !== 403 && e.status !== 404) throw e;
    }
  }

  async reply(t, text) {
    return this.request("POST", `/repos/${this.owner}/${this.repo}/issues/${t.rootId}/comments`, { body: text.trim() });
  }

  /** Resolved = closed as completed; unresolving reopens it. */
  async setResolved(t, resolved) {
    const issue = await this.request("PATCH", `/repos/${this.owner}/${this.repo}/issues/${t.rootId}`, resolved ? { state: "closed", state_reason: "completed" } : { state: "open", state_reason: "reopened" });
    t.isResolved = issue.state === "closed";
    return t;
  }

  async remove(commentId) {
    await this.request("DELETE", `/repos/${this.owner}/${this.repo}/issues/comments/${commentId}`);
  }
}

// ---- the forge ------------------------------------------------------------------------

/** @type {import("./index.js").Forge} */
export const github = {
  id: "github",
  name: "GitHub",
  host: "github.com",
  hashKey: "gh", // index.html#gh=owner/repo@ref:dir, diff.html#gh=owner/repo&pr=…
  /** How the forge names things, for UI text. */
  words: {
    pr: "pull request",
    prs: "pull requests",
    prShort: "PR",
    /** A pull request's reference ("#12"). */
    prRef: (n) => `#${n}`,
    /** What a description says to close an issue on merge. */
    closes: (n) => `Fixes #${n}`,
  },

  parseSpec,
  /** Whether an http(s) address is on this forge (a 3D model source may be any URL). */
  ownsUrl: (url) => /^https?:\/\/(www\.)?github\.com\//i.test(url),

  open,
  source: (o) => new GitHubSource(o),
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

  reviews: (o) => new GitHubReviews(o),
  issues: (o) => new GitHubIssues(o),

  user,
  gitAuthor,
  avatar,
  hasAppInstallation,

  /**
   * Signing in: a GitHub App with device flow (src/desktop/tauri.js runs the
   * steps). Its user tokens (ghu_…) last 8 hours and come with a single-use
   * refresh token (ghr_…, 6 months); they only reach repositories the App is
   * installed on.
   */
  auth: {
    deviceUrl: `${WEB}/login/device/code`,
    tokenUrl: `${WEB}/login/oauth/access_token`,
    scope: null, // a GitHub App's permissions are set on the App
    appName: "GitHub App",
    idLabel: "Client ID",
    idPlaceholder: "Iv23li…",
    clientIdKey: "githubAppClientId", // settings keys for an app entered in the dialog
    appSlugKey: "githubAppSlug",
    buildEnv: "KIVI_GITHUB_CLIENT_ID",
    registerUrl: `${WEB}/settings/apps/new`,
    registerHint: "with <em>Enable Device Flow</em> ticked",
    /** The device-code request was refused because the client ID is wrong. */
    unknownClient: (res) => res.error === "Not Found",
    explain: (res) => (res.error === "device_flow_disabled" ? "tick “Enable Device Flow” in the GitHub App's settings, then try again" : null),
    /** A refresh was refused for good: sign in again. */
    refreshRejected: (res) => res.error === "bad_refresh_token",
  },

  /** github.com pages KiVi links to. */
  web: {
    /**
     * GitHub's mark (white, for KiVi's dark UI), loaded from GitHub when the
     * sign-in chooser opens: KiVi doesn't ship forge logos (the user's choice).
     */
    logo: "https://github.githubassets.com/favicons/favicon-dark.svg",
    repo: (nwo) => `${WEB}/${nwo}`,
    /** A folder of a branch (no branch: the repository's front page). */
    tree: (nwo, branch = null, dir = "") => `${WEB}/${nwo}${branch ? `/tree/${encPath(branch)}${dir ? `/${encPath(dir)}` : ""}` : ""}`,
    /** Where a pushed branch's pull request is opened. */
    compare: (nwo, branch) => `${WEB}/${nwo}/compare/${encodeURIComponent(branch)}?expand=1`,
    newRepo: `${WEB}/new`,
    /** The GitHub App's install / repository access page. */
    appInstall: (slug) => `${WEB}/apps/${encodeURIComponent(slug)}/installations/new`,
  },
};
