// Review comment tests (gjs): anchor encoding, the GitHub API layers (review
// comments and KiVi issues) against a mocked API, and anchor picking/relocation on demo files.   gjs -m tests/review.js

import { readText, kicadDemos } from "./gjs-fs.js";
import GLib from "gi://GLib";
import { encodeBody, decodeBody, anchorLabel, renderCommentText, closingNumbers } from "../src/review.js";
import { GitHubReviews as ReviewComments, GitHubIssues as IssueComments, github } from "../src/forge/github.js";
import { FORGES, forge, parseRepoInput, parseRepoSpec } from "../src/forge/index.js";
import { pickPcb, locatePcb, pickSch, locateSch } from "../src/diff/anchors.js";
import { parsePcb } from "../src/pcb/model.js";
import { renderPcb } from "../src/pcb/render.js";
import { parseSchematic } from "../src/sch/model.js";
import { renderSchematic } from "../src/sch/render.js";
import { buildConnectivity } from "../src/sch/connectivity.js";

let failures = 0;
const check = (cond, msg) => {
  print(`${cond ? "  ok  " : "  FAIL"} ${msg}`);
  if (!cond) failures++;
};

const DEMO = kicadDemos("pic_programmer");

// ---- body encoding ----
{
  const anchor = { type: "net", net: "/VPP--MCLR*", x: 12.5, y: -3, side: "head" };
  const body = encodeBody("  Is this wide enough?\n\nCheck `IPC-2152`.  ", anchor);
  const inner = body.slice(body.indexOf("<!-- kivi:") + 4, body.lastIndexOf(" -->"));
  check(!inner.includes("--"), "no '--' inside the HTML comment");
  check(body.includes("net **/VPP--MCLR\\***"), "footer names the net (Markdown-escaped)");
  const back = decodeBody(body.replace(/\n/g, "\r\n"));
  check(back.text === "Is this wide enough?\n\nCheck `IPC-2152`.", `text round-trips without footer (got ${JSON.stringify(back.text)})`);
  check(back.anchor?.net === "/VPP--MCLR*" && back.anchor.x === 12.5 && back.anchor.side === "head", "anchor round-trips");
  const plain = decodeBody("Just a normal GitHub comment");
  check(plain.anchor === null && plain.text === "Just a normal GitHub comment", "comments without a marker have no anchor");
  check(decodeBody("x <!-- kivi:{broken -->").anchor === null, "broken marker is ignored");
  check(anchorLabel({ type: "pad", ref: "U3", pad: "4", x: 0, y: 0 }) === "U3 pad 4", "pad label");
  const html = renderCommentText('<img src=x onerror=alert(1)> **bold** `a<b` [l](https://e.com/?a=1&b=2) javascript:alert(1)');
  check(!html.includes("<img") && html.includes("&lt;img") && html.includes("<strong>bold</strong>") && html.includes("<code>a&lt;b</code>") && html.includes('href="https://e.com/?a=1&amp;b=2"') && !html.includes('href="javascript'), "comment rendering escapes HTML and keeps safe formatting");
}

// ---- API layer against a mock ----
{
  const calls = [];
  const reply = (status, data) => ({ ok: status < 300, status, json: async () => data, headers: { get: () => null } });
  const anchored = encodeBody("Wrong value?", { type: "footprint", ref: "R1", uuid: "u-1", x: 1, y: 2, side: "head" });
  const fetchMock = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, body, auth: init.headers?.Authorization });
    if (url.endsWith("/graphql") && body.query.includes("reviewThreads")) {
      return reply(200, {
        data: {
          viewer: { login: "me" },
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "PRRT_1", isResolved: false, isOutdated: false, path: "b.kicad_pcb", subjectType: "FILE", line: null,
                    viewerCanResolve: true, viewerCanUnresolve: false, viewerCanReply: true, resolvedBy: null,
                    comments: { nodes: [
                      { databaseId: 11, body: anchored, createdAt: "2026-10-16T10:00:00Z", url: "u11", viewerDidAuthor: true, author: { login: "me", avatarUrl: "a" } },
                      { databaseId: 12, body: "Yes, 10k", createdAt: "2026-10-16T11:00:00Z", url: "u12", viewerDidAuthor: false, author: { login: "you", avatarUrl: "b" } },
                    ] },
                  },
                ],
              },
            },
          },
        },
      });
    }
    if (url.endsWith("/graphql")) return reply(200, { data: { [body.query.includes("unresolve") ? "unresolveReviewThread" : "resolveReviewThread"]: { thread: { id: body.variables.id, isResolved: !body.query.includes("unresolve") } } } });
    if (url.includes("/pulls/7/comments?")) {
      return reply(200, [
        { id: 21, body: anchored, path: "b.kicad_pcb", user: { login: "x" }, created_at: "2026-10-16T10:00:00Z", html_url: "h21", subject_type: "file", position: null },
        { id: 22, in_reply_to_id: 21, body: "ok", path: "b.kicad_pcb", user: { login: "y" }, created_at: "2026-10-16T10:05:00Z", html_url: "h22" },
        { id: 23, body: "line note", path: "a.kicad_sch", line: 40, user: { login: "z" }, created_at: "2026-10-16T09:00:00Z", html_url: "h23", position: 3 },
      ]);
    }
    if (init.method === "POST") return reply(201, { id: 99, body: body.body });
    return reply(404, { message: "Not Found" });
  };

  const api = new ReviewComments({ owner: "o", repo: "r", pr: 7, token: "t0k", fetch: fetchMock });
  const threads = await api.load();
  check(threads.length === 1 && threads[0].id === "PRRT_1" && threads[0].rootId === 11 && threads[0].comments.length === 2, "GraphQL threads loaded");
  check(threads[0].anchor?.ref === "R1" && threads[0].comments[0].text === "Wrong value?" && threads[0].comments[0].mine, "anchor and text decoded from the root comment");
  check(calls[0].auth === "Bearer t0k", "token sent");

  await api.create({ path: "b.kicad_pcb", commitId: "abc", anchor: { type: "point", x: 3, y: 4, side: "head" }, text: "Keep-out here" });
  const post = calls.at(-1);
  check(post.url.endsWith("/repos/o/r/pulls/7/comments") && post.body.subject_type === "file" && post.body.commit_id === "abc" && post.body.path === "b.kicad_pcb", "create posts a file-level review comment");
  check(decodeBody(post.body.body).anchor?.x === 3, "created comment carries the anchor");

  await api.reply(threads[0], " thanks ");
  check(calls.at(-1).url.endsWith("/pulls/7/comments/11/replies") && calls.at(-1).body.body === "thanks", "reply goes to the root comment");

  await api.setResolved(threads[0], true);
  check(calls.at(-1).body.query.includes("resolveReviewThread") && calls.at(-1).body.variables.id === "PRRT_1" && threads[0].isResolved === true, "resolve uses the GraphQL mutation");
  await api.setResolved(threads[0], false);
  check(calls.at(-1).body.query.includes("unresolveReviewThread") && threads[0].isResolved === false, "unresolve");

  const anon = new ReviewComments({ owner: "o", repo: "r", pr: 7, fetch: fetchMock });
  const rest = await anon.load();
  check(!anon.canWrite && rest.length === 2, "REST fallback groups replies into threads");
  const t21 = rest.find((t) => t.rootId === 21);
  check(t21.comments.length === 2 && t21.isResolved === null && t21.anchor?.type === "footprint", "REST thread: replies, unknown resolve state, anchor");
  check(rest.find((t) => t.rootId === 23).line === 40, "line comments keep their line");
}

// ---- issues (hardware change requests) against a mock ----
{
  const calls = [];
  const reply = (status, data) => ({ ok: status < 300, status, json: async () => data, headers: { get: () => null } });
  const pinned = encodeBody("LED too bright", { type: "footprint", ref: "R12", uuid: "u-12", x: 5, y: 6, side: "head", file: "hw/board.kicad_pcb", commit: "c0ffee" });
  const fetchMock = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method ?? "GET", body });
    if (url.endsWith("/graphql")) {
      return reply(200, {
        data: {
          viewer: { login: "me" },
          repository: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "I_1", number: 12, title: "R12 should be 10 k", body: pinned, state: "OPEN", createdAt: "2026-10-20T10:00:00Z", url: "i12", locked: false, viewerCanUpdate: true, viewerDidAuthor: true, author: { login: "me", avatarUrl: "a" },
                  comments: { nodes: [{ databaseId: 501, body: "Agreed", createdAt: "2026-10-20T11:00:00Z", url: "c501", viewerDidAuthor: true, author: { login: "me", avatarUrl: "a" } }] },
                },
                { id: "I_2", number: 13, title: "Closed one", body: "no marker", state: "CLOSED", createdAt: "2026-10-21T10:00:00Z", url: "i13", locked: true, viewerCanUpdate: false, viewerDidAuthor: false, author: null, comments: { nodes: [] } },
              ],
            },
          },
        },
      });
    }
    if (url.includes("/issues?labels=kivi")) {
      return reply(200, [
        { number: 12, title: "R12 should be 10 k", body: pinned, state: "open", comments: 1, user: { login: "me" }, created_at: "2026-10-20T10:00:00Z", html_url: "i12" },
        { number: 14, title: "a PR", body: "", state: "open", comments: 0, pull_request: {}, user: { login: "x" }, created_at: "2026-10-22T10:00:00Z", html_url: "p14" },
      ]);
    }
    if (url.includes("/issues/12/comments?")) return reply(200, [{ id: 501, body: "Agreed", user: { login: "me" }, created_at: "2026-10-20T11:00:00Z", html_url: "c501" }]);
    if (url.endsWith("/labels")) return reply(422, { message: "Validation Failed" }); // already there
    if (url.endsWith("/repos/o/r/issues") && init.method === "POST") return reply(201, { number: 15, html_url: "i15", labels: body.labels.map((name) => ({ name })) });
    if (url.endsWith("/issues/12") && init.method === "PATCH") return reply(200, { number: 12, state: body.state });
    if (init.method === "POST") return reply(201, { id: 600 });
    if (init.method === "DELETE") return { ok: true, status: 204, json: async () => null, headers: { get: () => null } };
    return reply(404, { message: "Not Found" });
  };

  const api = new IssueComments({ owner: "o", repo: "r", token: "t0k", fetch: fetchMock });
  const threads = await api.load();
  const t12 = threads.find((t) => t.rootId === 12), t13 = threads.find((t) => t.rootId === 13);
  check(threads.length === 2 && calls[0].body.variables.label === "kivi", "issues labelled kivi loaded through GraphQL");
  check(t12.number === 12 && t12.title === "R12 should be 10 k" && t12.path === "hw/board.kicad_pcb" && t12.commit === "c0ffee" && t12.anchor.ref === "R12", "issue → thread: number, title, file and commit from the marker");
  check(t12.comments.length === 2 && t12.comments[0].text === "LED too bright" && !t12.comments[0].mine && t12.comments[1].mine, "issue body is the first comment (never deletable), comments follow");
  check(t12.canResolve && !t12.canUnresolve && t12.canReply && t12.isResolved === false, "open issue: can close and comment");
  check(t13.isResolved === true && !t13.canUnresolve && !t13.canReply && t13.path === null && t13.anchor === null, "closed, locked, unpinned issue");

  const created = await api.create({ path: "hw/board.kicad_pcb", commitId: "beef", anchor: { type: "net", net: "GND", x: 1, y: 2, side: "head" }, text: "", title: " Widen GND " });
  const post = calls.find((c) => c.url.endsWith("/repos/o/r/issues") && c.method === "POST");
  const back = decodeBody(post.body.body);
  check(calls.some((c) => c.url.endsWith("/labels") && c.body.name === "kivi") && post.body.labels[0] === "kivi" && post.body.title === "Widen GND", "create makes sure of the label, then opens a labelled issue");
  check(back.anchor.file === "hw/board.kicad_pcb" && back.anchor.commit === "beef" && back.anchor.net === "GND" && created.id === 15 && created.labelled, "new issue carries file, commit and anchor");

  await api.reply(t12, " done ");
  check(calls.at(-1).url.endsWith("/issues/12/comments") && calls.at(-1).body.body === "done", "comment on an issue");
  await api.setResolved(t12, true);
  check(calls.at(-1).method === "PATCH" && calls.at(-1).body.state === "closed" && calls.at(-1).body.state_reason === "completed" && t12.isResolved, "resolve closes the issue as completed");
  await api.setResolved(t12, false);
  check(calls.at(-1).body.state === "open" && !t12.isResolved, "unresolve reopens it");
  await api.remove(501);
  check(calls.at(-1).url.endsWith("/issues/comments/501") && calls.at(-1).method === "DELETE", "delete an issue comment");

  const anon = new IssueComments({ owner: "o", repo: "r", fetch: fetchMock });
  const rest = await anon.load();
  check(rest.length === 1 && rest[0].rootId === 12 && rest[0].repliesPending && rest[0].comments.length === 1 && !rest[0].canReply, "signed out: REST issues without pull requests, comments pending");
  await anon.loadReplies(rest[0]);
  check(rest[0].comments.length === 2 && rest[0].comments[1].text === "Agreed" && !rest[0].repliesPending, "comments fetched when the issue is opened");
}

// ---- issues a pull request closes ----
{
  const n = closingNumbers("Swaps R12.\n\nFixes #12, closes #3 and Resolved: #40. See #7, prefix#8 and fixes#9");
  check([...n].sort((a, b) => a - b).join() === "3,12,40", `closing keywords in a description (got ${[...n]})`);
  const calls = [];
  let body = "Swaps R12 for 10 k.\n";
  const reply = (status, data) => ({ ok: status < 300, status, json: async () => data, headers: { get: () => null } });
  const fetchMock = async (url, init = {}) => {
    const b = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method ?? "GET", body: b });
    if (url.endsWith("/graphql")) return reply(200, { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 12, repository: { nameWithOwner: "O/R" } }, { number: 5, repository: { nameWithOwner: "other/repo" } }] } } } } });
    if (url.endsWith("/pulls/7") && init.method === "PATCH") return reply(200, { body: (body = b.body) });
    if (url.endsWith("/pulls/7")) return reply(200, { body });
    return reply(404, {});
  };
  const signedIn = new ReviewComments({ owner: "o", repo: "r", pr: 7, token: "t", fetch: fetchMock });
  check([...(await signedIn.closingIssues())].join() === "12", "signed in: GitHub's closing references, this repository's only");
  await signedIn.addClosingIssue(13);
  check(calls.at(-1).method === "PATCH" && body === "Swaps R12 for 10 k.\n\nFixes #13", `"Fixes #13" added to the description (got ${JSON.stringify(body)})`);
  const before = calls.length;
  await signedIn.addClosingIssue(13);
  check(calls.length === before + 1 && calls.at(-1).method === "GET", "already closing: the description is left alone");
  const anon = new ReviewComments({ owner: "o", repo: "r", pr: 7, fetch: fetchMock });
  check([...(await anon.closingIssues())].join() === "13", "signed out: read from the description's keywords");
}

// ---- board anchors ----
{
  const text = readText(`${DEMO}/pic_programmer.kicad_pcb`);
  const pcb = parsePcb(text), r = renderPcb(pcb, {});
  const visible = new Set(pcb.layers.map((l) => l.name));
  const fp = pcb.footprints.find((f) => f.pads.length >= 2 && f.reference.startsWith("R"));
  const pad = fp.pads[0];
  const onPad = pickPcb(pcb, r, { x: pad.x, y: pad.y }, { visible, side: fp.side });
  check(onPad.anchor.type === "pad" && onPad.anchor.ref === fp.reference && onPad.anchor.pad === pad.number, `click on a pad → pad anchor (${anchorLabel(onPad.anchor)})`);
  const track = pcb.tracks.find((t) => t.net && t.type === "segment" && Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y) > 3);
  const mid = { x: (track.start.x + track.end.x) / 2, y: (track.start.y + track.end.y) / 2 };
  const onTrack = pickPcb(pcb, r, mid, { visible, side: track.layer.startsWith("B.") ? "back" : "front" });
  check(onTrack.anchor.type === "net" && onTrack.anchor.net === track.net && onTrack.mark.tracks.length > 0, `click on a track → net anchor (${track.net})`);
  const empty = pickPcb(pcb, r, { x: -500, y: -500 }, { visible });
  check(empty.anchor.type === "point", "click on nothing → point anchor");

  // Same anchors in an edited board: footprint moved, track nudged.
  const b = parsePcb(text);
  const fb = b.footprints.find((f) => f.uuid === fp.uuid && f.reference === fp.reference);
  const dx = 5;
  fb.x += dx;
  for (const p of fb.pads) p.x += dx;
  const shift = (o) => {
    if (!o || typeof o !== "object") return;
    if (typeof o.x === "number" && typeof o.y === "number") o.x += dx;
    for (const v of Object.values(o)) if (v && typeof v === "object") shift(v);
  };
  for (const g of fb.graphics) shift(g);
  const rb = renderPcb(b, {});
  const lp = locatePcb(b, rb, onPad.anchor);
  check(lp.found && Math.abs(lp.x - (pad.x + dx)) < 1e-6, "pad anchor follows the moved footprint");
  const fpAnchor = { type: "footprint", ref: fp.reference, uuid: fp.uuid, x: fp.x, y: fp.y };
  const lf = locatePcb(b, rb, fpAnchor);
  check(lf.found && lf.mark.box.contains(fp.x + dx, fp.y), "footprint anchor lands on the moved footprint");
  const lt = locatePcb(b, rb, onTrack.anchor);
  check(lt.found && Math.hypot(lt.x - mid.x, lt.y - mid.y) < 0.01, "net anchor lands on its track");
  b.footprints = b.footprints.filter((f) => f !== fb);
  const gone = locatePcb(b, renderPcb(b, {}), fpAnchor);
  check(!gone.found && gone.x === fp.x, "removed footprint → not found, falls back to the point");
}

// ---- schematic anchors ----
{
  const text = readText(`${DEMO}/pic_programmer.kicad_sch`);
  const sch = parseSchematic(text, "pic_programmer.kicad_sch");
  const r = renderSchematic(sch, {});
  const conn = buildConnectivity(sch, r.items);
  const sym = r.items.find((i) => i.kind === "symbol" && !i.power);
  const c = { x: (sym.bbox.x0 + sym.bbox.x1) / 2, y: (sym.bbox.y0 + sym.bbox.y1) / 2 };
  const onSym = pickSch(sch, r, conn, c, 0.4);
  check(onSym.anchor.type === "symbol" || onSym.anchor.type === "net", `click in a symbol → ${onSym.anchor.type} ${anchorLabel(onSym.anchor)}`);
  const group = conn.groups.find((g) => g.segments.length && g.pins.some((p) => !p.power));
  const s = group.segments[0];
  const onWire = pickSch(sch, r, conn, { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 }, 0.4);
  check(onWire.anchor.type === "net" && (onWire.anchor.net || onWire.anchor.pin), `click on a wire → net anchor (${anchorLabel(onWire.anchor)})`);
  const back = locateSch(sch, r, conn, onWire.anchor);
  check(back.found && back.mark.paths.length === group.segments.length, "net anchor found again with all its wires");
  const symAnchor = { type: "symbol", ref: sym.reference, uuid: sym.uuid, x: c.x, y: c.y };
  check(locateSch(sch, r, conn, symAnchor).found, "symbol anchor found by UUID");
}

// ---- GitHub's 422 details reach the message ----
{
  const errors = [
    { resource: "PullRequestReviewComment", code: "custom", field: "pull_request_review_thread.path", message: "pull_request_review_thread.path is missing" },
    { resource: "PullRequestReviewComment", field: "commit_id", code: "invalid" },
    { resource: "PullRequestReviewComment", code: "custom", field: "path", message: "could not be resolved" },
    "plain text reason",
  ];
  const fetch422 = async () => ({ ok: false, status: 422, json: async () => ({ message: "Validation Failed", errors }), headers: { get: () => null } });
  const api = new ReviewComments({ owner: "o", repo: "r", pr: 1, token: "t0k", fetch: fetch422 });
  const msg = await api.create({ path: "hw/board.kicad_pcb", commitId: "beef", anchor: { type: "point", x: 1, y: 2, side: "head" }, text: "x" }).then(() => "", (e) => e.message);
  check(msg === "GitHub 422: Validation Failed: pull_request_review_thread.path is missing; PullRequestReviewComment commit_id invalid; path could not be resolved; plain text reason", `422 lists every reason GitHub gave (${msg})`);
}

// ---- the forge interface ----
{
  // Every member of the Forge typedef in src/forge/index.js, so an adapter can be checked against it.
  const MEMBERS = ["id", "name", "host", "hashKey", "parseSpec", "ownsUrl", "open", "source", "repo", "listRepos", "tree", "branches", "commits", "compare", "pullRequest", "pullFiles", "searchPullRequests", "searchIssues", "reviews", "issues", "user", "gitAuthor", "avatar", "web", "auth"];
  for (const f of FORGES) {
    const missing = MEMBERS.filter((m) => f[m] === undefined);
    check(!missing.length, `${f.id} implements the forge interface${missing.length ? ` (missing ${missing.join(", ")})` : ""}`);
    check(["repo", "tree", "compare"].every((k) => typeof f.web[k] === "function") && typeof f.web.newRepo === "string", `${f.id} has its web pages`);
  }
  // Sign-in goes through lib.rs oauth_post, which only sends to the addresses it lists.
  const libRs = readText(GLib.build_filenamev([GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), "..", "src-tauri", "src", "lib.rs"]));
  for (const f of FORGES) {
    const missing = ["deviceUrl", "tokenUrl", "clientIdKey", "buildEnv", "registerUrl", "unknownClient", "refreshRejected"].filter((k) => f.auth[k] === undefined);
    check(!missing.length, `${f.id} describes its sign-in${missing.length ? ` (missing ${missing.join(", ")})` : ""}`);
    check([f.auth.deviceUrl, f.auth.tokenUrl].every((u) => libRs.includes(`"${u}"`)), `${f.id}'s sign-in addresses are in lib.rs OAUTH_URLS`);
    check(libRs.includes(`"${f.auth.buildEnv}"`) && libRs.includes(`"${f.id}": {`), `${f.id}'s client ID can be built in (forge_build_config)`);
  }
  // Forge logos aren't shipped (GitLab's artwork isn't GPL-compatible): loaded at run time, so the CSP must allow them.
  const csp = JSON.parse(readText(GLib.build_filenamev([GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), "..", "src-tauri", "tauri.conf.json"]))).app.security.csp["img-src"];
  for (const f of FORGES) check(/^https:\/\//.test(f.web.logo) && csp.split(" ").includes(/^https:\/\/[^/]+/.exec(f.web.logo)[0]), `${f.id}'s logo is fetched from a host the CSP allows (${f.web.logo})`);
  check(forge() === github && forge("github") === github, "GitHub is the default forge");
  // Dialogs with no forge choice: the address decides; a shorthand goes to the forge signed in to.
  const gl = forge("gitlab");
  const at = (text, pref) => { const r = parseRepoInput(text, pref); return r ? `${r.forge.id} ${r.spec.owner}/${r.spec.repo}` : null; };
  check(at("me/board") === "github me/board" && at("me/board", gl) === "gitlab me/board", "owner/repo: the forge signed in to (GitHub signed out)");
  check(at("hw/boards/cm5") === "gitlab hw/boards/cm5", "group/sub/project can only be GitLab");
  check(at("https://gitlab.com/hw/cm5", github) === "gitlab hw/cm5" && at("github.com/me/board", gl) === "github me/board", "an address decides, with or without https://");
  check(at("https://example.com/me/board") === null && at("nonsense") === null, "anything else isn't a repository");
  check(parseRepoSpec("me/models@main:3d")?.forge === github && parseRepoSpec("me/models@main:3d").spec.path === "3d", "a shorthand goes to the default forge");
  check(parseRepoSpec("https://github.com/me/models/tree/main/3d")?.spec.rest === "main/3d", "a github.com address goes to GitHub");
  check(parseRepoSpec("https://example.com/me/models") === null, "an address no forge owns isn't a repository");
  check(github.source({ owner: "o", repo: "r", ref: "main" }).forge === github, "sources know their forge");
  check(github.web.tree("o/r", "feat/x", "hw/board") === "https://github.com/o/r/tree/feat/x/hw/board" && github.web.tree("o/r") === "https://github.com/o/r", "folder pages");

  // Searches: GitHub's query syntax and its 256-character limit stay in the adapter.
  const queries = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    queries.push(decodeURIComponent(/[?&]q=([^&]*)/.exec(url)[1]));
    const item = { repository_url: "https://api.github.com/repos/O/R", number: queries.length, title: "t", user: { login: "u", avatar_url: "a?v=4" }, updated_at: "2026-11-01T00:00:00Z", html_url: `h${queries.length}` };
    return { ok: true, status: 200, json: async () => ({ items: [item] }) };
  };
  const repos = Array.from({ length: 30 }, (_, i) => `owner${i}/repository-${i}`);
  const found = await github.searchIssues({ label: "kivi", repos }, null);
  const mine = await github.searchPullRequests({ reviewRequested: true }, "t");
  globalThis.fetch = realFetch;
  check(queries.length > 2 && queries.slice(0, -1).every((q) => q.length <= 256 && q.startsWith("is:issue is:open archived:false label:kivi repo:")), `issue searches split under GitHub's limit (${queries.length - 1} queries)`);
  check(repos.every((r) => queries.some((q) => q.includes(` repo:${r}`))), "every repository is searched");
  check(queries.at(-1) === "is:pr is:open archived:false review-requested:@me", "review requests query");
  check(found[0].nwo === "O/R" && found[0].author === "u" && found[0].url === "h1" && mine[0].updatedAt === "2026-11-01T00:00:00Z", "search hits become SearchItems");
  check(github.avatar("a?v=4", 48) === "a?v=4&s=48" && github.avatar("a", 48) === "a?s=48", "avatar sizes");
}

print(failures ? `\n${failures} failure(s)` : "\nall review checks passed");
if (failures) imports.system.exit(1);
