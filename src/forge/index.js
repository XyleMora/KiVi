// Forges: the code hosts KiVi reads projects from and keeps reviews on. Each
// forge is one adapter module (./github.js, ./gitlab.js) that makes all of
// that host's requests and returns the forge-neutral shapes described here;
// the rest of the app only talks to a forge object. A new forge (Gitea, …) is
// a new adapter implementing `Forge`, added to FORGES (and its sign-in and git
// hosts to lib.rs OAUTH_URLS and git.rs FORGE_HOSTS).
//
// Repositories are named "owner/repo" (`nwo`) within their forge; on GitLab
// the owner may hold "/" (nested groups: splitNwo). Tokens are
// passed in by the caller (the pages keep them in settings).

import { github } from "./github.js";
import { gitlab } from "./gitlab.js";

/** Every forge KiVi knows, the default first. */
export const FORGES = [github, gitlab];

/** The forges' names for UI text: "GitHub" or "GitHub or GitLab". */
export function forgeNames() {
  const n = FORGES.map((f) => f.name);
  return n.length > 1 ? `${n.slice(0, -1).join(", ")} or ${n.at(-1)}` : n[0];
}

/** The forge with this id ("github"); the default without one. */
export function forge(id = FORGES[0].id) {
  const f = FORGES.find((x) => x.id === id);
  if (!f) throw new Error(`Unknown forge "${id}"`);
  return f;
}

/** The forge whose URL hash parameter (`gh=`) a page's hash carries, with its value, or null. */
export function forgeInHash(params) {
  for (const f of FORGES) if (params.get(f.hashKey)) return { forge: f, value: params.get(f.hashKey) };
  return null;
}

/** The forge at a host ("github.com"), or null. */
export function forgeForHost(host) {
  return FORGES.find((f) => f.host === String(host ?? "").toLowerCase()) ?? null;
}

/** "group/sub/project" → {owner: "group/sub", repo: "project"} (GitLab namespaces may hold "/"). */
export function splitNwo(nwo) {
  const i = nwo.lastIndexOf("/");
  return { owner: nwo.slice(0, i), repo: nwo.slice(i + 1) };
}

/**
 * A repository's key in settings and caches (watchRepos, hiddenRepos,
 * localCopies, the project index): "owner/repo" on the default forge (as
 * saved by earlier versions), "<forge id>:<path>" on the others.
 */
export function repoKey(f, nwo) {
  return f === FORGES[0] || f?.id === FORGES[0].id ? nwo : `${f.id}:${nwo}`;
}

/** A repository key → {forge, nwo, owner, repo}, or null for an unknown forge. */
export function parseRepoKey(key) {
  const m = /^([a-z]+):(.+)$/.exec(key);
  const f = m ? FORGES.find((x) => x.id === m[1]) : FORGES[0];
  if (!f) return null;
  const nwo = m ? m[2] : key;
  return { forge: f, nwo, ...splitNwo(nwo) };
}

/**
 * The forge repository of a local copy, from git_info ({host, owner, repo}):
 * {forge, nwo, owner, repo, key}, or null when it has no forge remote.
 */
export function remoteOf(info) {
  const f = info?.owner ? forgeForHost(info.host ?? FORGES[0].host) : null;
  if (!f) return null;
  const nwo = `${info.owner}/${info.repo}`;
  return { forge: f, nwo, owner: info.owner, repo: info.repo, key: repoKey(f, nwo) };
}

/**
 * A repository spec typed by the user: an http(s) address goes to the forge
 * that owns it; a shorthand ("owner/repo@ref:dir") to the default forge.
 * @returns {{forge: Forge, spec: RepoSpec} | null}
 */
export function parseRepoSpec(text) {
  text = String(text ?? "").trim();
  const url = /^https?:\/\//i.test(text);
  for (const f of FORGES) {
    if (url && !f.ownsUrl(text)) continue;
    const spec = f.parseSpec(text);
    if (spec) return { forge: f, spec };
    if (!url) break; // shorthands belong to the default forge
  }
  return null;
}

/**
 * @typedef {object} RepoSpec  a parsed repository address
 * @property {string} owner
 * @property {string} repo
 * @property {string|null} [ref]   branch, tag or commit
 * @property {string} [path]       folder or file inside
 * @property {string|null} rest    "<ref>/<path>" still to be split (refs may hold "/")
 *
 * @typedef {object} Source  files of a repository at one commit (see ../project.js)
 * @property {string} kind      the forge id
 * @property {Forge} forge
 * @property {string} owner
 * @property {string} repo
 * @property {string} ref       what the user asked for (branch, tag, commit)
 * @property {string|null} sha  the commit, when known
 * @property {string|null} [commit] an earlier commit picked in the history menu
 * @property {string} path      folder or file the user pointed at
 * @property {string} dir       folder the listing is restricted to
 * @property {string} label
 * @property {() => Promise<string[]>} list
 * @property {(path: string) => Promise<string>} readText
 * @property {(path: string) => Promise<Uint8Array>} readBinary
 * @property {(path: string) => string|null} url  a fetchable URL (public files), else null
 *
 * @typedef {object} RepoInfo
 * @property {string} nwo            "owner/repo", in the forge's own case
 * @property {string} defaultBranch
 * @property {string} pushedAt       ISO time of the last push (cache key)
 * @property {boolean} private
 * @property {boolean} archived
 * @property {boolean} disabled
 * @property {string} url            its web page
 *
 * @typedef {object} CommitRef  one side of a comparison
 * @property {string} owner
 * @property {string} repo
 * @property {string|null} sha  null: nothing (a first commit's parent)
 * @property {string} ref       label: branch, or short SHA
 *
 * @typedef {object} ChangedFile
 * @property {string} path
 * @property {string} previous      path before (a rename), else `path`
 * @property {string} status        "added" | "removed" | "modified" | "renamed" | "copied" | "changed"
 * @property {string|null} [patch]  unified diff, when the forge lists it
 * @property {string|null} [ref]    commit `path` can be read at (a pull request's head)
 *
 * @typedef {object} Comparison
 * @property {CommitRef} base
 * @property {CommitRef} head
 * @property {ChangedFile[]} files  only files the visual diff compares
 * @property {string} title
 * @property {string} url           the comparison's web page
 *
 * @typedef {object} PullRequest
 * @property {string} owner
 * @property {string} repo
 * @property {number} number
 * @property {string} title
 * @property {string} body
 * @property {string} url
 * @property {CommitRef} base
 * @property {CommitRef & {label: string}} head  `owner/repo` hold the head commit (a fork);
 *   `label` names the branch for display
 *
 * @typedef {object} SearchItem  a pull request or issue in a home page list
 * @property {string} nwo
 * @property {number} number
 * @property {string} title
 * @property {string} body
 * @property {boolean} draft
 * @property {string} author
 * @property {string|null} avatar
 * @property {string} updatedAt
 * @property {number} comments
 * @property {string} url
 *
 * @typedef {object} ReviewThreads  a pull request's review threads, or a repository's
 *   KiVi issues as threads (shape in ../review.js); from `reviews()` / `issues()`
 * @property {boolean} canWrite
 * @property {boolean} [readsNeedSignIn]  true: the forge shows no threads signed out (GitLab)
 * @property {string|null} viewer
 * @property {() => Promise<object[]>} load
 * @property {(t: object) => Promise<object>} [loadReplies]  issues read signed out
 * @property {(o: {path: string, commitId: string, anchor: object, text: string, title?: string}) => Promise<any>} create
 * @property {(t: object, text: string) => Promise<any>} reply
 * @property {(t: object, resolved: boolean) => Promise<object>} setResolved
 * @property {(commentId: number) => Promise<void>} remove
 * @property {() => Promise<Set<string>>} [changedFiles]       paths that take review comments
 * @property {() => Promise<Set<number>>} [closingIssues]       issues merging closes
 * @property {(n: number) => Promise<void>} [addClosingIssue]
 *
 * @typedef {object} Forge
 * @property {string} id
 * @property {string} name       for UI text ("GitHub")
 * @property {string} host       "github.com"
 * @property {string} hashKey    the pages' URL hash parameter for its repositories
 * @property {{pr: string, prs: string, prShort: string, prRef: (n: number) => string, closes: (n: number) => string}} words
 *   its names for things in UI text ("pull request" / "merge request", "#12" / "!12")
 * @property {(text: string) => RepoSpec|null} parseSpec
 * @property {(url: string) => boolean} ownsUrl
 * @property {(spec: string|RepoSpec, token?: string|null) => Promise<Source>} open
 * @property {(o: {owner: string, repo: string, ref: string, sha?: string|null, path?: string, token?: string|null}) => Source} source
 * @property {(nwo: string, token?: string|null) => Promise<RepoInfo>} repo  rejects with `status` 404 when not visible
 * @property {(token: string|null, o: {watched?: string[], hidden?: Set<string>}) => Promise<RepoInfo[]>} listRepos
 * @property {(nwo: string, ref: string, token?: string|null) => Promise<{files: {path: string, sha: string, size: number}[], truncated: boolean}>} tree
 * @property {(owner: string, repo: string, token?: string|null) => Promise<{name: string}[]>} branches
 * @property {(owner: string, repo: string, ref: string, offset: number, count: number, token?: string|null) => Promise<{sha: string, summary: string, author: string, time: number}[]>} commits
 * @property {(spec: object, token?: string|null) => Promise<Comparison>} compare
 * @property {(owner: string, repo: string, n: number, token?: string|null) => Promise<PullRequest>} pullRequest
 * @property {(owner: string, repo: string, n: number, token?: string|null, o?: {max?: number}) => Promise<ChangedFile[]>} pullFiles
 * @property {(filter: {reviewRequested?: boolean, author?: "me", repos?: string[]}, token?: string|null) => Promise<SearchItem[]>} searchPullRequests
 * @property {(filter: {label: string, assignee?: "me", author?: "me", repos?: string[]}, token?: string|null) => Promise<SearchItem[]>} searchIssues
 * @property {(o: {owner: string, repo: string, pr: number, token?: string|null}) => ReviewThreads} reviews
 * @property {(o: {owner: string, repo: string, token?: string|null}) => ReviewThreads} issues
 * @property {(token: string) => Promise<{login: string, name: string|null, id: number, avatar: string, url: string}>} user
 * @property {(token: string|null) => Promise<{name: string, email: string}>} gitAuthor
 * @property {(url: string|null, px: number) => string} avatar
 * @property {(token: string) => Promise<boolean|null>} [hasAppInstallation]
 * @property {{repo: (nwo: string) => string, tree: (nwo: string, branch?: string|null, dir?: string) => string,
 *   compare: (nwo: string, branch: string) => string, newRepo: string,
 *   appInstall?: (slug: string) => string}} web  the forge's own pages
 * @property {ForgeAuth} auth
 *
 * @typedef {object} ForgeAuth  signing in with OAuth device flow (src/desktop/tauri.js runs it;
 *   both URLs must be in lib.rs OAUTH_URLS)
 * @property {string} deviceUrl      device-code endpoint
 * @property {string} tokenUrl       token endpoint (polling and refresh)
 * @property {string|null} scope
 * @property {string} appName        what the user registers ("GitHub App", "OAuth application")
 * @property {string} idLabel        its client ID's name there
 * @property {string} idPlaceholder
 * @property {string} clientIdKey    settings key for a client ID entered in the dialog
 * @property {string} [appSlugKey]   GitHub Apps: settings key for the App's URL name
 * @property {string} buildEnv       build-time variable holding the client ID
 * @property {string} registerUrl    where an app is registered
 * @property {string} registerHint   HTML: what to tick there
 * @property {(res: object) => boolean} unknownClient   a device-code reply refusing the client ID
 * @property {(res: object) => string|null} [explain]  a friendlier message for a refusal
 * @property {(res: object) => boolean} refreshRejected  a refresh refused for good
 */
