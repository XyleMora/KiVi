// File sources for projects: GitHub repositories (local folders are TauriSource
// in src/desktop/tauri.js). Every source exposes: kind, label, list(),
// readText(path), readBinary(path), url(path)?

import { joinPath } from "./project.js";

const KICAD_EXT = /\.(kicad_pro|kicad_sch|kicad_pcb|kicad_wks|kicad_prl|wrl|step|stp|wrz)$/i;

// ---- GitHub ----------------------------------------------------------------

/**
 * Parse github.com URLs and shorthands:
 *   owner/repo, owner/repo@ref, owner/repo@ref:path,
 *   https://github.com/owner/repo[/tree|blob/<ref>/<path>]
 * Refs containing "/" are resolved later against the API.
 */
export function parseGitHubSpec(spec) {
  spec = spec.trim();
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/(tree|blob)\/(.+?))?\/?(?:[?#].*)?$/.exec(spec);
  if (m) return { owner: m[1], repo: m[2], rest: m[4] ? decodeURIComponent(m[4]) : null, kind: m[3] ?? null };
  m = /^([\w.-]+)\/([\w.-]+)(?:@([^:]+))?(?::(.*))?$/.exec(spec);
  if (m) return { owner: m[1], repo: m[2], ref: m[3] ?? null, path: m[4] ?? "", rest: null };
  return null;
}

export class GitHubSource {
  constructor({ owner, repo, ref, path = "", token = null, sha = null }) {
    this.kind = "github";
    this.owner = owner;
    this.repo = repo;
    this.ref = ref;
    this.sha = sha;
    this.path = path; // sub-directory or file the user pointed at
    this.token = token;
    this.label = `${owner}/${repo}@${ref}${path ? `:${path}` : ""}`;
    this._list = null;
  }

  headers(extra = {}) {
    const h = { Accept: "application/vnd.github+json", ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  static async api(path, token) {
    const h = { Accept: "application/vnd.github+json" };
    if (token) h.Authorization = `Bearer ${token}`;
    const r = await fetch(`https://api.github.com${path}`, { headers: h });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      const msg = r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0" ? "GitHub API rate limit reached — sign in with GitHub for a higher limit" : body.message || r.statusText;
      const err = new Error(`GitHub ${r.status}: ${msg}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  }

  /** Build a source from a spec, resolving the default branch and ambiguous refs. */
  static async open(spec, token = null) {
    const p = typeof spec === "string" ? parseGitHubSpec(spec) : spec;
    if (!p) throw new Error("Not a GitHub repository URL");
    let ref = p.ref, path = p.path ?? "";
    if (p.rest) {
      // "<ref>/<path>" — try the longest ref that exists, shortest first is cheaper.
      const parts = p.rest.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const cand = parts.slice(0, i).join("/");
        try {
          const c = await GitHubSource.api(`/repos/${p.owner}/${p.repo}/commits/${encodeURIComponent(cand)}`, token);
          ref = cand;
          path = parts.slice(i).join("/");
          return new GitHubSource({ owner: p.owner, repo: p.repo, ref, path, token, sha: c.sha });
        } catch (e) {
          if (e.status && e.status !== 404 && e.status !== 422) throw e;
        }
      }
      throw new Error(`Could not resolve branch/commit in "${p.rest}"`);
    }
    if (!ref) ref = (await GitHubSource.api(`/repos/${p.owner}/${p.repo}`, token)).default_branch;
    // "HEAD" is the default branch: show its name if
    // the API can tell (it can't for a private repository without a token, which still opens as HEAD).
    else if (ref === "HEAD") ref = (await GitHubSource.api(`/repos/${p.owner}/${p.repo}`, token).catch(() => null))?.default_branch ?? ref;
    return new GitHubSource({ owner: p.owner, repo: p.repo, ref, path, token });
  }

  /** Directory the listing is restricted to ("" = whole repository). */
  get dir() {
    const p = this.path.replace(/\/+$/, "");
    return KICAD_EXT.test(p) ? p.slice(0, Math.max(0, p.lastIndexOf("/"))) : p;
  }

  async list() {
    if (!this._list) {
      // "<ref>:<dir>" lists just a sub-tree, which keeps huge repositories manageable.
      const dir = this.dir;
      const rev = encodeURIComponent(this.sha ?? this.ref) + (dir ? ":" + dir.split("/").map(encodeURIComponent).join("/") : "");
      let tree;
      try {
        tree = await GitHubSource.api(`/repos/${this.owner}/${this.repo}/git/trees/${rev}?recursive=1`, this.token);
      } catch (e) {
        // The folder isn't in this commit (moved, or a mangled link): list the whole repository instead.
        if (!(dir && e.status === 404)) throw e;
        tree = await GitHubSource.api(`/repos/${this.owner}/${this.repo}/git/trees/${encodeURIComponent(this.sha ?? this.ref)}?recursive=1`, this.token);
        console.warn(`${dir} not found in ${this.ref}; listing the whole repository`);
        this.path = "";
        this.label = `${this.owner}/${this.repo}@${this.ref}`;
      }
      const listed = this.dir;
      this.truncated = !!tree.truncated;
      const paths = tree.tree.filter((e) => e.type === "blob").map((e) => (listed ? `${listed}/${e.path}` : e.path));
      this._list = paths.filter((p) => KICAD_EXT.test(p));
    }
    return this._list;
  }

  has(path) {
    return !!this._list?.includes(path);
  }

  rawUrl(path) {
    return `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${encodeURIComponent(this.sha ?? this.ref)}/${path.split("/").map(encodeURIComponent).join("/")}`;
  }

  async fetchFile(path) {
    const rev = encodeURIComponent(this.sha ?? this.ref);
    const enc = path.split("/").map(encodeURIComponent).join("/");
    let r;
    if (this.token) {
      // Private with token: contents API with the raw media type.
      r = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/contents/${enc}?ref=${rev}`, { headers: this.headers({ Accept: "application/vnd.github.raw" }) });
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

/** Files that the visual diff can show. */
export const DIFFABLE = /\.kicad_(sch|pcb)$/i;
/** Design rule files: the visual diff compares their rules (rules-diff.js) rather than drawing them. */
export const RULE_FILES = /\.kicad_(pro|dru)$/i;
const COMPARED = (path) => DIFFABLE.test(path) || RULE_FILES.test(path);

const FULL_SHA = /^[0-9a-f]{40}$/i;

/**
 * A file's text before a change, rebuilt from its text after and the unified
 * diff GitHub lists for it (the `patch` of /pulls/N/files), so the old
 * version needs no request of its own.
 * @param {string} after
 * @param {string} patch
 * @returns {string}
 */
export function textBeforePatch(after, patch) {
  const afterNewline = after.endsWith("\n");
  const lines = (afterNewline ? after.slice(0, -1) : after).split("\n");
  const out = [];
  let i = 0; // next line of `after`
  let inHunk = false, prev = "";
  // Whether the old text ends with a newline: as the new one, unless a
  // "\ No newline at end of file" marker says otherwise.
  let beforeNewline = afterNewline;
  for (const line of patch.split("\n")) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      // "+c,0" (lines only removed) means after line c; otherwise the hunk starts at line c.
      const start = m[2] === "0" ? Number(m[1]) : Number(m[1]) - 1;
      while (i < start) out.push(lines[i++]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\")) beforeNewline = prev === "+";
    else if (line.startsWith("+")) i++;
    else if (line.startsWith("-")) out.push(line.slice(1));
    else if (line.startsWith(" ")) out.push(lines[i++]);
    prev = line[0];
  }
  while (i < lines.length) out.push(lines[i++]);
  return out.join("\n") + (beforeNewline ? "\n" : "");
}

/** Files that differ between two commits, from their trees (the compare API only measures from the merge base). */
async function treeDiff(api, owner, repo, a, b) {
  const blobs = async (sha) => {
    const t = await api(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`);
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
 * @returns {Promise<{base: object, head: object, files: object[], title: string, url: string}>}
 */
export async function resolveComparison(spec, token = null) {
  const { owner, repo } = spec;
  const api = (p) => GitHubSource.api(p, token);
  let base, head, files, title, url;
  if (spec.pr) {
    const pr = await api(`/repos/${owner}/${repo}/pulls/${spec.pr}`);
    head = { owner: pr.head.repo?.owner.login ?? owner, repo: pr.head.repo?.name ?? repo, sha: pr.head.sha, ref: pr.head.ref };
    // Diff against the merge base so unrelated base-branch changes don't show up.
    const cmp = await api(`/repos/${owner}/${repo}/compare/${pr.base.sha}...${pr.head.sha}`).catch(() => null);
    base = { owner, repo, sha: cmp?.merge_base_commit?.sha ?? pr.base.sha, ref: pr.base.ref };
    files = [];
    for (let page = 1; page <= 30; page++) {
      const batch = await api(`/repos/${owner}/${repo}/pulls/${spec.pr}/files?per_page=100&page=${page}`);
      files.push(...batch);
      if (batch.length < 100) break;
    }
    title = `#${pr.number} ${pr.title}`;
    url = pr.html_url;
  } else if (spec.commit) {
    const c = await api(`/repos/${owner}/${repo}/commits/${encodeURIComponent(spec.commit)}`);
    head = { owner, repo, sha: c.sha, ref: c.sha.slice(0, 7) };
    const parent = c.parents[0]?.sha;
    base = { owner, repo, sha: parent ?? null, ref: parent ? parent.slice(0, 7) : "(none)" };
    files = c.files ?? [];
    title = c.commit.message.split("\n")[0];
    url = c.html_url;
  } else {
    const baseRef = spec.base || (await api(`/repos/${owner}/${repo}`)).default_branch;
    // The same branch on both sides (e.g. the viewer's Visual diff on the default branch): its latest commit.
    if (baseRef === spec.head) return resolveComparison({ owner, repo, commit: spec.head }, token);
    const cmp = await api(`/repos/${owner}/${repo}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(spec.head)}`);
    const short = (r) => (FULL_SHA.test(r) ? r.slice(0, 7) : r);
    const headSha = cmp.commits.at(-1)?.sha ?? (FULL_SHA.test(spec.head) ? spec.head : (await api(`/repos/${owner}/${repo}/commits/${encodeURIComponent(spec.head)}`)).sha);
    base = { owner, repo, sha: cmp.merge_base_commit.sha, ref: short(baseRef) };
    head = { owner, repo, sha: headSha, ref: short(spec.head) };
    files = cmp.files ?? [];
    // A commit that isn't where the head left it (on another branch, or newer): compared as it is.
    if (FULL_SHA.test(baseRef) && cmp.merge_base_commit.sha !== baseRef) {
      base.sha = baseRef;
      files = await treeDiff(api, owner, repo, baseRef, headSha);
    }
    title = `${base.ref} → ${head.ref}`;
    url = cmp.html_url;
  }
  files = files
    .filter((f) => COMPARED(f.filename) || COMPARED(f.previous_filename ?? ""))
    .map((f) => ({ path: f.filename, previous: f.previous_filename ?? f.filename, status: f.status }));
  return { base, head, files, title, url };
}

// ---- 3D model resolution -------------------------------------------------

const MODEL_EXT = /\.(wrl|step|stp)$/i;
const LIB_VAR = /^\$\{(KICAD\d*_3DMODEL_DIR|KISYS3DMOD)\}\/?/;
const LIB_VAR_NAME = /^(KICAD\d*_3DMODEL_DIR|KISYS3DMOD)$/;
const THIRD_PARTY_VAR = /^KICAD\d*_3RD_PARTY$/;
const modelFormat = (p) => (/\.wrl$/i.test(p) ? "wrl" : /\.(step|stp)$/i.test(p) ? "step" : null);
/** The same model under its other extensions, VRML first (lighter, and has KiCad's colours). */
const modelVariants = (p) => {
  const stem = p.replace(MODEL_EXT, "");
  return [...new Set([p, `${stem}.wrl`, `${stem}.step`, `${stem}.stp`])];
};
const urlPath = (p) => p.split("/").map(encodeURIComponent).join("/");

/** A folder on this computer: `/…`, `~/…`, `C:\…` or `\\server\…`. */
const LOCAL_DIR = /^(\/|~([\\/]|$)|[a-z]:[\\/]|\\\\)/i;

/**
 * A 3D model source from Settings: a URL prefix (e.g. a raw mirror of KiCad's
 * library), a GitHub repository (`owner/repo[@ref][:dir]` or a github.com URL),
 * or a folder on this computer such as KiCad's installed library (desktop app only).
 */
export function parseModelSource(spec) {
  spec = spec.trim();
  if (!spec || spec.startsWith("#")) return null;
  if (LOCAL_DIR.test(spec)) return { kind: "dir", spec, path: spec };
  const gh = /^https?:\/\//i.test(spec) && !/^https?:\/\/(www\.)?github\.com\//i.test(spec) ? null : parseGitHubSpec(spec);
  if (gh) return { kind: "repo", spec, gh };
  if (/^https?:\/\//i.test(spec)) return { kind: "url", spec, base: spec.replace(/\/?$/, "/") };
  return null;
}

/** Model files of a source, indexed by lower-case file name, for finding models whatever folder they're in. */
async function modelIndex(source, dir = "") {
  const index = new Map();
  const prefix = dir ? dir.replace(/\/+$/, "") + "/" : "";
  for (const p of await source.list()) {
    if (!MODEL_EXT.test(p) || (prefix && !p.startsWith(prefix))) continue;
    const name = p.slice(p.lastIndexOf("/") + 1).toLowerCase();
    if (!index.has(name)) index.set(name, []);
    index.get(name).push(p);
  }
  return index;
}

/** Paths in `index` holding the model `path` refers to, best match first (most trailing folders in common). */
function findByName(index, path) {
  const want = path.toLowerCase().split("/");
  const hits = [];
  for (const variant of modelVariants(want.at(-1))) {
    const found = index.get(variant) ?? [];
    const score = (p) => {
      const have = p.toLowerCase().split("/");
      let n = 1;
      while (n < want.length && n < have.length && want.at(-1 - n) === have.at(-1 - n)) n++;
      return n;
    };
    hits.push(...[...found].sort((a, b) => score(b) - score(a)));
  }
  return hits;
}

/**
 * Map a footprint's model path to the places it may be fetched from, tried in order
 * until one loads (an async iterable, so later sources are only listed if needed).
 * Each candidate is `{url, format, alt}`; `alt` marks the same model in another
 * format (a .step for a .wrl path), which KiCad itself wouldn't load.
 * Always the project first, then folders on this computer, then web sources
 * (URL prefixes, GitHub repositories), each group in the order of the list:
 *   ${KIPRJMOD}/x.step, relative/x.wrl  → that path in the project, then by name as below
 *   ${KICADn_3DMODEL_DIR}/..., absolute paths from the designer's machine, other variables
 *                                       → a file with that name anywhere in the project,
 *                                         then, for a variable the linked KiCad defines,
 *                                         that path in its folder, then the library-relative
 *                                         path and the file name in each model source
 * @param {object} source project source
 * @param {string} projectDir
 * @param {string[]} modelSources URL prefixes, GitHub repositories and folders (folders go first)
 * @param {{token?: string|null, onSourceError?: (spec: string, err: Error) => void,
 *   openDir?: (path: string) => object, pathVars?: Record<string, string>}} [opts] `openDir` makes
 *   a source (list/readBinary) for a folder model source; without it (in a browser) folder sources
 *   are skipped with an error. `pathVars` are the linked KiCad's path variables (name → folder);
 *   its library and third-party folders are also searched, after the folders in `modelSources`.
 */
export function makeModelResolver(source, projectDir, modelSources = [], { token = null, onSourceError = null, openDir = null, pathVars = {} } = {}) {
  const blobCache = new Map();
  // A local folder is faster and works offline, so it goes before any web source.
  const parsed = modelSources.map(parseModelSource).filter(Boolean);
  const dirs = parsed.filter((m) => m.kind === "dir");
  // Only KiCad's model library and add-ons are searched by name: the user's own
  // variables may point at large folders, so those are only used for exact paths.
  for (const [name, path] of Object.entries(pathVars)) {
    if ((LIB_VAR_NAME.test(name) || THIRD_PARTY_VAR.test(name)) && !dirs.some((m) => m.path === path)) dirs.push({ kind: "dir", spec: path, path });
  }
  const sources = [...dirs, ...parsed.filter((m) => m.kind !== "dir")];
  // ${KICAD9_3DMODEL_DIR} in a board made with another version: KiCad's own library still has it.
  const varDir = (name) =>
    pathVars[name] ??
    (LIB_VAR_NAME.test(name) ? Object.entries(pathVars).find(([k]) => LIB_VAR_NAME.test(k))?.[1] : null) ??
    (THIRD_PARTY_VAR.test(name) ? Object.entries(pathVars).find(([k]) => THIRD_PARTY_VAR.test(k))?.[1] : null);
  const dirSources = new Map(); // folder → source, for exact paths
  const opened = new Map(); // spec → Promise<{source, dir, index}|null> for repositories and folders
  let projectIndex = null;

  /** null when the file can't be read, so the next candidate is tried. */
  const fetchable = async (src, hit) => {
    const format = modelFormat(hit);
    let url = src.url?.(hit);
    if (!url) {
      const key = `${src.label}\n${hit}`;
      if (!blobCache.has(key)) blobCache.set(key, src.readBinary(hit).then((b) => URL.createObjectURL(new Blob([b])), () => null));
      url = await blobCache.get(key);
    }
    return url ? { url, format } : null;
  };
  /** A source that can be listed (repository or folder), opened once and indexed by file name. */
  const openListed = (m) => {
    if (!opened.has(m.spec)) {
      opened.set(
        m.spec,
        (async () => {
          if (m.kind === "dir") {
            if (!openDir) throw new Error("folders work only in the desktop app");
            const src = openDir(m.path);
            return { source: src, dir: "", index: await modelIndex(src) };
          }
          const src = await GitHubSource.open(m.gh, token);
          return { source: src, dir: src.dir, index: await modelIndex(src, src.dir) };
        })().catch((e) => {
          console.warn(`3D model source ${m.spec}: ${e.message}`);
          onSourceError?.(m.spec, e);
          return null;
        }),
      );
    }
    return opened.get(m.spec);
  };

  /** `${NAME}/rel` where the linked KiCad puts NAME; read directly, so the folder isn't listed. */
  async function* inVarDir(name, rel) {
    const dir = varDir(name);
    if (!dir || !openDir || !rel) return;
    if (!dirSources.has(dir)) dirSources.set(dir, openDir(dir));
    for (const v of modelVariants(rel)) yield fetchable(dirSources.get(dir), v);
  }

  async function* inProject(path) {
    projectIndex ??= modelIndex(source).catch(() => new Map());
    for (const hit of findByName(await projectIndex, path)) yield fetchable(source, hit);
  }
  async function* inSources(rel, path) {
    for (const m of sources) {
      if (m.kind === "url") {
        // A URL prefix can't be listed: only library-relative paths can be tried.
        // VRML first: KiCad's library has both, and VRML is lighter and carries KiCad's colours.
        if (rel) {
          const stem = rel.replace(MODEL_EXT, "");
          for (const v of new Set([`${stem}.wrl`, rel])) yield { url: m.base + urlPath(v), format: modelFormat(v) };
        }
        continue;
      }
      const repo = await openListed(m);
      if (!repo) continue;
      const tried = new Set();
      if (rel) {
        const files = new Set(await repo.source.list());
        for (const v of modelVariants(joinPath(repo.dir, rel))) {
          if (!files.has(v)) continue;
          tried.add(v);
          yield fetchable(repo.source, v);
        }
      }
      for (const hit of findByName(repo.index, path)) if (!tried.has(hit)) yield fetchable(repo.source, hit);
    }
  }

  return async function* resolve(rawPath) {
    const want = modelFormat(rawPath);
    const seen = new Set(); // an exact path in KiCad's folder is also found by the search after it
    for await (const c of candidates(rawPath)) {
      if (!c || seen.has(c.url)) continue;
      seen.add(c.url);
      yield { ...c, alt: !!want && c.format !== want };
    }
  };

  async function* candidates(rawPath) {
    const path = rawPath.replace(/\\/g, "/");
    const libVar = LIB_VAR.exec(path);
    if (libVar) {
      const rel = path.slice(libVar[0].length);
      yield* inProject(path); // a copy shipped with the project beats any library
      yield* inVarDir(libVar[1], rel);
      yield* inSources(rel, path);
      return;
    }
    const local = path.replace(/^\$\{KIPRJMOD\}\/?/, "");
    if (!/^\$\{/.test(local) && !/^([a-z]:|\/)/i.test(local)) {
      // Relative to the project, as KiCad would load it.
      const list = new Set(await source.list());
      for (const v of modelVariants(joinPath(projectDir, local))) if (list.has(v)) yield fetchable(source, v);
    }
    // Absolute path or another variable: look for the file by name.
    const custom = /^\$\{([^}]+)\}\/?(.*)$/.exec(local);
    yield* inProject(path);
    if (custom) yield* inVarDir(custom[1], custom[2]);
    yield* inSources(custom ? custom[2] : null, path);
  }
}
