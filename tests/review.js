// Review comment tests (gjs): anchor encoding, the GitHub API layer against a
// mocked API, and anchor picking/relocation on demo files.   gjs -m tests/review.js

import { readText, kicadDemos } from "./gjs-fs.js";
import { encodeBody, decodeBody, anchorLabel, renderCommentText, ReviewComments } from "../src/review.js";
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

print(failures ? `\n${failures} failure(s)` : "\nall review checks passed");
if (failures) imports.system.exit(1);
