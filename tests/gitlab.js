// The GitLab adapter (src/forge/gitlab.js) against a mocked gitlab.com:
// requests (paths, bodies, pagination through Link headers) and the
// forge-neutral shapes it returns. gjs -m tests/gitlab.js
import { gitlab, GitLabReviews, GitLabIssues } from "../src/forge/gitlab.js";
import { parseRepoKey, parseRepoSpec, remoteOf, repoKey } from "../src/forge/index.js";
import { encodeBody } from "../src/review.js";
import { kicadFilesChanged } from "../src/desktop/pr-files.js";

let failures = 0;
const check = (cond, msg) => {
  print(`${cond ? "  ok  " : "  FAIL"} ${msg}`);
  if (!cond) failures++;
};

const API = "https://gitlab.com/api/v4";
const P = `${API}/projects/hw%2Fboards%2Fcm5`; // a project in a subgroup
const HEAD = "a".repeat(40), BASE = "b".repeat(40), START = "c".repeat(40);
const reply = (status, data, link = null) => ({ ok: status < 300, status, json: async () => data, headers: { get: (h) => (h.toLowerCase() === "link" ? link : null) } });

/** A fake gitlab.com: `routes` maps "METHOD url-prefix" to a reply function; every call is kept. */
function mock(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url, body, auth: init.headers?.Authorization ?? null });
    if (globalThis.__trace) print("    →", method, url);
    const key = Object.keys(routes).filter((k) => `${method} ${url}`.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    if (!key) return reply(404, { message: "404 Not found" });
    return routes[key]({ url, body });
  };
  return { fetch, calls };
}

/** Run with a global fetch (the adapter's own requests, and GitLabSource's). */
async function withFetch(fetch, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

// ---- specs and keys ----
{
  const s = gitlab.parseSpec("https://gitlab.com/hw/boards/cm5/-/tree/feat/x/board/main.kicad_pcb");
  check(s?.owner === "hw/boards" && s.repo === "cm5" && s.rest === "feat/x/board/main.kicad_pcb", "a gitlab.com tree address, with subgroups");
  const t = gitlab.parseSpec("hw/boards/cm5@main:board");
  check(t?.owner === "hw/boards" && t.repo === "cm5" && t.ref === "main" && t.path === "board", "a shorthand with subgroups, ref and folder");
  check(gitlab.parseSpec("https://gitlab.com/hw/cm5.git")?.repo === "cm5", "a clone address");
  check(parseRepoSpec("https://gitlab.com/hw/cm5")?.forge === gitlab && parseRepoSpec("hw/cm5")?.forge.id === "github", "addresses go to GitLab, shorthands to the default forge");
  check(repoKey(gitlab, "hw/boards/cm5") === "gitlab:hw/boards/cm5", "GitLab repositories are keyed with their forge");
  const k = parseRepoKey("gitlab:hw/boards/cm5");
  check(k.forge === gitlab && k.owner === "hw/boards" && k.repo === "cm5", "a key splits into forge, owner (namespace) and name");
  const r = remoteOf({ host: "gitlab.com", owner: "hw/boards", repo: "cm5" });
  check(r?.forge === gitlab && r.key === "gitlab:hw/boards/cm5", "a local copy's GitLab remote");
  check(gitlab.web.tree("hw/cm5", "feat/x", "board") === "https://gitlab.com/hw/cm5/-/tree/feat/x/board", "folder pages");
  check(gitlab.words.prRef(5) === "!5" && gitlab.words.closes(9) === "Closes #9", "GitLab's words");
  check(gitlab.avatar("https://gitlab.com/uploads/a.png", 48) === "https://gitlab.com/uploads/a.png?width=48" && gitlab.avatar("https://secure.gravatar.com/avatar/x?s=80&d=identicon", 48) === "https://secure.gravatar.com/avatar/x?s=48&d=identicon", "avatar sizes");
}

// ---- files: listing through Link pages, reading through the API ----
{
  const page2 = `${P}/repository/tree?ref=main&page_token=abc&per_page=100`;
  const m = mock({
    [`GET ${P}/repository/tree?ref=main&recursive=true&pagination=keyset`]: () =>
      reply(200, [{ path: "board", type: "tree" }, { path: "board/cm5.kicad_pro", type: "blob", id: "1" }, { path: "README.md", type: "blob", id: "2" }], `<${page2}>; rel="next"`),
    [`GET ${page2}`]: () => reply(200, [{ path: "board/cm5.kicad_pcb", type: "blob", id: "3" }, { path: "3d/x.step", type: "blob", id: "4" }]),
    [`GET ${P}/repository/files/board%2Fcm5.kicad_pro/raw?ref=main&lfs=true`]: () => ({ ok: true, status: 200, text: async () => "{}" }),
  });
  await withFetch(m.fetch, async () => {
    const src = gitlab.source({ owner: "hw/boards", repo: "cm5", ref: "main" });
    const list = await src.list();
    check(list.join() === "board/cm5.kicad_pro,board/cm5.kicad_pcb,3d/x.step", `lists every page, KiCad files and models only (${list.join()})`);
    check((await src.readText("board/cm5.kicad_pro")) === "{}", "reads a file through the API (raw, LFS resolved)");
    check(src.url("x.wrl").startsWith(`${P}/repository/files/x.wrl/raw?`), "public files have a fetchable URL");
    const t = await gitlab.tree("hw/boards/cm5", "main");
    check(t.files.length === 4 && t.files[0].sha === "1" && t.files[0].size === null && !t.truncated, "tree() for the gallery: blob ids, sizes unknown");
  });
}

// ---- a merge request: files, comparison, the inbox badge ----
const mrJson = { iid: 5, title: "USB-C", description: "Adds USB-C\n\nCloses #3", web_url: "https://gitlab.com/hw/boards/cm5/-/merge_requests/5", source_branch: "usbc", target_branch: "main", source_project_id: 1, target_project_id: 1, diff_refs: { base_sha: BASE, head_sha: HEAD, start_sha: START } };
const diffs = [
  { old_path: "board/cm5.kicad_pcb", new_path: "board/cm5.kicad_pcb", diff: "@@ -1 +1 @@\n-a\n+b\n" },
  { old_path: "board/old.kicad_sch", new_path: "board/new.kicad_sch", renamed_file: true, diff: "" },
  { old_path: "board/u.kicad_sch", new_path: "board/u.kicad_sch", new_file: true, diff: "" },
  { old_path: "README.md", new_path: "README.md", diff: "@@ -1 +1 @@\n-x\n+y\n" },
];
{
  const m = mock({
    [`GET ${P}/merge_requests/5/diffs?`]: () => reply(200, diffs),
    [`GET ${P}/merge_requests/5`]: () => reply(200, mrJson),
  });
  await withFetch(m.fetch, async () => {
    const pr = await gitlab.pullRequest("hw/boards", "cm5", 5);
    check(pr.head.sha === HEAD && pr.base.sha === BASE && pr.head.label === "usbc" && pr.base.ref === "main", "a merge request: head, merge base, branches");
    const files = await gitlab.pullFiles("hw/boards", "cm5", 5);
    check(files[1].status === "renamed" && files[1].previous === "board/old.kicad_sch" && files[2].status === "added" && files[0].ref === HEAD && files[0].patch.startsWith("@@"), "its diffs become ChangedFiles, read at the head");
    const counted = await kicadFilesChanged(files, async () => "");
    check(counted.length === 3, `the inbox badge counts its KiCad files (${counted.length})`);
    const cmp = await gitlab.compare({ owner: "hw/boards", repo: "cm5", pr: 5 });
    check(cmp.title === "!5 USB-C" && cmp.files.length === 3 && cmp.base.sha === BASE && cmp.head.sha === HEAD, "compare() of a merge request");
  });
}

// ---- comparing branches: merge base, or a commit as it is ----
{
  const m = mock({
    [`GET ${P}/repository/compare?from=main&to=feat&straight=false`]: () => reply(200, { commit: { id: HEAD }, diffs: [diffs[0]], web_url: "w" }),
    [`GET ${P}/repository/merge_base?`]: () => reply(200, { id: BASE }),
    [`GET ${P}/repository/compare?from=${START}&to=feat&straight=true`]: () => reply(200, { commit: { id: HEAD }, diffs: [diffs[0], diffs[2]] }),
  });
  await withFetch(m.fetch, async () => {
    const a = await gitlab.compare({ owner: "hw/boards", repo: "cm5", base: "main", head: "feat" });
    check(a.base.sha === BASE && a.head.sha === HEAD && a.files.length === 1 && a.title === "main → feat", "two branches: from their merge base");
    const b = await gitlab.compare({ owner: "hw/boards", repo: "cm5", base: START, head: "feat" });
    check(b.base.sha === START && b.files.length === 2, "a commit as the base: compared as it is (straight)");
  });
}

// ---- review threads (discussions) ----
{
  const anchored = encodeBody("Is this footprint right?", { type: "footprint", ref: "U3", x: 1, y: 2, side: "head" });
  const author = (id, username) => ({ id, username, avatar_url: "a" });
  const m = mock({
    [`GET ${API}/user`]: () => reply(200, { id: 7, username: "me", name: "Me", avatar_url: "a", web_url: "u" }),
    [`GET ${P}/merge_requests/5/discussions?`]: () =>
      reply(200, [
        { id: "d1", notes: [{ id: 11, body: anchored, author: author(7, "me"), created_at: "2026-11-01T10:00:00Z", resolvable: true, resolved: false, position: { position_type: "file", new_path: "board/cm5.kicad_pcb", head_sha: HEAD } }, { id: 12, body: "Yes", author: author(8, "you"), created_at: "2026-11-01T11:00:00Z" }] },
        { id: "d2", notes: [{ id: 13, body: "Looks good", author: author(8, "you"), created_at: "2026-11-01T12:00:00Z" }] }, // general: no position
        { id: "d3", notes: [{ id: 14, body: "added 1 commit", system: true, author: author(8, "you"), created_at: "2026-11-01T12:00:00Z" }] },
      ]),
    [`GET ${P}/merge_requests/5/diffs?`]: () => reply(200, diffs),
    [`GET ${P}/merge_requests/5/closes_issues`]: () => reply(200, [{ iid: 3, project_id: 1 }, { iid: 4, project_id: 2 }]),
    [`GET ${P}/merge_requests/5`]: () => reply(200, mrJson),
    [`GET ${P}`]: () => reply(200, { id: 1 }),
    [`POST ${P}/merge_requests/5/discussions`]: ({ body }) => reply(201, { id: "d9", notes: [{ id: 99, body: body.body }] }),
    [`POST ${P}/merge_requests/5/discussions/d1/notes`]: () => reply(201, { id: 15 }),
    [`PUT ${P}/merge_requests/5/discussions/d1?resolved=true`]: () => reply(200, { id: "d1", notes: [{ id: 11, resolvable: true, resolved: true }] }),
    [`DELETE ${P}/merge_requests/5/notes/12`]: () => reply(204, null),
    [`PUT ${P}/merge_requests/5`]: () => reply(200, {}),
  });
  const api = new GitLabReviews({ owner: "hw/boards", repo: "cm5", pr: 5, token: "t0k", fetch: m.fetch });
  const threads = await api.load();
  check(threads.length === 1 && threads[0].path === "board/cm5.kicad_pcb" && threads[0].anchor?.ref === "U3", "file discussions become threads, with their KiVi pin (general and system notes left out)");
  check(threads[0].comments.length === 2 && threads[0].comments[0].mine && !threads[0].comments[1].mine && threads[0].comments[0].url.endsWith("#note_11"), "notes: who wrote them, links");
  check(threads[0].isResolved === false && threads[0].canResolve && threads[0].rootId === 11, "resolvable, signed in");
  check(m.calls.every((c) => c.auth === "Bearer t0k"), "every request carries the token");
  const created = await api.create({ path: "board/cm5.kicad_pcb", commitId: HEAD, anchor: { type: "point", x: 1, y: 2, side: "head" }, text: "Hm" });
  const post = m.calls.find((c) => c.method === "POST" && c.url.endsWith("/discussions"));
  check(created.id === 99 && post.body.position.position_type === "file" && post.body.position.head_sha === HEAD && post.body.position.base_sha === BASE && post.body.position.start_sha === START && post.body.position.new_path === "board/cm5.kicad_pcb", "a new pin is a file discussion at the merge request's current commits");
  await api.reply(threads[0], " ok ");
  check(m.calls.at(-1).body.body === "ok", "replying adds a note to the discussion");
  await api.setResolved(threads[0], true);
  check(threads[0].isResolved === true, "resolving");
  await api.remove(12);
  check(m.calls.at(-1).method === "DELETE", "deleting a note");
  check([...(await api.changedFiles())].includes("board/new.kicad_sch"), "files the merge request changes");
  check([...(await api.closingIssues())].join() === "3", "issues it closes (this project's only)");
  await api.addClosingIssue(9);
  check(m.calls.at(-1).body.description === "Adds USB-C\n\nCloses #3\n\nCloses #9", "Close with this MR adds “Closes #9”");
  const before = m.calls.length;
  await api.addClosingIssue(3);
  check(m.calls.length === before + 1, "an issue it already closes isn't added again");

  const anon = new GitLabReviews({ owner: "hw/boards", repo: "cm5", pr: 5, fetch: m.fetch });
  check((await anon.load()).length === 0 && anon.readsNeedSignIn && !anon.canWrite, "signed out: no request (GitLab answers 401), the panel asks for a sign-in");
}

// ---- issues ----
{
  const pinned = encodeBody("R12 should be 10 k", { type: "footprint", ref: "R12", x: 3, y: 4, side: "head", file: "board/cm5.kicad_pcb", commit: HEAD });
  const m = mock({
    [`GET ${API}/user`]: () => reply(200, { id: 7, username: "me" }),
    [`GET ${P}/issues?labels=kivi`]: () => reply(200, [{ id: 100, iid: 12, title: "R12", description: pinned, state: "opened", user_notes_count: 2, author: { username: "me" }, created_at: "2026-11-01T10:00:00Z", web_url: "https://gitlab.com/hw/boards/cm5/-/issues/12" }]),
    [`GET ${P}/issues/12/notes?`]: () => reply(200, [{ id: 501, body: "Agreed", author: { id: 7, username: "me" }, created_at: "2026-11-01T11:00:00Z" }, { id: 502, body: "changed the label", system: true, author: { id: 7 } }]),
    [`POST ${P}/labels`]: () => reply(409, { message: "Label already exists" }),
    [`POST ${P}/issues/12/notes`]: () => reply(201, { id: 503 }),
    [`POST ${P}/issues`]: ({ body }) => reply(201, { iid: 13, labels: body.labels.split(","), web_url: "i13" }),
    [`PUT ${P}/issues/12`]: ({ body }) => reply(200, { state: body.state_event === "close" ? "closed" : "opened" }),
    [`DELETE ${P}/issues/12/notes/501`]: () => reply(204, null),
  });
  const api = new GitLabIssues({ owner: "hw/boards", repo: "cm5", token: "t0k", fetch: m.fetch });
  const [t] = await api.load();
  check(t.key === "i12" && t.number === 12 && t.path === "board/cm5.kicad_pcb" && t.commit === HEAD && t.anchor?.ref === "R12" && t.repliesPending, "issues become threads: number, pinned file and commit; comments when opened");
  await api.loadReplies(t);
  check(t.comments.length === 2 && t.comments[1].text === "Agreed" && t.comments[1].mine, "its notes, less GitLab's own");
  const created = await api.create({ path: "board/cm5.kicad_pcb", commitId: HEAD, anchor: { type: "point", x: 1, y: 2 }, text: "Swap it", title: " Swap U3 " });
  const post = m.calls.find((c) => c.method === "POST" && c.url === `${P}/issues`);
  check(created.id === 13 && created.labelled && post.body.labels === "kivi" && post.body.title === "Swap U3" && post.body.description.includes('"file":"board/cm5.kicad_pcb"'), "a change request: a labelled issue pinned to its file and commit (label made first)");
  await api.setResolved(t, true);
  check(t.isResolved === true && m.calls.at(-1).body.state_event === "close", "closing an issue");
  await api.remove(501);
  check(m.calls.at(-1).url.endsWith("/issues/12/notes/501"), "deleting a comment knows its issue");

  const anon = new GitLabIssues({ owner: "hw/boards", repo: "cm5", fetch: m.fetch });
  const [a] = await anon.load();
  check(!a.repliesPending && /signed in/.test(a.repliesError) && !a.canReply, "signed out: issues listed, their comments need a sign-in");
}

// ---- errors ----
{
  const m = mock({ [`GET ${API}/projects/x%2Fy`]: () => ({ ...reply(429, {}), headers: { get: (h) => (h.toLowerCase() === "retry-after" ? "240" : null) } }) });
  const msg = await withFetch(m.fetch, () => gitlab.repo("x/y").then(() => "", (e) => e.message));
  check(/rate limit reached \(again in 4 min\)/.test(msg), `rate limit says when (${msg})`);
}

print(failures ? `\n${failures} failure(s)` : "\nall GitLab checks passed");
if (failures) imports.system.exit(1);
