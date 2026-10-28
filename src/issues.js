// Hardware change requests as GitHub issues, pinned to a part, pad, net or
// spot like review comments, but on a branch rather than in a pull request.
//
// A KiVi issue is an ordinary GitHub issue with the label "kivi". Its body
// ends with the same marker as a review comment (review.js), which also says
// which file and commit it was made on, since an issue has no file of its own:
//
//   R12 should be 10 k: the LED is too bright.
//
//   <sub>📍 KiVi · footprint **R12**</sub>
//   <!-- kivi:{"v":1,"type":"footprint","ref":"R12",…,"file":"hw/board.kicad_pcb","commit":"3f2a…"} -->
//
// Issues become threads of the same shape as review threads (rootId = the
// issue number, resolved = closed), so review-ui.js shows both. Signed in, one
// GraphQL request reads issues with their comments; signed out, REST reads the
// issues of public repositories and each one's comments when it's opened.

import { ReviewComments, comment, encodeBody } from "./review.js";

export const ISSUE_LABEL = "kivi";
const LABEL_COLOUR = "f0a63b"; // the brand orange
const LABEL_DESCRIPTION = "Hardware change request pinned in KiVi";

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

export class IssueComments extends ReviewComments {
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
        out.push(thread(n.id, n.number, n.title, n.state === "CLOSED", root, replies, { canUpdate: n.viewerCanUpdate, locked: n.locked, signedIn: true }));
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
        const t = thread(null, it.number, it.title, it.state === "closed", root, [], { signedIn: false });
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

/** An issue as a review thread (see review-ui.js); `path` is the repository path from the marker. */
function thread(id, number, title, closed, root, replies, { canUpdate = false, locked = false, signedIn }) {
  return {
    id,
    rootId: number,
    key: `i${number}`, // unlike review threads' comment ids, so both can share a store (and a link)
    issue: true,
    number,
    title,
    path: root.anchor?.file ?? null,
    commit: root.anchor?.commit ?? null,
    line: null,
    isResolved: closed,
    isOutdated: false,
    resolvedBy: null,
    canResolve: signedIn && canUpdate && !closed,
    canUnresolve: signedIn && canUpdate && closed,
    canReply: signedIn && !locked,
    anchor: root.anchor,
    comments: [root, ...replies],
  };
}
