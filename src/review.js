// Design review comments on pull requests, stored as GitHub review comments.
//
// Every KiVi comment is an ordinary file-level review comment on the
// .kicad_sch / .kicad_pcb file, so it shows up (and can be replied to and
// resolved) on GitHub itself. What it points at — a footprint, pad, net,
// symbol or a bare point — travels in an HTML comment at the end of the body,
// which GitHub doesn't render:
//
//   Is this the right footprint?
//
//   <sub>📍 KiVi · footprint **U3**</sub>
//   <!-- kivi:{"v":1,"type":"footprint","ref":"U3","uuid":"…","x":12.5,"y":40,"side":"head"} -->
//
// Threads are read through GraphQL (the REST API has no resolved state);
// without signing in only public repositories can be read, through REST, and
// resolve state is unknown. Writing always needs a sign-in.

const MARKER = /<!--\s*kivi:(\{[\s\S]*?\})\s*-->/;
const FOOTER = /\n*<sub>📍 KiVi ·[^\n]*<\/sub>[ \t]*/;

/** Human-readable name of what an anchor points at. */
export function anchorLabel(a) {
  if (!a) return "File";
  switch (a.type) {
    case "footprint":
    case "symbol":
      return a.ref || "component";
    case "pad":
      return `${a.ref} pad ${a.pad}`;
    case "net":
      return a.net || (a.pin ? `net at ${a.pin}` : "unnamed net");
    case "sheet":
      return a.name || "sheet";
    default:
      return `point ${a.x.toFixed(1)}, ${a.y.toFixed(1)} mm`;
  }
}

export function anchorKind(a) {
  return !a ? "file" : a.type === "point" ? "point" : a.type;
}

/** Comment body as posted: text, a visible footer and the machine-readable anchor. */
export function encodeBody(text, anchor) {
  const json = JSON.stringify({ v: 1, ...anchor }).replace(/--/g, "-\\u002d"); // "--" would end the HTML comment
  const what = anchor.type === "point" ? "point" : `${anchor.type} **${escapeMd(anchorLabel(anchor))}**`;
  const footer = `<sub>📍 KiVi · ${what}</sub>`;
  return `${text.trim()}\n\n${footer}\n<!-- kivi:${json} -->`;
}

/** → {text, anchor|null} */
export function decodeBody(body) {
  body = String(body ?? "").replace(/\r\n/g, "\n");
  const m = MARKER.exec(body);
  let anchor = null;
  if (m) {
    try {
      anchor = JSON.parse(m[1]);
      if (typeof anchor.x !== "number" || typeof anchor.y !== "number") anchor = null;
    } catch {
      anchor = null;
    }
  }
  const text = (m ? body.slice(0, m.index) + body.slice(m.index + m[0].length) : body).replace(FOOTER, "").trim();
  return { text, anchor };
}

function escapeMd(s) {
  return String(s).replace(/[\\`*_[\]<>|]/g, (c) => `\\${c}`);
}

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

export class ReviewComments {
  /**
   * @param {{owner: string, repo: string, pr: number, token?: string|null, fetch?: Function}} o
   */
  constructor({ owner, repo, pr, token = null, fetch: fetchFn = null }) {
    this.owner = owner;
    this.repo = repo;
    this.pr = pr;
    this.token = token;
    this.fetch = fetchFn ?? ((...a) => globalThis.fetch(...a));
    this.threads = [];
    this.viewer = null;
    this.writeWhat = "pull requests"; // what a refused write needs access to
  }

  get canWrite() {
    return !!this.token;
  }

  async request(method, path, body) {
    const headers = { Accept: "application/vnd.github+json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body) headers["Content-Type"] = "application/json";
    const r = await this.fetch(`https://api.github.com${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 204) return null;
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw githubError(r.status, data, r.headers, this.writeWhat);
    return data;
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

  /** Load all review threads of the pull request. */
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
    await this.request("PATCH", `/repos/${this.owner}/${this.repo}/pulls/${this.pr}`, { body: `${body ? `${body}\n\n` : ""}Fixes #${n}` });
  }
}

const CLOSING_QUERY = `query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) { closingIssuesReferences(first: 50) { nodes { number repository { nameWithOwner } } } }
  }
}`;

/** Issue numbers after GitHub's closing keywords in a description ("Fixes #12, closes #3"). */
export function closingNumbers(text) {
  const out = new Set();
  for (const m of String(text ?? "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b/gi)) out.add(Number(m[1]));
  return out;
}

/** One comment of a thread, with its text and anchor decoded. */
export function comment(id, body, author, avatar, createdAt, url, mine) {
  const { text, anchor } = decodeBody(body);
  return { id, text, anchor, author: author ?? "ghost", avatar: avatar ?? null, createdAt, url, mine: !!mine };
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

function githubError(status, data, headers, what = "pull requests") {
  let msg = data?.message || `HTTP ${status}`;
  if (status === 403 && headers?.get?.("x-ratelimit-remaining") === "0") msg = "API rate limit reached — sign in with GitHub for a higher limit";
  else if (status === 401) msg = "GitHub ended the sign-in; sign in again";
  else if (status === 403 || status === 404) msg += ` — the token needs write access to ${what}`;
  else if (status === 422 && data?.errors?.length) msg += `: ${data.errors.map(validationError).join("; ")}`;
  const err = new Error(`GitHub ${status}: ${msg}`);
  err.status = status;
  return err;
}

/** Minimal, safe rendering of comment Markdown: code, bold, italics, links, line breaks. */
export function renderCommentText(text) {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const parts = String(text).split(/(```[\s\S]*?```|`[^`\n]+`)/);
  return parts
    .map((p, i) => {
      if (i % 2) return p.startsWith("```") ? `<pre><code>${esc(p.slice(3, -3).replace(/^[\w-]*\n/, ""))}</code></pre>` : `<code>${esc(p.slice(1, -1))}</code>`;
      return esc(p)
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`)
        .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener">${u}</a>`)
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
        .replace(/(^|\s)@([\w-]+)/g, '$1<span class="mention">@$2</span>')
        .replace(/\n/g, "<br>");
    })
    .join("");
}
